import { Instagram, RefreshCw, Trash2 } from "lucide-react";
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

type SyncState = "loading" | "ready" | "saving" | "offline";

type InstagramSyncState = "idle" | "syncing" | "success" | "error";

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

export default function App() {
  const [placements, setPlacements] = useState<Placements>(() => createEmptyPlacements());
  const [values, setValues] = useState<Values>(() => createEmptyValues());
  const [selectedMemberId, setSelectedMemberId] = useState<MemberId | "clear">("ryo");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [instagramSyncState, setInstagramSyncState] = useState<InstagramSyncState>("idle");
  const [instagramSyncMessage, setInstagramSyncMessage] = useState("");
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

  const handleInstagramSync = useCallback(async () => {
    setInstagramSyncState("syncing");
    setInstagramSyncMessage("更新中");

    try {
      const response = await fetch("/api/instagram-sync", {
        method: "POST",
        headers: { accept: "application/json" },
        cache: "no-store"
      });
      const result = (await response.json()) as {
        status?: string;
        postsApplied?: number;
        postsSeen?: number;
        cooldown?: boolean;
        errors?: string[];
      };

      if (!response.ok || result.status === "error") {
        throw new Error(result.errors?.[0] || `POST /api/instagram-sync failed: ${response.status}`);
      }

      await loadState();
      setInstagramSyncState("success");
      if (result.cooldown) {
        setInstagramSyncMessage("少し待って");
      } else if ((result.postsApplied ?? 0) > 0) {
        setInstagramSyncMessage(`${result.postsApplied ?? 0}件反映`);
      } else {
        setInstagramSyncMessage((result.postsSeen ?? 0) > 0 ? "反映なし" : "投稿なし");
      }
    } catch {
      setInstagramSyncState("error");
      setInstagramSyncMessage("更新失敗");
    }
  }, [loadState]);

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

  const statusLabel = useMemo(() => {
    if (syncState === "loading") {
      return "読み込み中";
    }

    if (syncState === "saving") {
      return "保存中";
    }

    if (syncState === "offline") {
      return "ローカル表示";
    }

    return updatedAt ? `同期済み ${formatUpdatedAt(updatedAt)}` : "同期済み";
  }, [syncState, updatedAt]);

  return (
    <main className="app-shell">
      <section className="top-bar" aria-label="ビンゴの状態">
        <div>
          <p className="eyebrow">おもしろ探索ビンゴ</p>
          <h1>担当チップ</h1>
        </div>
        <div className="status-stack">
          <span className={`sync-pill sync-${syncState}`}>{statusLabel}</span>
          <span className="count-pill">
            {filledCount}/25
            {version ? <span className="version-text"> v{version}</span> : null}
          </span>
        </div>
      </section>

      <section className="member-dock" aria-label="メンバー">
        {members.map((member) => (
          <button
            className={`member-chip ${member.colorClass} ${
              selectedMemberId === member.id ? "is-selected" : ""
            }`}
            aria-label={`${member.name} ${memberCounts[member.id]}枚`}
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
            className={`instagram-sync-button instagram-sync-${instagramSyncState}`}
            type="button"
            onClick={() => void handleInstagramSync()}
            disabled={instagramSyncState === "syncing" || syncState === "loading"}
            aria-label="Instagramの投稿から更新する"
            aria-busy={instagramSyncState === "syncing"}
            title={instagramSyncMessage || "Instagram更新"}
          >
            <Instagram size={16} aria-hidden="true" />
            <span>{instagramSyncMessage || "インスタ更新"}</span>
          </button>
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
          );
        })}
      </section>

      <details className="source-board">
        <summary>元画像</summary>
        <img src="/bingo-board.jpg" alt="おもしろ探索ビンゴの元画像" />
      </details>

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
