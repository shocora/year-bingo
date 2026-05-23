import { describe, expect, it } from "vitest";
import {
  applyAction,
  createEmptyPlacements,
  parseAction,
  sanitizePlacements
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
});
