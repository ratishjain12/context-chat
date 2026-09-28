-- Images need no processing so they're immediately usable; documents/data
-- go through the extraction queue and aren't usable until that finishes.
-- The frontend polls this to know when it's safe to let the user send.
ALTER TABLE attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
