import { DurableObject } from "cloudflare:workers";
import type { FileCategory } from "../shared/file-types.js";
import { searchDocuments } from "./rag.js";
import { DEFAULT_MODEL, findModel, isValidModel } from "../shared/models.js";

// Fallback when the selected model can't handle images -- the one vision
// model we've actually verified end-to-end (Step 7), not just inferred from
// a catalog description like the rest of the vision-flagged models.
const VERIFIED_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

// Titling is a side task, not the conversation itself -- cheapest text
// model in the catalog ($0.027/M in, $0.201/M out) rather than whatever
// the user picked for the actual chat.
const TITLE_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const TITLE_MAX_LENGTH = 60;

// Routed through AI Gateway ("default" -- auto-creates on first request, no
// dashboard step needed; a custom-named gateway would require one).
const GATEWAY_ID = "default";
const HISTORY_LIMIT = 20;

interface IncomingMessage {
  content: string;
  attachmentIds?: string[];
  model?: string;
}

interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  category: FileCategory;
}

interface ChatMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  model: string | null;
  created_at: number;
  attachments?: AttachmentInfo[];
}

type OutboundEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; id: string; content: string }
  | { type: "thread_title"; threadId: string; title: string };

// One instance per thread (routed via env.CHAT_THREAD.getByName(threadId)).
// Owns WebSocket fanout + message ordering for that thread; D1 stays the
// system of record so cross-thread queries (thread list, search) still work.
export class ChatThreadDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }

    // this.ctx.id.name is the threadId, preserved because the stub was
    // created with getByName(threadId) rather than newUniqueId().
    const threadId = this.ctx.id.name;
    if (!threadId) {
      return;
    }

    const { content, attachmentIds, model } = JSON.parse(raw) as IncomingMessage;
    const userMessage = await this.persistMessage(threadId, "user", content, attachmentIds);
    this.broadcast({ type: "message", message: userMessage });

    // Run concurrently, not sequentially -- titling is a side effect that
    // shouldn't delay the reply the user is actually waiting on.
    await Promise.all([
      this.maybeGenerateTitle(threadId, content),
      this.generateReply(
        threadId,
        content,
        model && isValidModel(model) ? model : DEFAULT_MODEL,
        attachmentIds ?? []
      ),
    ]);
  }

  // Only fires once, on the thread's first message -- a title is a stable
  // sidebar label, not a running summary that should keep changing as the
  // conversation grows.
  private async maybeGenerateTitle(threadId: string, firstMessage: string): Promise<void> {
    if (!firstMessage.trim()) {
      return;
    }

    const row = await this.env.DB.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE thread_id = ?"
    )
      .bind(threadId)
      .first<{ count: number }>();
    if (row?.count !== 1) {
      return;
    }

    try {
      const { response } = await this.env.AI.run(
        TITLE_MODEL,
        {
          messages: [
            {
              role: "system",
              content:
                "Summarize the user's message as a short chat title: 3-6 words, plain text, no punctuation, no quotes.",
            },
            { role: "user", content: firstMessage },
          ],
          max_tokens: 16,
        },
        { gateway: { id: GATEWAY_ID } }
      );

      const title = cleanTitle(response);
      if (!title) {
        return;
      }

      await this.env.DB.prepare("UPDATE threads SET title = ? WHERE id = ?")
        .bind(title, threadId)
        .run();
      this.broadcast({ type: "thread_title", threadId, title });
    } catch (err) {
      console.error(
        JSON.stringify({
          message: "title generation failed",
          threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  private async generateReply(
    threadId: string,
    latestContent: string,
    model: string,
    attachmentIds: string[]
  ): Promise<void> {
    const [history, context, imageParts] = await Promise.all([
      this.getHistory(threadId),
      this.buildContext(threadId, latestContent),
      this.buildImageParts(attachmentIds),
    ]);

    // A model without vision support cannot see an image -- if the selected
    // model doesn't have it, fall back to the one we've actually verified
    // rather than send images to a model that will just ignore them.
    const effectiveModel =
      imageParts.length > 0 && !findModel(model)?.vision ? VERIFIED_VISION_MODEL : model;

    type ChatTurn = {
      role: string;
      content: string | { type: string; text?: string; image_url?: { url: string } }[];
    };
    const turns: ChatTurn[] = history;

    if (imageParts.length > 0) {
      const last = turns[turns.length - 1];
      turns[turns.length - 1] = {
        role: last.role,
        content: [{ type: "text", text: last.content as string }, ...imageParts],
      };
    }

    const messages = [
      { role: "system", content: context ?? "You are a helpful assistant." },
      ...turns,
    ];

    const assistantId = crypto.randomUUID();
    let fullText = "";

    try {
      // env.AI.run()'s overloads resolve per literal model id; a dynamic
      // model string (switchable at runtime) can't select one statically.
      // Without an explicit max_tokens, several catalog models default to a
      // low cap (well under what a multi-paragraph answer needs) and just
      // stop mid-sentence with no error -- not a stream bug, a token limit.
      const stream = (await this.env.AI.run(
        effectiveModel,
        { messages, stream: true, max_tokens: 2048 },
        { gateway: { id: GATEWAY_ID } }
      )) as unknown as ReadableStream;

      for await (const chunk of parseSSE(stream)) {
        fullText += chunk;
        this.broadcast({ type: "delta", id: assistantId, content: chunk });
      }
    } catch (err) {
      // Surface the real reason (e.g. "not available on the Workers Free
      // plan") rather than a generic message -- not every one of the 30+
      // catalog models is actually available on every account/plan tier,
      // and the user needs to know that to pick a different one, not just
      // that "something" failed.
      const reason = err instanceof Error ? err.message : String(err);
      fullText = `Couldn't get a response from this model: ${reason}`;
      console.error(
        JSON.stringify({
          message: "AI generation failed",
          threadId,
          model: effectiveModel,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    const assistantMessage = await this.persistMessage(
      threadId,
      "assistant",
      fullText,
      undefined,
      assistantId,
      effectiveModel
    );
    this.broadcast({ type: "message", message: assistantMessage });
  }

  private async getHistory(threadId: string): Promise<{ role: string; content: string }[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?"
    )
      .bind(threadId, HISTORY_LIMIT)
      .all<{ role: string; content: string }>();

    return results.reverse();
  }

  // Images upload to R2 before the message is sent (Step 4's upload-before-
  // send flow), so by the time we're generating a reply they're already
  // there -- just fetch the bytes and base64-encode as a data URI (the
  // vision model's image_url field requires a data URI; plain HTTP URLs
  // are rejected).
  private async buildImageParts(
    attachmentIds: string[]
  ): Promise<{ type: string; image_url: { url: string } }[]> {
    if (attachmentIds.length === 0) {
      return [];
    }

    const placeholders = attachmentIds.map(() => "?").join(",");
    const { results } = await this.env.DB.prepare(
      `SELECT r2_key, mime_type FROM attachments WHERE id IN (${placeholders}) AND category = 'image'`
    )
      .bind(...attachmentIds)
      .all<{ r2_key: string; mime_type: string }>();

    const parts: { type: string; image_url: { url: string } }[] = [];
    for (const row of results) {
      const object = await this.env.UPLOADS.get(row.r2_key);
      if (!object) {
        continue;
      }
      const base64 = arrayBufferToBase64(await object.arrayBuffer());
      parts.push({ type: "image_url", image_url: { url: `data:${row.mime_type};base64,${base64}` } });
    }
    return parts;
  }

  // Pulls in short-document text (always inlineable, per the file-format
  // policy) plus the top semantic matches from longer, embedded documents.
  private async buildContext(threadId: string, query: string): Promise<string | null> {
    const parts: string[] = [];

    const { results: inlineDocs } = await this.env.DB.prepare(
      "SELECT extracted_text FROM attachments WHERE thread_id = ? AND extracted_text IS NOT NULL"
    )
      .bind(threadId)
      .all<{ extracted_text: string }>();
    for (const doc of inlineDocs) {
      parts.push(doc.extracted_text);
    }

    try {
      // No score filter here -- searchDocuments is already scoped to this
      // thread's own attachments (Vectorize filter: { threadId }), so
      // there's no cross-document leakage to guard against. A broad
      // meta-query like "explain each tool in this" has weak literal
      // semantic overlap with the actual chunk text, so even the right
      // chunks can score well below a fixed similarity threshold --
      // dropping them there just means the model sees no context at all.
      const matches = await searchDocuments(this.env, threadId, query, 3);
      for (const match of matches) {
        parts.push(match.text);
      }
    } catch {
      // Embedding/Vectorize hiccup -- fall back to whatever inline context
      // is already available rather than failing the whole reply.
    }

    if (parts.length === 0) {
      return null;
    }
    return `You are a helpful assistant. Use the following context from the user's uploaded documents if relevant:\n\n${parts.join("\n---\n")}`;
  }

  private async persistMessage(
    threadId: string,
    role: ChatMessage["role"],
    content: string,
    attachmentIds?: string[],
    explicitId?: string,
    model?: string
  ): Promise<ChatMessage> {
    const id = explicitId ?? crypto.randomUUID();
    const row = await this.env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, content, model) VALUES (?, ?, ?, ?, ?) RETURNING id, thread_id, role, content, model, created_at"
    )
      .bind(id, threadId, role, content, model ?? null)
      .first<ChatMessage>();

    await this.env.DB.prepare(
      "UPDATE threads SET updated_at = (unixepoch() * 1000) WHERE id = ?"
    )
      .bind(threadId)
      .run();

    if (!row) {
      throw new Error("Failed to persist message");
    }

    if (attachmentIds && attachmentIds.length > 0) {
      row.attachments = await this.linkAttachments(id, threadId, attachmentIds);
    }

    return row;
  }

  private async linkAttachments(
    messageId: string,
    threadId: string,
    attachmentIds: string[]
  ): Promise<AttachmentInfo[]> {
    const placeholders = attachmentIds.map(() => "?").join(",");

    await this.env.DB.prepare(
      `UPDATE attachments SET message_id = ? WHERE thread_id = ? AND id IN (${placeholders})`
    )
      .bind(messageId, threadId, ...attachmentIds)
      .run();

    const { results } = await this.env.DB.prepare(
      `SELECT id, filename, mime_type, size_bytes, category FROM attachments WHERE message_id = ?`
    )
      .bind(messageId)
      .all<AttachmentInfo>();

    return results;
  }

  private broadcast(event: OutboundEvent): void {
    const payload = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }
}

// Small instruct models routinely wrap their answer in quotes or add a
// trailing period even when told not to -- strip that rather than showing
// `"Fix login bug"` verbatim in the sidebar.
function cleanTitle(response: string | undefined): string | null {
  if (!response) {
    return null;
  }
  const title = response
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.!]+$/, "")
    .trim();
  if (!title) {
    return null;
  }
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;
}

// btoa/String.fromCharCode can't take the whole buffer as spread args at
// once (blows the call stack for anything past a few tens of KB) -- chunk
// it. Avoids pulling in @types/node just for Buffer, which would conflict
// with Workers' own global fetch/Request/Response types.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Workers AI's streaming format: `data: {"response": "token"}\n\n` lines,
// terminated by `data: [DONE]`.
async function* parseSSE(stream: ReadableStream): AsyncGenerator<string> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice("data:".length).trim();
      if (data === "[DONE]") {
        return;
      }
      try {
        const parsed = JSON.parse(data) as { response?: string };
        if (parsed.response) {
          yield parsed.response;
        }
      } catch {
        // Skip malformed chunk rather than aborting the whole stream.
      }
    }
  }
}
