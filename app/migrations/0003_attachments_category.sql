-- Stored at upload time (derived from the validated file extension) so the
-- queue consumer can route by category without re-deriving it from mime_type.
ALTER TABLE attachments ADD COLUMN category TEXT NOT NULL DEFAULT 'document';
