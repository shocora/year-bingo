CREATE TABLE IF NOT EXISTS instagram_processed_posts (
  post_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  media_url TEXT,
  permalink TEXT,
  caption TEXT,
  classification TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS instagram_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  posts_seen INTEGER NOT NULL DEFAULT 0,
  posts_applied INTEGER NOT NULL DEFAULT 0,
  posts_skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT
);
