import { cells, type CellId, type MemberId } from "../../shared/domain";
import type { InstagramPost } from "../data/instagram-posts";

export type TopicFilter = CellId | "all" | "unclassified";
export type MemberFilter = MemberId | "all" | "unknown";

export function matchesMember(memberId: MemberId | null, filter: MemberFilter) {
  return filter === "all" || (filter === "unknown" ? memberId === null : memberId === filter);
}

export function countPostsByCell(posts: InstagramPost[]): Record<CellId, number> {
  return Object.fromEntries(
    cells.map((cell) => [cell.id, posts.filter((post) => post.records.some((record) => record.cellId === cell.id)).length])
  ) as Record<CellId, number>;
}

export function filterPosts(posts: InstagramPost[], topic: TopicFilter, member: MemberFilter) {
  return posts
    .filter((post) => {
      if (topic === "unclassified") return post.records.length === 0 && member === "all";
      if (topic === "all" && member === "all") return true;
      return post.records.some(
        (record) => (topic === "all" || record.cellId === topic) && matchesMember(record.memberId, member)
      );
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
}

export function formatPostDate(value: string | null) {
  if (!value) return "日付未確認";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日付未確認";
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Tokyo"
  }).format(date);
}
