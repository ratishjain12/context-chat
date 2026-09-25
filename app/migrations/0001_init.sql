-- id column is TEXT everywhere so it can hold either a crypto.randomUUID()
-- or, once Cloudflare Access is wired up (Step 8), the Access-authenticated
-- user's email/sub directly -- no separate mapping table needed.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Sorts a user's thread list by recency without a full-table scan.
CREATE INDEX idx_threads_user_updated ON threads(user_id, updated_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Fetches one thread's messages in order without scanning the whole table.
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_attachments_message ON attachments(message_id);

-- cost_micro_usd: cost in millionths of a dollar (integer) to avoid float
-- rounding drift when summing many rows.
CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  thread_id TEXT REFERENCES threads(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_usage_user_created ON usage(user_id, created_at);
