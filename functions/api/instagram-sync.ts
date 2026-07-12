import {
  applyStateAction,
  isCellId,
  isMemberId,
  sanitizeState,
  type BingoStateData,
  type CellId,
  type MemberId
} from "../../shared/domain";

type Env = {
  DB: D1Database;
  INSTAGRAM_SYNC_TOKEN?: string;
  AUTO_APPLY_MIN_CONFIDENCE?: string;
};

type Classification = {
  shouldUpdate: boolean;
  memberId: MemberId | null;
  cellId: CellId | null;
  value: string;
  confidence: number;
  evidence: string;
};

type SyncResult = {
  postId?: string;
  permalink?: string;
  caption?: string;
  classification?: Partial<Classification>;
  error?: string;
};

type SyncRequest = {
  postsSeen?: number;
  reprocess?: boolean;
  results?: SyncResult[];
};

type SyncSummary = {
  status: "success" | "error";
  postsSeen: number;
  postsApplied: number;
  postsSkipped: number;
  errors: string[];
};

const STATE_ID = "default";
const DEFAULT_MIN_CONFIDENCE = 0.72;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESULTS = 20;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  if (!(await isAuthorized(request, env.INSTAGRAM_SYNC_TOKEN))) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  if (request.method === "GET") {
    return jsonResponse({ processedPostIds: await getRecentProcessedPostIds(env.DB) });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      allow: "GET, POST, OPTIONS"
    });
  }

  const payload = await readSyncRequest(request);

  if (!payload) {
    return jsonResponse({ error: "Invalid sync payload" }, 400);
  }

  const runId = await createRun(env.DB);
  const results = payload.results ?? [];
  const summary: SyncSummary = {
    status: "success",
    postsSeen: normalizeCount(payload.postsSeen, results.length),
    postsApplied: 0,
    postsSkipped: 0,
    errors: []
  };

  try {
    for (const result of results) {
      const postId = cleanText(result.postId || result.permalink, 200);

      if (!postId) {
        summary.postsSkipped += 1;
        summary.errors.push("Result did not include a postId");
        continue;
      }

      if (!payload.reprocess && (await isProcessed(env.DB, postId))) {
        summary.postsSkipped += 1;
        continue;
      }

      const classification = normalizeClassification(result.classification);
      const resultError = cleanText(result.error, 1000);

      if (resultError) {
        summary.postsSkipped += 1;
        summary.errors.push(`${postId}: ${resultError}`);
        continue;
      }

      const status = await maybeApplyClassification(env.DB, env, classification);
      await recordProcessedPost(env.DB, {
        postId,
        status,
        permalink: cleanText(result.permalink, 500),
        caption: cleanText(result.caption, 10000),
        classification,
        error: resultError
      });

      if (status === "applied") {
        summary.postsApplied += 1;
      } else {
        summary.postsSkipped += 1;
      }

    }
  } catch (error) {
    summary.status = "error";
    summary.errors.push(errorMessage(error));
  }

  await finishRun(env.DB, runId, summary);
  return jsonResponse(summary, summary.status === "success" ? 200 : 500);
};

async function readSyncRequest(request: Request): Promise<SyncRequest | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return null;
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return null;
  }

  const bodyText = await request.text();

  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) {
    return null;
  }

  try {
    const value = JSON.parse(bodyText) as unknown;

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }

    const requestValue = value as SyncRequest;

    if (!Array.isArray(requestValue.results) || requestValue.results.length > MAX_RESULTS) {
      return null;
    }

    if (requestValue.results.some((result) => !result || typeof result !== "object" || Array.isArray(result))) {
      return null;
    }

    return { ...requestValue, reprocess: requestValue.reprocess === true };
  } catch {
    return null;
  }
}

async function isAuthorized(request: Request, expectedToken?: string) {
  if (!expectedToken) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const suppliedToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";

  if (!suppliedToken) {
    return false;
  }

  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expectedToken)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedToken))
  ]);
  const expected = new Uint8Array(expectedHash);
  const supplied = new Uint8Array(suppliedHash);
  let difference = expected.length ^ supplied.length;

  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ supplied[index];
  }

  return difference === 0;
}

async function maybeApplyClassification(db: D1Database, env: Env, classification: Classification) {
  if (
    !classification.shouldUpdate ||
    !classification.cellId ||
    !classification.memberId ||
    classification.confidence < minConfidence(env) ||
    !classification.value
  ) {
    return "skipped";
  }

  const state = await readState(db);
  let nextState = applyStateAction(state, {
    type: "set",
    cellId: classification.cellId,
    memberId: classification.memberId
  });
  nextState = applyStateAction(nextState, {
    type: "setValue",
    cellId: classification.cellId,
    value: classification.value
  });
  await saveState(db, nextState);
  return "applied";
}

function normalizeClassification(value: Partial<Classification> | undefined): Classification {
  const memberId = isMemberId(value?.memberId) ? value.memberId : null;
  const cellId = isCellId(value?.cellId) ? value.cellId : null;
  const confidence = typeof value?.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : 0;

  return {
    shouldUpdate: value?.shouldUpdate === true,
    memberId,
    cellId,
    value: cleanText(value?.value, 32),
    confidence,
    evidence: cleanText(value?.evidence, 1000)
  };
}

async function readState(db: D1Database): Promise<BingoStateData> {
  const row = await db
    .prepare("SELECT data FROM bingo_state WHERE id = ?1")
    .bind(STATE_ID)
    .first<{ data: string }>();

  return sanitizeState(row ? JSON.parse(row.data) : null);
}

async function saveState(db: D1Database, state: BingoStateData) {
  await db
    .prepare(
      `INSERT INTO bingo_state (id, data, version, updated_at)
       VALUES (?1, ?2, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         data = excluded.data,
         version = bingo_state.version + 1,
         updated_at = datetime('now')`
    )
    .bind(STATE_ID, JSON.stringify(state))
    .run();
}

async function isProcessed(db: D1Database, postId: string) {
  const row = await db
    .prepare("SELECT post_id FROM instagram_processed_posts WHERE post_id = ?1 AND status != 'error'")
    .bind(postId)
    .first();
  return Boolean(row);
}

async function getRecentProcessedPostIds(db: D1Database) {
  const result = await db
    .prepare(
      "SELECT post_id FROM instagram_processed_posts WHERE status != 'error' ORDER BY processed_at DESC LIMIT ?1"
    )
    .bind(200)
    .all<{ post_id: string }>();

  return (result.results ?? [])
    .map((row) => row.post_id)
    .filter((postId): postId is string => typeof postId === "string" && postId.length > 0);
}

async function recordProcessedPost(
  db: D1Database,
  post: {
    postId: string;
    status: string;
    permalink: string;
    caption: string;
    classification: Classification;
    error: string;
  }
) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO instagram_processed_posts
        (post_id, status, media_url, permalink, caption, classification, error, processed_at)
       VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, datetime('now'))`
    )
    .bind(post.postId, post.status, post.permalink, post.caption, JSON.stringify(post.classification), post.error)
    .run();
}

async function createRun(db: D1Database) {
  const result = await db
    .prepare("INSERT INTO instagram_sync_runs (trigger_type, status) VALUES ('local-cli', 'running')")
    .run();
  return result.meta.last_row_id;
}

async function finishRun(db: D1Database, runId: number | undefined, summary: SyncSummary) {
  if (!runId) {
    return;
  }

  await db
    .prepare(
      `UPDATE instagram_sync_runs
       SET status = ?1, posts_seen = ?2, posts_applied = ?3, posts_skipped = ?4, error = ?5, finished_at = datetime('now')
       WHERE id = ?6`
    )
    .bind(
      summary.status,
      summary.postsSeen,
      summary.postsApplied,
      summary.postsSkipped,
      summary.errors.join("\n").slice(0, 2000),
      runId
    )
    .run();
}

function minConfidence(env: Env) {
  const value = Number(env.AUTO_APPLY_MIN_CONFIDENCE || DEFAULT_MIN_CONFIDENCE);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_MIN_CONFIDENCE;
}

function normalizeCount(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.trunc(value)))
    : fallback;
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength)
    : "";
}

function jsonResponse(body: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...jsonHeaders,
      ...extraHeaders
    }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
