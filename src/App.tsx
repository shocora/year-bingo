import { RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyAction,
  cells,
  createEmptyPlacements,
  getMember,
  members,
  sanitizePlacements,
  type BingoAction,
  type CellId,
  type MemberId,
  type Placements
} from "../shared/domain";

type SyncState = "loading" | "ready" | "saving" | "offline";

type RemoteState = {
  placements: Placements;
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
  const [selectedMemberId, setSelectedMemberId] = useState<MemberId | "clear">("ryo");
  const [syncState, setSyncState] = useState<SyncState>("loading");
  const [version, setVersion] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const isSavingRef = useRef(false);
  const draggingRef = useRef<DragState | null>(null);

  const selectedMember = selectedMemberId === "clear" ? null : getMember(selectedMemberId);

  const applyRemoteState = useCallback((state: RemoteState) => {
    setPlacements(sanitizePlacements(state.placements));
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

  const commitAction = useCallback(
    async (action: BingoAction) => {
      setPlacements((currentPlacements) => applyAction(currentPlacements, action));
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
    [applyRemoteState, loadState]
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
            key={member.id}
            type="button"
            onClick={() => setSelectedMemberId(member.id)}
            onPointerDown={(event) => startDrag(event, member.id)}
          >
            <span className="chip-dot">{member.shortName}</span>
            <span>{member.name}</span>
          </button>
        ))}
        <button
          className={`icon-button ${selectedMemberId === "clear" ? "is-selected" : ""}`}
          type="button"
          onClick={() => setSelectedMemberId("clear")}
          aria-label="選択したマスを空にする"
          title="空にする"
        >
          <Trash2 size={18} aria-hidden="true" />
        </button>
        <button className="icon-button" type="button" onClick={() => void loadState()} aria-label="再読み込み" title="再読み込み">
          <RefreshCw size={18} aria-hidden="true" />
        </button>
      </section>

      <section className="selection-line" aria-live="polite">
        <span>選択中</span>
        {selectedMember ? (
          <strong className={`inline-member ${selectedMember.colorClass}`}>{selectedMember.name}</strong>
        ) : (
          <strong className="inline-clear">空にする</strong>
        )}
      </section>

      <section className="board" aria-label="ビンゴボード">
        {cells.map((cell, index) => {
          const memberId = placements[cell.id];
          const member = memberId ? getMember(memberId) : null;

          return (
            <button
              aria-label={`${index + 1}. ${cell.title}${member ? ` ${member.name}` : " 未配置"}`}
              className={`bingo-cell tone-${cell.tone} ${member ? "has-member" : ""}`}
              data-cell-id={cell.id}
              key={cell.id}
              type="button"
              onClick={() => handleCellTap(cell.id)}
            >
              <span className="cell-title">{cell.title}</span>
              <span className="cell-meta">
                {cell.unit ? `${cell.unit} / ` : ""}
                {cell.sample}
              </span>
              {member ? (
                <span
                  className={`placed-chip ${member.colorClass}`}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    startDrag(event, member.id, cell.id);
                  }}
                >
                  <span className="chip-dot">{member.shortName}</span>
                  <span>{member.name}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </section>

      <section className="utility-row">
        <button className="ghost-button" type="button" onClick={() => void commitAction({ type: "reset" })}>
          <RotateCcw size={17} aria-hidden="true" />
          <span>全部はずす</span>
        </button>
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
