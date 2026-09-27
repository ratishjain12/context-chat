-- Set when a long document gets chunked + embedded into Vectorize, so the
-- orphan cleanup job can reconstruct exact vector ids (attachmentId-0..N-1)
-- to delete without enumerating the whole index.
ALTER TABLE attachments ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 0;
