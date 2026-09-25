import { DurableObject } from "cloudflare:workers";
import type { FileCategory } from "./file-types.js";
import { searchDocuments } from "./rag.js";

// Routed through AI Gateway ("default" -- auto-creates on first request, no
// dashboard step needed; a custom-named gateway would require one). Workers
// AI model, not an external provider -- zero extra API keys to add
// OpenAI/Anthropic/Gemini later, add their key as a secret and call their
// AI Gateway provider route instead of env.AI.run() for this specific model.
const CHAT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const GATEWAY_ID = "default";
const HISTORY_LIMIT = 20;
const RAG_MATCH_THRESHOLD = 0.5;

interface IncomingMessage {
  content: string;
  attachmentIds?: string[];
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

    const { content, attachmentIds } = JSON.parse(raw) as IncomingMessage;
    const userMessage = await this.persistMessage(threadId, "user", content, attachmentIds);
    this.broadcast({ type: "message", message: userMessage });

    await this.generateReply(threadId, content);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  private async generateReply(threadId: string, latestContent: string): Promise<void> {
    const [history, context] = await Promise.all([
      this.getHistory(threadId),
      this.buildContext(threadId, latestContent),
    ]);

    const messages = [
      { role: "system", content: context ?? "You are a helpful assistant." },
      ...history,
    ];

    const assistantId = crypto.randomUUID();
    let fullText = "";

    try {
      const stream = (await this.env.AI.run(
        CHAT_MODEL,
        { messages, stream: true },
        { gateway: { id: GATEWAY_ID } }
      )) as ReadableStream;

      for await (const chunk of parseSSE(stream)) {
        fullText += chunk;
        this.broadcast({ type: "delta", id: assistantId, content: chunk });
      }
    } catch (err) {
      fullText = "Sorry, something went wrong generating a response.";
      console.error(
        JSON.stringify({
          message: "AI generation failed",
          threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    const assistantMessage = await this.persistMessage(
      threadId,
      "assistant",
      fullText,
      undefined,
      assistantId
    );
    this.broadcast({ type: "message", message: assistantMessage });
  }

  private async getHistory(
    threadId: string
  ): Promise<{ role: string; content: string }[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?"
    )
      .bind(threadId, HISTORY_LIMIT)
      .all<{ role: string; content: string }>();

    return results.reverse();
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
    explicitId?: string
  ): Promise<ChatMessage> {
    const id = explicitId ?? crypto.randomUUID();
    const row = await this.env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, ?, ?) RETURNING id, thread_id, role, content, created_at"
    )
      .bind(id, threadId, role, content)
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
