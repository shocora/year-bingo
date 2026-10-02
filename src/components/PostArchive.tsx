import { ExternalLink, ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cells, getMember, members } from "../../shared/domain";
import { instagramSnapshot, type InstagramPost } from "../data/instagram-posts";
import {
  countPostsByCell,
  filterPosts,
  formatPostDate,
  matchesMember,
  type MemberFilter,
  type TopicFilter
} from "../lib/instagram-posts";

const postCounts = countPostsByCell(instagramSnapshot.posts);
const hasUnknownMembers = instagramSnapshot.posts.some((post) => post.records.some((record) => !record.memberId));

export function PostArchive({ initialTopic, initialMember = "all", onClose }: { initialTopic: TopicFilter; initialMember?: MemberFilter; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [topic, setTopic] = useState<TopicFilter>(initialTopic);
  const [member, setMember] = useState<MemberFilter>(initialMember);
  const posts = filterPosts(instagramSnapshot.posts, topic, member);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="post-dialog"
      aria-labelledby="post-archive-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="post-dialog-content">
        <header className="post-dialog-header">
          <div>
            <p className="eyebrow">DISCOVERY ARCHIVE</p>
            <h2 id="post-archive-title">{cells.find((cell) => cell.id === topic)?.title ?? (topic === "unclassified" ? "参考資料" : "みんなの投稿")}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="投稿一覧を閉じる" autoFocus>
            <X size={22} aria-hidden="true" />
          </button>
        </header>

        <div className="post-dialog-scroll">
        <p className="archive-date">
          {instagramSnapshot.capturedAt ? `${formatPostDate(instagramSnapshot.capturedAt)} 収録` : "投稿データは未収録"}
          {instagramSnapshot.coverage === "partial" ? " · 一部の投稿を収録" : ""}
        </p>
        <div className="post-filters">
          <label>
            お題
            <select value={topic} onChange={(event) => setTopic(event.target.value as TopicFilter)}>
              <option value="all">すべてのお題（{instagramSnapshot.posts.length}件）</option>
              {cells.map((cell) => (
                <option key={cell.id} value={cell.id}>{cell.title}（{postCounts[cell.id]}件）</option>
              ))}
              <option value="unclassified">
                お題以外・未分類（{instagramSnapshot.posts.filter((post) => post.records.length === 0).length}件）
              </option>
            </select>
          </label>
          <label>
            メンバー
            <select value={member} onChange={(event) => setMember(event.target.value as MemberFilter)}>
              <option value="all">全員</option>
              {members.map((person) => (
                <option key={person.id} value={person.id}>{person.name}</option>
              ))}
              {hasUnknownMembers && <option value="unknown">メンバー未確認</option>}
            </select>
          </label>
        </div>

        <p className="post-results" role="status">
          {posts.length}件の投稿 · 新しい順
        </p>
        {instagramSnapshot.coverage !== "complete" && <p className="archive-notice">{instagramSnapshot.coverageNote}</p>}
        {posts.length > 0 ? (
          <div className="post-list">
            {posts.map((post) => (
              <PostCard key={post.id} post={post} topic={topic} member={member} />
            ))}
          </div>
        ) : (
          <div className="post-empty">
            <ImageIcon size={28} aria-hidden="true" />
            <p>{instagramSnapshot.coverage === "unavailable" ? "投稿の取り込み待ちです" : "この条件に一致する収録済み投稿はありません"}</p>
            <span>{instagramSnapshot.coverage === "unavailable" ? "取り込み後は、記録・本文・投稿日をここで確認できます。" : "お題やメンバーを切り替えて確認できます。"}</span>
          </div>
        )}
        {instagramSnapshot.coverage === "complete" && <p className="archive-date">{instagramSnapshot.coverageNote}</p>}
        <p className="archive-date">{hasUnknownMembers ? "メンバーが分からない記録は「未確認」と表示しています。" : "すべての記録のメンバーを確認済みです。"}</p>
        <a className="source-link" href={instagramSnapshot.profileUrl} target="_blank" rel="noopener noreferrer">
          Instagramのプロフィールを見る <ExternalLink size={14} aria-hidden="true" />
        </a>
        </div>
      </div>
    </dialog>
  );
}

function PostCard({ post, topic, member }: { post: InstagramPost; topic: TopicFilter; member: MemberFilter }) {
  const records = post.records.filter(
    (record) => (topic === "all" || topic === record.cellId) && matchesMember(record.memberId, member)
  );
  return (
    <article className="post-card">
      <header className="post-card-header">
        {post.publishedAt
          ? <time dateTime={post.publishedAt}>{formatPostDate(post.publishedAt)}</time>
          : <span>投稿日未確認</span>}
        <a
          className="source-link"
          href={post.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${formatPostDate(post.publishedAt)}の元投稿をInstagramで開く`}
        >
          元投稿 <ExternalLink size={14} aria-hidden="true" />
        </a>
      </header>
      {records.length > 0 ? (
        <ul className="post-records">
          {records.map((record, index) => {
            const person = record.memberId ? getMember(record.memberId) : null;
            return (
              <li key={`${record.cellId}-${index}`}>
                <span className="record-topic">{cells.find((cell) => cell.id === record.cellId)?.title}</span>
                <div className="record-result">
                  <strong>{record.value ?? "値は未確認"}</strong>
                  <span className={person ? `inline-member ${person.colorClass}` : "record-unknown"}>
                    {person?.name ?? "メンバー未確認"}
                  </span>
                </div>
                {record.note && <p className="record-note">{record.note}</p>}
              </li>
            );
          })}
        </ul>
      ) : <p className="record-note">{post.note ?? "お題は未分類です。投稿本文を参照してください。"}</p>}
      <a className="post-instagram-link" href={post.url} target="_blank" rel="noopener noreferrer">
        Instagramで投稿を見る <ExternalLink size={15} aria-hidden="true" />
      </a>
      <details className="post-caption">
        <summary>投稿本文</summary>
        <p>{post.caption || "本文なし"}</p>
      </details>
    </article>
  );
}
