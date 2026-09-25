-- Files upload to R2 before the chat message that references them exists
-- (user attaches a file, then sends the message) -- so message_id starts
-- NULL and gets linked once the message is actually created.
-- SQLite has no ALTER COLUMN for dropping NOT NULL; recreate the table
-- (safe -- no attachment rows exist yet).

DROP TABLE attachments;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT REFERENCES messages(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX idx_attachments_message ON attachments(message_id);
CREATE INDEX idx_attachments_thread ON attachments(thread_id);
