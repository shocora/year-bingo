import { describe, expect, it } from "vitest";
import { cells, members } from "../../shared/domain";
import { instagramSnapshot, type InstagramPost } from "../data/instagram-posts";
import { countPostsByCell, filterPosts, formatPostDate } from "./instagram-posts";

describe("embedded Instagram archive", () => {
  it("includes every captured post once with valid topics, members, dates, and no embedded photos", () => {
    const { posts } = instagramSnapshot;
    expect(posts).toHaveLength(69);
    expect(new Set(posts.map((post) => post.id)).size).toBe(posts.length);
    for (const post of posts) {
      expect(post.url).toMatch(/^https:\/\/www\.instagram\.com\/kasubingo_2026\/(p|reel)\/[\w-]+\/$/);
      expect(post.url.split("/").at(-2)).toBe(post.id);
      expect(Number.isNaN(Date.parse(post.publishedAt!))).toBe(false);
      for (const record of post.records) {
        expect(cells.some((cell) => cell.id === record.cellId)).toBe(true);
        expect(record.memberId === null || members.some((member) => member.id === record.memberId)).toBe(true);
      }
      expect("images" in post).toBe(false);
    }
  });

  it("keeps the reference board out of topic records and keeps uncertain amounts unknown", () => {
    const reference = filterPosts(instagramSnapshot.posts, "unclassified", "all");
    expect(reference).toHaveLength(1);
    expect(reference[0].note).toContain("実績の投稿ではありません");
    expect(filterPosts(instagramSnapshot.posts, "gamble", "murakami").map((post) => post.records[0].value))
      .toEqual(["21,060円", null]);
    expect(filterPosts(instagramSnapshot.posts, "all", "unknown")).toHaveLength(0);
    expect(filterPosts(instagramSnapshot.posts, "north", "murakami")[0].records[0].value).toBe("ルーブル美術館");
    expect(filterPosts(instagramSnapshot.posts, "gasoline", "murakami")[0].records[0].value).toBe("138円/L");
    expect(filterPosts(instagramSnapshot.posts, "vending-price", "ryo").map((post) => post.records[0].value))
      .toEqual(["1,350円", "990円"]);
  });

  it("matches topic and member on the same record, counting a post once per topic", () => {
    const post: InstagramPost = {
      id: "fixture", url: "", publishedAt: null, caption: "",
      records: [
        { cellId: "steps", memberId: "ryo", value: "100歩" },
        { cellId: "steps", memberId: "mitchy", value: "200歩" },
        { cellId: "cats", memberId: "nissy", value: "2匹" }
      ]
    };
    expect(filterPosts([post], "steps", "nissy")).toEqual([]);
    expect(filterPosts([post], "steps", "mitchy")).toEqual([post]);
    expect(countPostsByCell([post]).steps).toBe(1);
  });

  it("uses Japan dates and original publish dates even when captions were edited later", () => {
    expect(formatPostDate("2026-09-28T15:52:32Z")).toBe("2026年9月29日");
    expect(formatPostDate(null)).toBe("日付未確認");
    const post = instagramSnapshot.posts.find((item) => item.id.startsWith("DWGzow5"));
    expect(formatPostDate(post!.publishedAt)).toBe("2026年3月20日");
    const originals = instagramSnapshot.posts.map((item) => item.id);
    const result = filterPosts(instagramSnapshot.posts, "score-2048", "ryo");
    expect(result.map((item) => item.records[0].value)).toEqual(["109,072", "63,656", "50,204", "23,432"]);
    expect(instagramSnapshot.posts.map((item) => item.id)).toEqual(originals);
  });
});
