import { ArrowRight, ArrowUpRight, Instagram } from "lucide-react";
import { useState } from "react";
import { cells, getMember, members } from "../../shared/domain";
import { instagramSnapshot } from "../data/instagram-posts";
import { countLatestCellsByMember, filterPosts, formatPostDate, matchesMember, type MemberFilter, type TopicFilter } from "../lib/instagram-posts";
import { TopicIcon } from "./TopicIcon";

type OpenArchive = (topic: TopicFilter, member?: MemberFilter) => void;
const latestCellCounts = countLatestCellsByMember(instagramSnapshot.posts);

export function RecordBoard({ onOpen }: { onOpen: OpenArchive }) {
  const [member, setMember] = useState<MemberFilter>("all");

  return (
    <>
      <div className="record-board-intro">
        <p>気になるマスから、みんなの発見をのぞいてみよう。</p>
        <span>各マスは最新の投稿</span>
      </div>
      <section className="current-holder-summary" aria-label="最新記録を保持しているマス数">
        <div className="holder-summary-label"><span>現在の保持マス</span><small>最新記録</small></div>
        {members.map((person) => (
          <div className={`holder-count ${person.colorClass}`} key={person.id}>
            <span><i />{person.name}</span><strong>{latestCellCounts[person.id]}<small>マス</small></strong>
          </div>
        ))}
      </section>
      <p className="record-filter-label">投稿履歴をメンバーで絞り込む</p>
      <div className="record-member-filters" aria-label="記録をメンバーで絞り込む">
        <button
          className={`filter-member filter-all ${member === "all" ? "is-active" : ""}`}
          type="button"
          aria-pressed={member === "all"}
          onClick={() => setMember("all")}
        >
          みんな <span>{instagramSnapshot.posts.filter((post) => post.records.length > 0).length}</span>
        </button>
        {members.map((person) => (
          <button
            key={person.id}
            className={`filter-member ${person.colorClass} ${member === person.id ? "is-active" : ""}`}
            type="button"
            aria-pressed={member === person.id}
            onClick={() => setMember(person.id)}
          >
            <span className="member-dot" />{person.name}
            <span>{filterPosts(instagramSnapshot.posts, "all", person.id).length}</span>
          </button>
        ))}
      </div>
      <section className="record-board" aria-label="お題ごとの記録">
        {cells.map((cell, index) => {
          const posts = filterPosts(instagramSnapshot.posts, cell.id, member);
          const latest = posts[0]?.records.find((record) => record.cellId === cell.id && matchesMember(record.memberId, member));
          const person = latest?.memberId ? getMember(latest.memberId) : null;
          return (
            <button
              key={cell.id}
              type="button"
              className={`topic-tile ${posts.length ? "has-records" : "no-records"} ${person ? `is-bingo-filled ${person.colorClass}` : ""}`}
              aria-label={`${cell.title}の投稿 ${posts.length}件を見る`}
              onClick={() => onOpen(cell.id, member)}
            >
              <span className="topic-tile-top">
                <span className={`topic-icon tone-${cell.tone}`}><TopicIcon cellId={cell.id} /></span>
                <span className="topic-number">{person ? <><span className="member-dot" /><span className="topic-member-name">{person.name}</span><span className="topic-member-short">{person.shortName}</span></> : String(index + 1).padStart(2, "0")}</span>
              </span>
              <span className="topic-title">{cell.title}</span>
              <strong className={`topic-value ${(latest?.value?.length ?? 0) > 8 ? "is-long" : ""}`}>
                {latest ? latest.value ?? "値は未確認" : "—"}
              </strong>
              <span className="topic-author">
                {person ? <><span className={`member-dot ${person.colorClass}`} />{person.name}</> : posts.length ? "メンバー未確認" : "これからの発見"}
              </span>
              <span className="topic-tile-bottom"><span>{posts.length}件の投稿</span><ArrowUpRight size={14} aria-hidden="true" /></span>
            </button>
          );
        })}
      </section>
    </>
  );
}

export function RecentPosts({ onOpen }: { onOpen: OpenArchive }) {
  const posts = filterPosts(instagramSnapshot.posts, "all", "all").filter((post) => post.records.length > 0).slice(0, 3);
  return (
    <section className="recent-section" aria-labelledby="recent-title">
      <div className="section-heading">
        <div><p className="eyebrow">LATEST FINDS</p><h2 id="recent-title">最近の発見</h2></div>
        <button className="text-button" type="button" onClick={() => onOpen("all")}>すべて見る <ArrowRight size={16} aria-hidden="true" /></button>
      </div>
      <div className="recent-grid">
        {posts.map((post) => {
          const record = post.records[0];
          const person = record.memberId ? getMember(record.memberId) : null;
          return (
            <button className="recent-card" key={post.id} type="button" onClick={() => onOpen(record.cellId, record.memberId ?? "all")}>
              <div className="recent-topic"><span><TopicIcon cellId={record.cellId} size={20} /></span><span>{cells.find((cell) => cell.id === record.cellId)?.title}</span><Instagram size={16} aria-hidden="true" /></div>
              <div className="recent-card-content">
                <div className="recent-meta"><span className={person?.colorClass}><span className="member-dot" />{person?.name ?? "メンバー未確認"}</span><time dateTime={post.publishedAt ?? undefined}>{formatPostDate(post.publishedAt)}</time></div>
                <strong>{record.value ?? "記録を見る"}<ArrowUpRight size={18} aria-hidden="true" /></strong>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
