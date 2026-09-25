-- Short documents (below the RAG threshold) get their extracted text stored
-- here for direct inline use in the prompt; long documents are chunked +
-- embedded into Vectorize instead and this stays NULL.
ALTER TABLE attachments ADD COLUMN extracted_text TEXT;
