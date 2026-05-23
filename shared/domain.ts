export const members = [
  { id: "ryo", name: "リョウ", shortName: "リ", colorClass: "member-ryo" },
  { id: "murakami", name: "ムラカミ", shortName: "ム", colorClass: "member-murakami" },
  { id: "kobari", name: "コバリ", shortName: "コ", colorClass: "member-kobari" },
  { id: "mitchy", name: "ミッチー", shortName: "ミ", colorClass: "member-mitchy" },
  { id: "nissy", name: "ニッシー", shortName: "ニ", colorClass: "member-nissy" }
] as const;

export const cells = [
  { id: "discount", title: "最大割引率", unit: "%", sample: "80%OFF", tone: "rose" },
  { id: "gasoline", title: "最安ガソリン価格", unit: "円/L", sample: "120円", tone: "green" },
  { id: "south", title: "到達した最南端地点", unit: "", sample: "南の島", tone: "cyan" },
  { id: "same-drink", title: "自販機の同一飲料本数", unit: "", sample: "同じ飲料", tone: "rose" },
  { id: "ramen", title: "最高額ラーメン", unit: "一杯", sample: "5000円", tone: "amber" },
  { id: "future-expiry", title: "最も未来の賞味期限", unit: "", sample: "2035年12月", tone: "peach" },
  { id: "locker", title: "最大ロッカー番号", unit: "", sample: "9999", tone: "lavender" },
  { id: "temperature", title: "最高気温", unit: "℃", sample: "42℃", tone: "amber" },
  { id: "gamble", title: "公営ギャンブル最高勝ち額", unit: "", sample: "勝ち額", tone: "green" },
  { id: "street-number", title: "街中で見つけた最大の数字", unit: "", sample: "10,000", tone: "cyan" },
  { id: "bill-number", title: "お札に書かれた最大数字", unit: "6桁", sample: "999999", tone: "cream" },
  { id: "first-train", title: "最も早い電車の発車時刻", unit: "電光掲示板", sample: "04:15", tone: "lavender" },
  { id: "steps", title: "1日の最大歩数", unit: "", sample: "35,000歩", tone: "rose" },
  { id: "old-expiry", title: "最も古い賞味期限", unit: "", sample: "1985年", tone: "peach" },
  { id: "altitude", title: "到達した最大標高", unit: "m", sample: "3776m", tone: "green" },
  { id: "vending-price", title: "自販機の最大飲料価格", unit: "", sample: "800円", tone: "green" },
  { id: "score-2048", title: "2048 最高スコア", unit: "", sample: "131072", tone: "rose" },
  { id: "north", title: "到達した最北端地点", unit: "", sample: "最北端", tone: "cyan" },
  { id: "calorie", title: "最高カロリー食品", unit: "一品", sample: "2500kcal", tone: "amber" },
  { id: "real-estate", title: "不動産チラシ最高額", unit: "", sample: "10億円", tone: "amber" },
  { id: "vending-row", title: "自販機の最大並び台数", unit: "", sample: "並び台数", tone: "rose" },
  { id: "convenience", title: "コンビニでの最高支払額", unit: "", sample: "レシート", tone: "amber" },
  { id: "cats", title: "同時に見た野生ねこの数", unit: "", sample: "ねこ数", tone: "stone" },
  { id: "wait", title: "最大待ち時間", unit: "分", sample: "180分", tone: "cyan" },
  { id: "coin", title: "最も古い硬貨", unit: "", sample: "古い硬貨", tone: "rose" }
] as const;

export type MemberId = (typeof members)[number]["id"];
export type CellId = (typeof cells)[number]["id"];
export type Placements = Record<CellId, MemberId | null>;

export type BingoAction =
  | { type: "set"; cellId: CellId; memberId: MemberId | null }
  | { type: "move"; fromCellId: CellId; toCellId: CellId; memberId: MemberId }
  | { type: "reset" };

const memberIds = new Set<string>(members.map((member) => member.id));
const cellIds = new Set<string>(cells.map((cell) => cell.id));

export function isMemberId(value: unknown): value is MemberId {
  return typeof value === "string" && memberIds.has(value);
}

export function isCellId(value: unknown): value is CellId {
  return typeof value === "string" && cellIds.has(value);
}

export function createEmptyPlacements(): Placements {
  return Object.fromEntries(cells.map((cell) => [cell.id, null])) as Placements;
}

export function sanitizePlacements(value: unknown): Placements {
  const placements = createEmptyPlacements();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return placements;
  }

  for (const cell of cells) {
    const rawValue = (value as Record<string, unknown>)[cell.id];
    placements[cell.id] = isMemberId(rawValue) ? rawValue : null;
  }

  return placements;
}

export function parseAction(value: unknown): BingoAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const action = value as Record<string, unknown>;

  if (action.type === "reset") {
    return { type: "reset" };
  }

  if (action.type === "set" && isCellId(action.cellId)) {
    if (action.memberId === null || isMemberId(action.memberId)) {
      return { type: "set", cellId: action.cellId, memberId: action.memberId };
    }
  }

  if (
    action.type === "move" &&
    isCellId(action.fromCellId) &&
    isCellId(action.toCellId) &&
    isMemberId(action.memberId)
  ) {
    return {
      type: "move",
      fromCellId: action.fromCellId,
      toCellId: action.toCellId,
      memberId: action.memberId
    };
  }

  return null;
}

export function applyAction(currentPlacements: Placements, action: BingoAction): Placements {
  const nextPlacements = { ...currentPlacements };

  if (action.type === "reset") {
    return createEmptyPlacements();
  }

  if (action.type === "set") {
    nextPlacements[action.cellId] = action.memberId;
    return nextPlacements;
  }

  if (action.fromCellId === action.toCellId) {
    return nextPlacements;
  }

  const previousTargetMember = nextPlacements[action.toCellId];
  nextPlacements[action.toCellId] = action.memberId;

  if (nextPlacements[action.fromCellId] === action.memberId) {
    nextPlacements[action.fromCellId] = previousTargetMember;
  }

  return nextPlacements;
}

export function getMember(memberId: MemberId) {
  return members.find((member) => member.id === memberId);
}
