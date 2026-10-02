import { ArrowUpRight, BookOpen, Grid2X2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_VALUE_LENGTH,
  applyStateAction,
  cells,
  createEmptyPlacements,
  createEmptyValues,
  getMember,
  members,
  sanitizePlacements,
  sanitizeValues,
  type BingoAction,
  type CellId,
  type MemberId,
  type Placements,
  type Values
} from "../shared/domain";
import { PostArchive } from "./components/PostArchive";
import { RecentPosts, RecordBoard } from "./components/RecordBoard";
import { instagramSnapshot } from "./data/instagram-posts";
import { countPostsByCell, filterPosts, formatPostDate, type MemberFilter, type TopicFilter } from "./lib/instagram-posts";

type SyncState = "loading" | "ready" | "saving" | "offline";

type RemoteState = {
  placements: Placements;
  values: Values;
  version: number;
  updatedAt: string;
};

type DragState = {
  memberId: MemberId;
  fromCellId: CellId | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
};

const dragThreshold = 8;
const postCounts = countPostsByCell(instagramSnapshot.posts);
const latestRecordByCell = Object.fromEntries(
  cells.map((cell) => {
    const latestPost = filterPosts(instagramSnapshot.posts, cell.id, "all")[0];
    return [cell.id, latestPost?.records.find((record) => record.cellId === cell.id) ?? null];
  })
) as Record<CellId, (typeof instagramSnapshot.posts)[number]["records"][number] | null>;
const completedCellCount = Object.values(postCounts).filter((count) => count > 0).length;
const bingoLines = [
  [0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14], [15, 16, 17, 18, 19], [20, 21, 22, 23, 24],
  [0, 5, 10, 15, 20], [1, 6, 11, 16, 21], [2, 7, 12, 17, 22], [3, 8, 13, 18, 23], [4, 9, 14, 19, 24],
  [0, 6, 12, 18, 24], [4, 8, 12, 16, 20]
] as const;

export default function App() {
  const [archiveSelection, setArchiveSelection] = useState<{ topic: TopicFilter; member: MemberFilter } | null>(null);
  const [editing, setEditing] = useState(false);
  const openArchive = useCallback((topic: TopicFilter, member: MemberFilter = "all") => {
    setArchiveSelection({ topic, member });
  }, []);
  const [placements, setPlacements] = useState<Placements>(() => createEmptyPlacements());
  const [values, setValues] = useState<Values>(() => createEmptyValues());
  const [selectedMemberId, setSelectedMemberId] = useState<MemberId | "clear">("ryo");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const isSavingRef = useRef(false);
  const draggingRef = useRef<DragState | null>(null);
  const savedValuesRef = useRef<Values>(createEmptyValues());
  const valueSaveTimersRef = useRef<Partial<Record<CellId, number>>>({});

  const selectedMember = selectedMemberId === "clear" ? null : getMember(selectedMemberId);

  const applyRemoteState = useCallback((state: RemoteState) => {
    setPlacements(sanitizePlacements(state.placements));
    const nextValues = sanitizeValues(state.values);
    setValues(nextValues);
    savedValuesRef.current = nextValues;
    setVersion(state.version);
    setUpdatedAt(state.updatedAt);
    setSyncState("ready");
  }, []);

  const loadState = useCallback(async () => {
    try {
      const response = await fetch("/api/state", {
        headers: { accept: "application/json" },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`GET /api/state failed: ${response.status}`);
      }

      applyRemoteState((await response.json()) as RemoteState);
    } catch {
      setSyncState((current) => (current === "loading" ? "offline" : current));
    }
  }, [applyRemoteState]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      if (!isSavingRef.current && !draggingRef.current) {
        void loadState();
      }
    }, 7000);

    return () => window.clearInterval(intervalId);
  }, [loadState]);

  useEffect(() => {
    return () => {
      for (const timerId of Object.values(valueSaveTimersRef.current)) {
        window.clearTimeout(timerId);
      }
    };
  }, []);

  const commitAction = useCallback(
    async (action: BingoAction) => {
      setPlacements((currentPlacements) =>
        applyStateAction({ placements: currentPlacements, values }, action).placements
      );
      setValues((currentValues) => applyStateAction({ placements, values: currentValues }, action).values);
      setSyncState("saving");
      isSavingRef.current = true;

      try {
        const response = await fetch("/api/state", {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            accept: "application/json"
          },
          body: JSON.stringify(action)
        });

        if (!response.ok) {
          throw new Error(`PATCH /api/state failed: ${response.status}`);
        }

        applyRemoteState((await response.json()) as RemoteState);
      } catch {
        setSyncState("offline");
        void loadState();
      } finally {
        isSavingRef.current = false;
      }
    },
    [applyRemoteState, loadState, placements, values]
  );

  const handleCellTap = useCallback(
    (cellId: CellId) => {
      if (draggingRef.current?.active) {
        return;
      }

      const memberId = selectedMemberId === "clear" ? null : selectedMemberId;
      const nextMemberId = placements[cellId] === memberId ? null : memberId;
      void commitAction({ type: "set", cellId, memberId: nextMemberId });
    },
    [commitAction, placements, selectedMemberId]
  );

  const commitCellValue = useCallback(
    (cellId: CellId, nextValue = values[cellId] ?? "") => {
      const value = nextValue.slice(0, MAX_VALUE_LENGTH);
      const timerId = valueSaveTimersRef.current[cellId];

      if (timerId) {
        window.clearTimeout(timerId);
        delete valueSaveTimersRef.current[cellId];
      }

      if (value === savedValuesRef.current[cellId]) {
        return;
      }

      void commitAction({ type: "setValue", cellId, value });
    },
    [commitAction, values]
  );

  const handleValueInput = useCallback(
    (cellId: CellId, value: string) => {
      const nextValue = value.slice(0, MAX_VALUE_LENGTH);
      const timerId = valueSaveTimersRef.current[cellId];

      if (timerId) {
        window.clearTimeout(timerId);
      }

      setValues((currentValues) => ({ ...currentValues, [cellId]: nextValue }));
      valueSaveTimersRef.current[cellId] = window.setTimeout(() => commitCellValue(cellId, nextValue), 700);
    },
    [commitCellValue]
  );

  const startDrag = useCallback(
    (event: React.PointerEvent<HTMLElement>, memberId: MemberId, fromCellId: CellId | null = null) => {
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }

      const nextDragging: DragState = {
        memberId,
        fromCellId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        active: false
      };

      draggingRef.current = nextDragging;
      setDragging(nextDragging);
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    []
  );

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const currentDragging = draggingRef.current;

      if (!currentDragging) {
        return;
      }

      const distance = Math.hypot(event.clientX - currentDragging.startX, event.clientY - currentDragging.startY);
      const nextDragging = {
        ...currentDragging,
        x: event.clientX,
        y: event.clientY,
        active: currentDragging.active || distance > dragThreshold
      };

      draggingRef.current = nextDragging;
      setDragging(nextDragging);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const currentDragging = draggingRef.current;
      draggingRef.current = null;
      setDragging(null);

      if (!currentDragging?.active) {
        return;
      }

      const target = document.elementFromPoint(event.clientX, event.clientY);
      const cellElement = target?.closest<HTMLElement>("[data-cell-id]");
      const toCellId = cellElement?.dataset.cellId;

      if (!toCellId) {
        return;
      }

      const action =
        currentDragging.fromCellId && currentDragging.fromCellId !== toCellId
          ? {
              type: "move" as const,
              fromCellId: currentDragging.fromCellId,
              toCellId: toCellId as CellId,
              memberId: currentDragging.memberId
            }
          : {
              type: "set" as const,
              cellId: toCellId as CellId,
              memberId: currentDragging.memberId
            };

      void commitAction(action);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerUp, { passive: true });
    window.addEventListener("pointercancel", handlePointerUp, { passive: true });

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [commitAction, dragging]);

  const filledCount = useMemo(
    () => Object.values(placements).filter((memberId) => memberId !== null).length,
    [placements]
  );

  const memberCounts = useMemo(() => {
    const counts = Object.fromEntries(members.map((member) => [member.id, 0])) as Record<MemberId, number>;

    for (const memberId of Object.values(placements)) {
      if (memberId) {
        counts[memberId] += 1;
      }
    }

    return counts;
  }, [placements]);

  const completedLineCount = bingoLines.filter((line) => line.every((index) => postCounts[cells[index].id] > 0)).length;

  const statusLabel = useMemo(() => {
    if (syncState === "loading") {
      return "読み込み中";
    }

    if (syncState === "saving") {
      return "保存中";
    }

    if (syncState === "offline") {
      return "共有に未接続";
    }

    return updatedAt ? `同期済み ${formatUpdatedAt(updatedAt)}` : "同期済み";
  }, [syncState, updatedAt]);

  return (
    <main className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>
          <div><span className="brand-name">おもしろ探索ビンゴ</span><span className="brand-subtitle">YEAR BINGO <span>2026</span></span></div>
        </div>
        <a className="header-link" href={instagramSnapshot.profileUrl} target="_blank" rel="noopener noreferrer" aria-label="Instagramのプロフィールを開く">
          <span>Instagram</span><ArrowUpRight size={17} aria-hidden="true" />
        </a>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="hero-copy">
          <p className="eyebrow"><span className="live-dot" />5人でつくる、一年の探索ノート</p>
          <h1 id="page-title">今年の発見、<br /><span>ひとマスずつ。</span></h1>
          <p className="hero-description">いつもの毎日に隠れた「いちばん」を集めよう。</p>
        </div>
        <div className="exploration-summary" aria-label="収録した投稿の集計">
          <div className="summary-primary"><span>投稿済みのマス</span><strong>{completedCellCount}<small>/ 25</small></strong><div className="mini-bingo" aria-hidden="true">{cells.map((cell) => { const memberId = latestRecordByCell[cell.id]?.memberId; const member = memberId ? getMember(memberId) : null; return <i key={cell.id} className={member?.colorClass ?? ""} />; })}</div></div>
          <div className="summary-secondary"><div><strong>{completedLineCount}</strong><span>完成ライン</span></div><div><strong>{instagramSnapshot.posts.length}</strong><span>投稿の記録</span></div></div>
        </div>
      </section>

      <section className="board-panel" aria-label="ビンゴと投稿">
        <div className="board-toolbar">
          <nav className="view-switch" aria-label="表示モード">
            <button type="button" className={!editing ? "is-active" : ""} aria-pressed={!editing} onClick={() => setEditing(false)}><Grid2X2 size={16} aria-hidden="true" />お題から探す</button>
            <button type="button" className={editing ? "is-active" : ""} aria-pressed={editing} onClick={() => setEditing(true)}><Pencil size={15} aria-hidden="true" />ボードを編集</button>
          </nav>
          <button className="archive-open" type="button" aria-label={`すべての投稿 ${instagramSnapshot.posts.length}件を見る`} onClick={() => openArchive("all")}><BookOpen size={16} aria-hidden="true" /><span>すべての投稿</span><span className="archive-total">{instagramSnapshot.posts.length}</span></button>
        </div>

        {!editing ? <RecordBoard onOpen={openArchive} values={values} /> : <>
      <section className="editor-intro" aria-label="編集の状態">
        <div><h2>担当と記録をセット</h2><p>メンバーを選んでマスをタップ。数値は直接入力できます。</p></div>
        <div className="status-stack"><span className={`sync-pill sync-${syncState}`}><i />{statusLabel}</span><span className="count-pill">担当設定 {filledCount}/25 {version ? <span className="version-text">v{version}</span> : null}</span></div>
      </section>

      <section className="member-dock" aria-label="メンバー">
        {members.map((member) => (
          <button
            className={`member-chip ${member.colorClass} ${
              selectedMemberId === member.id ? "is-selected" : ""
            }`}
            aria-label={`${member.name} ${memberCounts[member.id]}枚`}
            aria-pressed={selectedMemberId === member.id}
            key={member.id}
            type="button"
            onClick={() => setSelectedMemberId(member.id)}
            onPointerDown={(event) => startDrag(event, member.id)}
          >
            <span className="chip-dot">{member.shortName}</span>
            <span className="member-name">{member.name}</span>
            <span className="member-count">{memberCounts[member.id]}枚</span>
          </button>
        ))}
      </section>

      <section className="selection-line" aria-live="polite">
        <div className="selection-status">
          <span>選択中</span>
          {selectedMember ? (
            <strong className={`inline-member ${selectedMember.colorClass}`}>{selectedMember.name}</strong>
          ) : (
            <strong className="inline-clear">空にする</strong>
          )}
        </div>
        <div className="selection-actions">
          <button
            className={`icon-button compact ${selectedMemberId === "clear" ? "is-selected" : ""}`}
            type="button"
            onClick={() => setSelectedMemberId("clear")}
            aria-label="選択したマスを空にする"
            title="空にする"
          >
            <Trash2 size={18} aria-hidden="true" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            onClick={() => void loadState()}
            aria-label="再読み込み"
            title="再読み込み"
          >
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="board" aria-label="ビンゴボード">
        {cells.map((cell, index) => {
          const memberId = placements[cell.id];
          const member = memberId ? getMember(memberId) : null;
          const value = values[cell.id] ?? "";

          return (
            <div
              aria-label={`${index + 1}. ${cell.title}${member ? ` ${member.name}` : " 未配置"}`}
              className={`bingo-cell ${member ? `has-member cell-owned ${member.colorClass}` : "cell-empty"}`}
              data-cell-id={cell.id}
              key={cell.id}
            >
              <button className="cell-tap-target" type="button" onClick={() => handleCellTap(cell.id)}>
                <span className="cell-title">{cell.title}</span>
              </button>
              <label className="value-field">
                <span className="sr-only">{cell.title}の値</span>
                <input
                  className="value-input"
                  type="text"
                  inputMode="text"
                  autoComplete="off"
                  maxLength={MAX_VALUE_LENGTH}
                  value={value}
                  placeholder="入力"
                  onInput={(event) => handleValueInput(cell.id, event.currentTarget.value)}
                  onBlur={(event) => commitCellValue(cell.id, event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.currentTarget.blur();
                    }
                  }}
                />
              </label>
              <div className="cell-member-slot">
                {member ? (
                  <span
                    className={`placed-chip ${member.colorClass}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      startDrag(event, member.id, cell.id);
                    }}
                  >
                    <span>{member.name}</span>
                  </span>
                ) : null}
              </div>
              <button
                className={`cell-post-button ${postCounts[cell.id] > 0 ? "has-posts" : ""}`}
                type="button"
                aria-label={`${cell.title}の投稿 ${postCounts[cell.id]}件を見る`}
                onClick={() => openArchive(cell.id)}
              >
                <BookOpen size={12} aria-hidden="true" /> 投稿 {postCounts[cell.id]}
              </button>
            </div>
          );
        })}
      </section>
        </>}
        <div className="board-footnote"><span><span className="live-dot" />投稿データをアプリに収録済み</span><span>{formatPostDate(instagramSnapshot.capturedAt)} 更新</span></div>
      </section>

      <RecentPosts onOpen={openArchive} />

      <details className="source-board">
        <summary>25のお題を、元のビンゴカードで見る</summary>
        <img src="/bingo-board.jpg" alt="おもしろ探索ビンゴの元画像" />
      </details>

      <footer className="site-footer"><span>小さな発見を、今年の思い出に。</span><span>YEAR BINGO / 2026</span></footer>

      {archiveSelection !== null && <PostArchive initialTopic={archiveSelection.topic} initialMember={archiveSelection.member} onClose={() => setArchiveSelection(null)} />}

      {dragging?.active ? (
        <div className={`drag-ghost ${getMember(dragging.memberId)?.colorClass ?? ""}`} style={{ left: dragging.x, top: dragging.y }}>
          <span className="chip-dot">{getMember(dragging.memberId)?.shortName}</span>
          <span>{getMember(dragging.memberId)?.name}</span>
        </div>
      ) : null}
    </main>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(`${value.replace(" ", "T")}Z`);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}
