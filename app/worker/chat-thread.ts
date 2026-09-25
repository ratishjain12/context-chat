import { DurableObject } from "cloudflare:workers";
import type { FileCategory } from "./file-types.js";

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
    this.broadcast(userMessage);

    // Placeholder reply — real model streaming arrives in Step 7 (AI Gateway).
    const assistantMessage = await this.persistMessage(
      threadId,
      "assistant",
      `Echo: ${content}`
    );
    this.broadcast(assistantMessage);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  private async persistMessage(
    threadId: string,
    role: ChatMessage["role"],
    content: string,
    attachmentIds?: string[]
  ): Promise<ChatMessage> {
    const id = crypto.randomUUID();
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

  private broadcast(message: ChatMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      ws.send(payload);
    }
  }
}
