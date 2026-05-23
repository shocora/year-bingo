import { describe, expect, it } from "vitest";
import {
  applyAction,
  applyStateAction,
  createEmptyPlacements,
  createEmptyState,
  parseAction,
  sanitizePlacements,
  sanitizeState
} from "./domain";

describe("bingo domain", () => {
  it("sanitizes unknown cells and members", () => {
    const placements = sanitizePlacements({
      discount: "ryo",
      gasoline: "unknown",
      extra: "murakami"
    });

    expect(placements.discount).toBe("ryo");
    expect(placements.gasoline).toBeNull();
    expect("extra" in placements).toBe(false);
  });

  it("moves a chip and swaps the occupied target", () => {
    const placements = createEmptyPlacements();
    placements.discount = "ryo";
    placements.gasoline = "murakami";

    const next = applyAction(placements, {
      type: "move",
      fromCellId: "discount",
      toCellId: "gasoline",
      memberId: "ryo"
    });

    expect(next.discount).toBe("murakami");
    expect(next.gasoline).toBe("ryo");
  });

  it("rejects malformed actions", () => {
    expect(parseAction({ type: "set", cellId: "discount", memberId: "nissy" })).not.toBeNull();
    expect(parseAction({ type: "set", cellId: "discount", memberId: "script" })).toBeNull();
    expect(parseAction({ type: "move", fromCellId: "discount", toCellId: "extra", memberId: "ryo" })).toBeNull();
  });

  it("keeps legacy placement data readable when values are added", () => {
    const state = sanitizeState({ discount: "ryo" });

    expect(state.placements.discount).toBe("ryo");
    expect(state.values.discount).toBe("");
  });

  it("stores sanitized cell values without changing placements", () => {
    const state = createEmptyState();
    state.placements.discount = "ryo";

    const next = applyStateAction(state, {
      type: "setValue",
      cellId: "discount",
      value: "  81% OFF\n"
    });

    expect(next.placements.discount).toBe("ryo");
    expect(next.values.discount).toBe("81% OFF");
  });
});
