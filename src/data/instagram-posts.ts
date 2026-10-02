import type { CellId, MemberId } from "../../shared/domain";
import snapshot from "./instagram-snapshot.json";

export type InstagramRecord = {
  cellId: CellId;
  memberId: MemberId | null;
  value: string | null;
  note?: string;
};

export type InstagramPost = {
  id: string;
  url: string;
  publishedAt: string | null;
  caption: string;
  records: InstagramRecord[];
  note?: string;
};

export type InstagramSnapshot = {
  account: string;
  profileUrl: string;
  capturedAt: string | null;
  coverage: "complete" | "partial" | "unavailable";
  coverageNote: string;
  posts: InstagramPost[];
};

// Browser-verified, one-time snapshot. Only add information visible in the source posts.
// Face photos and videos stay on Instagram and are not bundled with the app.
export const instagramSnapshot = snapshot as InstagramSnapshot;
