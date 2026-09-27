import { DurableObject } from "cloudflare:workers";
import type { FileCategory } from "../shared/file-types.js";
import { searchDocuments } from "./rag.js";
import { DEFAULT_MODEL, findModel, isValidModel } from "../shared/models.js";

// Fallback when the selected model can't handle images -- the one vision
// model we've actually verified end-to-end (Step 7), not just inferred from
// a catalog description like the rest of the vision-flagged models.
const VERIFIED_VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

// Routed through AI Gateway ("default" -- auto-creates on first request, no
// dashboard step needed; a custom-named gateway would require one).
const GATEWAY_ID = "default";
const HISTORY_LIMIT = 20;
const RAG_MATCH_THRESHOLD = 0.5;

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
  | { type: "delta"; id: string; content: string };

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

    await this.generateReply(
      threadId,
      content,
      model && isValidModel(model) ? model : DEFAULT_MODEL,
      attachmentIds ?? []
    );
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
      const stream = (await this.env.AI.run(
        effectiveModel,
        { messages, stream: true },
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
      const matches = await searchDocuments(this.env, threadId, query, 3);
      for (const match of matches) {
        if (match.score >= RAG_MATCH_THRESHOLD) {
          parts.push(match.text);
        }
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
