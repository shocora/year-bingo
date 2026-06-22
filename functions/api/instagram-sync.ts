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
  INSTAGRAM_SYNC_LAMBDA_URL: string;
  INSTAGRAM_SYNC_TOKEN?: string;
  AUTO_APPLY_MIN_CONFIDENCE?: string;
  MAX_MEDIA_PER_RUN?: string;
  INSTAGRAM_SYNC_COOLDOWN_SECONDS?: string;
};

type Classification = {
  shouldUpdate: boolean;
  memberId: MemberId | null;
  cellId: CellId | null;
  value: string;
  confidence: number;
  evidence: string;
};

type LambdaResult = {
  postId?: string;
  permalink?: string;
  caption?: string;
  classification?: Partial<Classification>;
  error?: string;
};

type LambdaResponse = {
  status?: string;
  postsSeen?: number;
  results?: LambdaResult[];
  errors?: string[];
};

type SyncSummary = {
  status: "success" | "error";
  postsSeen: number;
  postsApplied: number;
  postsSkipped: number;
  cooldown?: boolean;
  errors: string[];
};

const STATE_ID = "default";
const DEFAULT_MIN_CONFIDENCE = 0.72;
const DEFAULT_MAX_POSTS = 8;
const DEFAULT_COOLDOWN_SECONDS = 300;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, {
      allow: "POST, OPTIONS"
    });
  }

  const cooldownSummary = await getCooldownSummary(env.DB, env);

  if (cooldownSummary) {
    return jsonResponse(cooldownSummary);
  }

  const runId = await createRun(env.DB, "button");
  const summary: SyncSummary = {
    status: "success",
    postsSeen: 0,
    postsApplied: 0,
    postsSkipped: 0,
    errors: []
  };

  try {
    const lambdaResponse = await callLambda(env);

    if (lambdaResponse.status === "error") {
      throw new Error(lambdaResponse.errors?.join("\n") || "Lambda sync failed");
    }

    const results = Array.isArray(lambdaResponse.results) ? lambdaResponse.results : [];
    summary.postsSeen = lambdaResponse.postsSeen ?? results.length;

    for (const result of results) {
      const postId = result.postId || result.permalink;

      if (!postId) {
        summary.postsSkipped += 1;
        summary.errors.push("Lambda returned a post without postId");
        continue;
      }

      if (await isProcessed(env.DB, postId)) {
        summary.postsSkipped += 1;
        continue;
      }

      if (result.error) {
        summary.postsSkipped += 1;
        summary.errors.push(`${postId}: ${result.error}`);
        continue;
      }

      const classification = normalizeClassification(result.classification);
      const status = await maybeApplyClassification(env.DB, env, classification);
      await recordProcessedPost(env.DB, {
        postId,
        status,
        permalink: result.permalink || "",
        caption: result.caption || "",
        classification,
        error: result.error || ""
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

async function callLambda(env: Env): Promise<LambdaResponse> {
  if (!env.INSTAGRAM_SYNC_LAMBDA_URL) {
    throw new Error("Missing required env: INSTAGRAM_SYNC_LAMBDA_URL");
  }

  if (!env.INSTAGRAM_SYNC_TOKEN) {
    throw new Error("Missing required env: INSTAGRAM_SYNC_TOKEN");
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${env.INSTAGRAM_SYNC_TOKEN}`,
    "content-type": "application/json"
  };

  const response = await fetch(env.INSTAGRAM_SYNC_LAMBDA_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ maxPosts: maxPosts(env) })
  });

  const bodyText = await response.text();
  const payload = bodyText ? (JSON.parse(bodyText) as LambdaResponse) : {};

  if (!response.ok) {
    throw new Error(payload.errors?.join("\n") || `Lambda sync failed: ${response.status}`);
  }

  return payload;
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
    value: typeof value?.value === "string" ? value.value : "",
    confidence,
    evidence: typeof value?.evidence === "string" ? value.evidence : ""
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
    .prepare("SELECT post_id FROM instagram_processed_posts WHERE post_id = ?1")
    .bind(postId)
    .first();
  return Boolean(row);
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

async function createRun(db: D1Database, triggerType: string) {
  const result = await db
    .prepare("INSERT INTO instagram_sync_runs (trigger_type, status) VALUES (?1, 'running')")
    .bind(triggerType)
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

async function getCooldownSummary(db: D1Database, env: Env): Promise<SyncSummary | null> {
  const cooldownSeconds = cooldown(env);

  if (cooldownSeconds <= 0) {
    return null;
  }

  const row = await db
    .prepare(
      `SELECT started_at FROM instagram_sync_runs
       WHERE trigger_type = 'button'
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .first<{ started_at: string }>();

  if (!row) {
    return null;
  }

  const startedAt = new Date(`${row.started_at.replace(" ", "T")}Z`).getTime();

  if (Number.isNaN(startedAt) || Date.now() - startedAt >= cooldownSeconds * 1000) {
    return null;
  }

  return {
    status: "success",
    postsSeen: 0,
    postsApplied: 0,
    postsSkipped: 0,
    cooldown: true,
    errors: []
  };
}

function maxPosts(env: Env) {
  const value = Number(env.MAX_MEDIA_PER_RUN || DEFAULT_MAX_POSTS);
  return Number.isFinite(value) ? Math.max(1, Math.min(20, value)) : DEFAULT_MAX_POSTS;
}

function minConfidence(env: Env) {
  const value = Number(env.AUTO_APPLY_MIN_CONFIDENCE || DEFAULT_MIN_CONFIDENCE);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_MIN_CONFIDENCE;
}

function cooldown(env: Env) {
  const value = Number(env.INSTAGRAM_SYNC_COOLDOWN_SECONDS || DEFAULT_COOLDOWN_SECONDS);
  return Number.isFinite(value) ? Math.max(0, Math.min(3600, value)) : DEFAULT_COOLDOWN_SECONDS;
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
