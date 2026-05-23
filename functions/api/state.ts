import {
  applyAction,
  createEmptyPlacements,
  parseAction,
  sanitizePlacements,
  type BingoAction,
  type Placements
} from "../../shared/domain";

type Env = {
  DB: D1Database;
};

type StoredState = {
  placements: Placements;
  version: number;
  updatedAt: string;
};

const STATE_ID = "default";
const MAX_BODY_BYTES = 4096;

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: jsonHeaders });
  }

  if (request.method === "GET") {
    return jsonResponse(await getStoredState(env.DB));
  }

  if (request.method === "PATCH") {
    const action = await readAction(request);

    if (!action) {
      return jsonResponse({ error: "Invalid action" }, 400);
    }

    const storedState = await getStoredState(env.DB);
    const nextPlacements = applyAction(storedState.placements, action);
    const nextState = await savePlacements(env.DB, nextPlacements);

    return jsonResponse(nextState);
  }

  return jsonResponse({ error: "Method not allowed" }, 405, {
    allow: "GET, PATCH, OPTIONS"
  });
};

async function readAction(request: Request): Promise<BingoAction | null> {
  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().includes("application/json")) {
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
    return parseAction(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

async function getStoredState(db: D1Database): Promise<StoredState> {
  const row = await db
    .prepare("SELECT data, version, updated_at FROM bingo_state WHERE id = ?1")
    .bind(STATE_ID)
    .first<{ data: string; version: number; updated_at: string }>();

  if (!row) {
    const placements = createEmptyPlacements();
    await db
      .prepare("INSERT INTO bingo_state (id, data, version, updated_at) VALUES (?1, ?2, 1, datetime('now'))")
      .bind(STATE_ID, JSON.stringify(placements))
      .run();

    return getStoredState(db);
  }

  return {
    placements: sanitizePlacements(JSON.parse(row.data)),
    version: row.version,
    updatedAt: row.updated_at
  };
}

async function savePlacements(db: D1Database, placements: Placements): Promise<StoredState> {
  await db
    .prepare(
      "UPDATE bingo_state SET data = ?1, version = version + 1, updated_at = datetime('now') WHERE id = ?2"
    )
    .bind(JSON.stringify(placements), STATE_ID)
    .run();

  return getStoredState(db);
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
