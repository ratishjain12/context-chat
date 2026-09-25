// @cf/baai/bge-base-en-v1.5: 768-dim, 512 max input tokens per string,
// $0.0666/M input tokens. Native Workers AI model -- same account as
// Vectorize, no external provider/API key. Picked over bge-small (lower
// quality) and bge-large (more compute for retrieval gains that matter at
// much bigger corpus sizes than this app's attachments).
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

// ~2000 tokens -- comfortably inlineable in a prompt without retrieval.
const INLINE_THRESHOLD_CHARS = 8000;

// Chars, not tokens -- kept well under the model's 512-token ceiling even for
// token-dense text (worst case ~1 token/char).
const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    if (end === text.length) {
      break;
    }
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

export interface IndexResult {
  mode: "inline" | "embedded";
  chunks?: number;
}

// Short text: store for direct inline use in the prompt at chat time.
// Long text: chunk, embed each chunk, store in Vectorize for retrieval.
export async function indexDocument(
  env: Env,
  attachmentId: string,
  threadId: string,
  text: string
): Promise<IndexResult> {
  if (text.length <= INLINE_THRESHOLD_CHARS) {
    await env.DB.prepare("UPDATE attachments SET extracted_text = ? WHERE id = ?")
      .bind(text, attachmentId)
      .run();
    return { mode: "inline" };
  }

  const chunks = chunkText(text);
  const result = await env.AI.run(EMBEDDING_MODEL, { text: chunks });
  if (!("data" in result) || !result.data) {
    throw new Error("Embedding request returned no data (unexpected async response)");
  }

  await env.VECTORIZE.insert(
    result.data.map((values, i) => ({
      id: `${attachmentId}-${i}`,
      values,
      metadata: { attachmentId, threadId, chunkIndex: i, text: chunks[i] },
    }))
  );

  return { mode: "embedded", chunks: chunks.length };
}

export interface SearchMatch {
  score: number;
  text: string;
  attachmentId: string;
}

export async function searchDocuments(
  env: Env,
  threadId: string,
  query: string,
  topK = 5
): Promise<SearchMatch[]> {
  const embedding = await env.AI.run(EMBEDDING_MODEL, { text: [query] });
  if (!("data" in embedding) || !embedding.data) {
    throw new Error("Embedding request returned no data (unexpected async response)");
  }

  const result = await env.VECTORIZE.query(embedding.data[0], {
    topK,
    filter: { threadId },
    returnMetadata: "all",
  });

  return result.matches.map((match) => ({
    score: match.score,
    text: String(match.metadata?.text ?? ""),
    attachmentId: String(match.metadata?.attachmentId ?? ""),
  }));
}
