import {
  applyStateAction,
  cells,
  isCellId,
  isMemberId,
  members,
  sanitizeState,
  type BingoStateData,
  type CellId,
  type MemberId
} from "../shared/domain";

type Env = {
  DB: D1Database;
  INSTAGRAM_ACCESS_TOKEN: string;
  INSTAGRAM_USER_ID: string;
  INSTAGRAM_GRAPH_BASE_URL?: string;
  OPENAI_API_KEY: string;
  OPENAI_MODEL?: string;
  AUTO_APPLY_MIN_CONFIDENCE?: string;
  MAX_MEDIA_PER_RUN?: string;
  RUN_TOKEN?: string;
  META_WEBHOOK_VERIFY_TOKEN?: string;
  META_APP_SECRET?: string;
};

type InstagramMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp?: string;
  children?: {
    data?: Array<{
      media_type?: string;
      media_url?: string;
      thumbnail_url?: string;
    }>;
  };
};

type Classification = {
  shouldUpdate: boolean;
  memberId: MemberId | null;
  cellId: CellId | null;
  value: string;
  confidence: number;
  evidence: string;
};

type SyncSummary = {
  status: "success" | "error";
  postsSeen: number;
  postsApplied: number;
  postsSkipped: number;
  errors: string[];
};

const STATE_ID = "default";
const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com/v25.0";
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const DEFAULT_MIN_CONFIDENCE = 0.72;
const DEFAULT_MAX_MEDIA = 8;

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncInstagram(env, "cron"));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/run") {
      if (!isAuthorizedRun(request, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      const summary = await syncInstagram(env, "manual");
      return jsonResponse(summary, summary.status === "success" ? 200 : 500);
    }

    if (url.pathname === "/instagram/webhook") {
      if (request.method === "GET") {
        return verifyWebhook(url, env);
      }

      if (request.method === "POST") {
        if (!(await verifyMetaSignature(request, env))) {
          return jsonResponse({ error: "Invalid signature" }, 401);
        }

        ctx.waitUntil(syncInstagram(env, "webhook"));
        return jsonResponse({ ok: true });
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};

export async function syncInstagram(env: Env, triggerType: string): Promise<SyncSummary> {
  const runId = await createRun(env.DB, triggerType);
  const summary: SyncSummary = {
    status: "success",
    postsSeen: 0,
    postsApplied: 0,
    postsSkipped: 0,
    errors: []
  };

  try {
    assertConfigured(env);
    const mediaItems = (await fetchRecentMedia(env)).sort(compareMediaTimestamp);
    summary.postsSeen = mediaItems.length;

    for (const media of mediaItems) {
      const alreadyProcessed = await isProcessed(env.DB, media.id);

      if (alreadyProcessed) {
        summary.postsSkipped += 1;
        continue;
      }

      try {
        const classification = await classifyMedia(env, media);
        const result = await maybeApplyClassification(env.DB, env, classification);
        await recordProcessedPost(env.DB, media, classification, result.status);

        if (result.status === "applied") {
          summary.postsApplied += 1;
        } else {
          summary.postsSkipped += 1;
        }
      } catch (error) {
        summary.postsSkipped += 1;
        const message = errorMessage(error);
        summary.errors.push(`${media.id}: ${message}`);
        await recordProcessedPost(env.DB, media, null, "error", message);
      }
    }
  } catch (error) {
    summary.status = "error";
    summary.errors.push(errorMessage(error));
  }

  await finishRun(env.DB, runId, summary);
  return summary;
}

async function fetchRecentMedia(env: Env): Promise<InstagramMedia[]> {
  const url = new URL(`${graphBaseUrl(env)}/${env.INSTAGRAM_USER_ID}/media`);
  url.searchParams.set(
    "fields",
    "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,children{media_type,media_url,thumbnail_url}"
  );
  url.searchParams.set("limit", String(maxMediaPerRun(env)));
  url.searchParams.set("access_token", env.INSTAGRAM_ACCESS_TOKEN);

  const response = await fetch(url.toString(), {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Instagram API failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as { data?: InstagramMedia[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

async function classifyMedia(env: Env, media: InstagramMedia): Promise<Classification> {
  const imageUrl = mediaImageUrl(media);

  if (!imageUrl) {
    return {
      shouldUpdate: false,
      memberId: null,
      cellId: null,
      value: "",
      confidence: 0,
      evidence: "No image URL available"
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: classificationPrompt(media.caption || "") },
            { type: "input_image", image_url: imageUrl }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "bingo_instagram_classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              shouldUpdate: { type: "boolean" },
              memberId: { type: ["string", "null"] },
              cellId: { type: ["string", "null"] },
              value: { type: "string" },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              evidence: { type: "string" }
            },
            required: ["shouldUpdate", "memberId", "cellId", "value", "confidence", "evidence"]
          }
        }
      },
      max_output_tokens: 500
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI classification failed: ${response.status} ${await response.text()}`);
  }

  return normalizeClassification(extractOutputText(await response.json()));
}

async function maybeApplyClassification(db: D1Database, env: Env, classification: Classification) {
  if (
    !classification.shouldUpdate ||
    !classification.cellId ||
    !classification.memberId ||
    classification.confidence < minConfidence(env) ||
    !classification.value
  ) {
    return { status: "skipped" as const };
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
  return { status: "applied" as const };
}

function classificationPrompt(caption: string) {
  return [
    "Instagram投稿の画像とキャプションから、ビンゴのどのマスを誰がどんな値で埋めたかを判定してください。",
    "明確に判断できない場合は shouldUpdate=false にしてください。",
    "memberId は次から選択: " + members.map((member) => `${member.id}=${member.name}`).join(", "),
    "cellId は次から選択: " + cells.map((cell) => `${cell.id}=${cell.title}`).join(", "),
    "value は画面に表示する短い値だけにしてください。例や説明文は不要です。",
    "caption:",
    caption
  ].join("\n");
}

function normalizeClassification(outputText: string): Classification {
  const parsed = JSON.parse(outputText) as Partial<Classification>;
  const memberId = isMemberId(parsed.memberId) ? parsed.memberId : null;
  const cellId = isCellId(parsed.cellId) ? parsed.cellId : null;
  const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;

  return {
    shouldUpdate: parsed.shouldUpdate === true,
    memberId,
    cellId,
    value: typeof parsed.value === "string" ? parsed.value : "",
    confidence,
    evidence: typeof parsed.evidence === "string" ? parsed.evidence : ""
  };
}

function extractOutputText(payload: unknown): string {
  const record = payload as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: string }> }> };

  if (typeof record.output_text === "string") {
    return record.output_text;
  }

  const text = record.output
    ?.flatMap((item) => item.content || [])
    .map((item) => item.text)
    .filter(Boolean)
    .join("");

  if (!text) {
    throw new Error("OpenAI response did not include text output");
  }

  return text;
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
  media: InstagramMedia,
  classification: Classification | null,
  status: string,
  error = ""
) {
  await db
    .prepare(
      `INSERT OR REPLACE INTO instagram_processed_posts
        (post_id, status, media_url, permalink, caption, classification, error, processed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))`
    )
    .bind(
      media.id,
      status,
      mediaImageUrl(media),
      media.permalink || "",
      media.caption || "",
      classification ? JSON.stringify(classification) : "",
      error
    )
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

function compareMediaTimestamp(a: InstagramMedia, b: InstagramMedia) {
  return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
}

function mediaImageUrl(media: InstagramMedia) {
  if (media.media_type === "VIDEO" || media.media_type === "REELS") {
    return media.thumbnail_url || media.media_url || "";
  }

  if (media.media_type === "CAROUSEL_ALBUM") {
    const child = media.children?.data?.find((item) => item.media_url || item.thumbnail_url);
    return child?.media_url || child?.thumbnail_url || "";
  }

  return media.media_url || media.thumbnail_url || "";
}

function graphBaseUrl(env: Env) {
  return (env.INSTAGRAM_GRAPH_BASE_URL || DEFAULT_GRAPH_BASE_URL).replace(/\/$/, "");
}

function maxMediaPerRun(env: Env) {
  const value = Number(env.MAX_MEDIA_PER_RUN || DEFAULT_MAX_MEDIA);
  return Number.isFinite(value) ? Math.max(1, Math.min(25, value)) : DEFAULT_MAX_MEDIA;
}

function minConfidence(env: Env) {
  const value = Number(env.AUTO_APPLY_MIN_CONFIDENCE || DEFAULT_MIN_CONFIDENCE);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_MIN_CONFIDENCE;
}

function assertConfigured(env: Env) {
  const missing = [
    ["INSTAGRAM_ACCESS_TOKEN", env.INSTAGRAM_ACCESS_TOKEN],
    ["INSTAGRAM_USER_ID", env.INSTAGRAM_USER_ID],
    ["OPENAI_API_KEY", env.OPENAI_API_KEY]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required secrets: ${missing.join(", ")}`);
  }
}

function isAuthorizedRun(request: Request, env: Env) {
  if (!env.RUN_TOKEN) {
    return false;
  }

  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return bearer === env.RUN_TOKEN;
}

function verifyWebhook(url: URL, env: Env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token && token === env.META_WEBHOOK_VERIFY_TOKEN && challenge) {
    return new Response(challenge, {
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  return jsonResponse({ error: "Webhook verification failed" }, 403);
}

async function verifyMetaSignature(request: Request, env: Env) {
  if (!env.META_APP_SECRET) {
    return false;
  }

  const signature = request.headers.get("x-hub-signature-256");

  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const body = await request.clone().arrayBuffer();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.META_APP_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, body);
  const expected = `sha256=${hex(digest)}`;
  return timingSafeEqual(signature, expected);
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let index = 0; index < a.length; index += 1) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return result === 0;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
