import { DurableObject } from "cloudflare:workers";
import type { FileCategory } from "../shared/file-types.js";
import { searchDocuments } from "./rag.js";
import { DEFAULT_MODEL, findModel, isValidModel, isWorkersAIModel } from "../shared/models.js";
import { rankAlternatives, resolveModel } from "../shared/model-routing.js";
import {
  AttemptError,
  circuitKey,
  classifyGatewayResponse,
  classifyThrown,
  parseChatStream,
  providerOf,
  withAbort,
} from "./llm.js";
import type { CircuitState } from "./provider-health.js";

// Cheapest catalog text model; titling is a side task.
const TITLE_MODEL = "@cf/meta/llama-3.2-1b-instruct";
const TITLE_MAX_LENGTH = 60;

const GATEWAY_ID = "default";
const HISTORY_LIMIT = 20;

// Real calls per reply. The order comes from rankAlternatives; the Workers AI
// share guarantees an external pick still reaches the floor. Account-level
// failures (no credits, plan-gated model) come back fast and open a circuit,
// so they don't spend budget -- only MAX_CALLS bounds them.
const ATTEMPT_BUDGET = { external: 3, workersAI: 2 };
const MAX_CALLS = 8;
const RETRY_DELAY_MS = { min: 400, max: 1200 };

// Reasoning models stream a role chunk, then go quiet while thinking.
const FIRST_CHUNK_TIMEOUT_MS = 45_000;
const IDLE_CHUNK_TIMEOUT_MS = 120_000;

// GPT-5 rejects `max_tokens`, and reasoning tokens share the output budget --
// at 2048 it can spend everything thinking and return nothing.
const MAX_OUTPUT_TOKENS = 2048;
const MAX_OUTPUT_TOKENS_REASONING = 8192;

// In-progress reply text is checkpointed to DO storage at most this often, so
// a restart mid-stream (deploy, eviction) can still save what was generated.
const CHECKPOINT_INTERVAL_MS = 3000;
const CHECKPOINT_KEY = "reply_in_progress";

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
  requested_model: string | null;
  fallback_reason: string | null;
  created_at: number;
  attachments?: AttachmentInfo[];
}

type ChatTurn = {
  role: string;
  content: string | { type: string; text?: string; image_url?: { url: string } }[];
};

interface ReplyInProgress {
  threadId: string;
  id: string;
  content: string;
  model: string;
  requestedModel: string;
}

type OutboundEvent =
  | { type: "message"; message: ChatMessage }
  | { type: "delta"; id: string; content: string }
  | { type: "in_progress"; id: string; content: string }
  | { type: "thread_title"; threadId: string; title: string };

// One instance per thread (env.CHAT_THREAD.getByName(threadId)). Owns
// WebSocket fanout and the in-flight reply; D1 stays the system of record.
export class ChatThreadDO extends DurableObject<Env> {
  private reply: ReplyInProgress | null = null;
  private lastCheckpointAt = 0;
  private recovered: ChatMessage | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => this.recoverInterruptedReply());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    // A client (re)connecting mid-reply gets the text so far, then the live
    // deltas that follow -- the reply resumes instead of starting mid-sentence.
    if (this.reply) {
      server.send(
        JSON.stringify({ type: "in_progress", id: this.reply.id, content: this.reply.content })
      );
    } else if (this.recovered) {
      server.send(JSON.stringify({ type: "message", message: this.recovered }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") {
      return;
    }

    const threadId = this.ctx.id.name;
    if (!threadId) {
      return;
    }

    const { content, attachmentIds, model } = JSON.parse(raw) as IncomingMessage;
    const userMessage = await this.persistMessage(threadId, "user", content, attachmentIds);
    this.broadcast({ type: "message", message: userMessage });

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

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1005/1006 mean "no code received" and are invalid to send back.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  // Only on the thread's first message -- a title is a stable label.
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

  private async generateReply(
    threadId: string,
    latestContent: string,
    model: string,
    attachmentIds: string[]
  ): Promise<void> {
    const [history, context, imageParts, circuits] = await Promise.all([
      this.getHistory(threadId),
      this.buildContext(threadId, latestContent),
      this.buildImageParts(attachmentIds),
      this.loadCircuits(),
    ]);

    // Same rule as the picker, enforced here against stale clients.
    const needs = { vision: imageParts.length > 0 };
    const requested = resolveModel(model, needs);
    const preFallbackReason = requested !== model ? "no image support" : null;

    const turns: ChatTurn[] = history;
    if (needs.vision) {
      const last = turns[turns.length - 1];
      turns[turns.length - 1] = {
        role: last.role,
        content: [{ type: "text", text: last.content as string }, ...imageParts],
      };
    }
    const messages: ChatTurn[] = [
      { role: "system", content: context ?? "You are a helpful assistant." },
      ...turns,
    ];

    this.reply = { threadId, id: crypto.randomUUID(), content: "", model: requested, requestedModel: model };
    const reply = this.reply;
    // Record the reply as started; lastCheckpointAt = 0 so the first chunk is saved too.
    this.ctx.storage.kv.put(CHECKPOINT_KEY, reply);
    this.lastCheckpointAt = 0;
    let answeredBy: string | null = null;
    const failures: { model: string; reason: string }[] = [];
    const budget = { ...ATTEMPT_BUDGET };
    let calls = 0;
    const chain = [requested, ...rankAlternatives(requested, needs).map((m) => m.id)];

    for (const candidate of chain) {
      const platform = isWorkersAIModel(candidate) ? "workersAI" : "external";
      if ((budget.external === 0 && budget.workersAI === 0) || calls === MAX_CALLS) {
        break;
      }
      if (budget[platform] === 0) {
        continue;
      }
      const blocked = await this.openCircuit(candidate, circuits);
      if (blocked) {
        if (candidate === requested) {
          failures.push({ model: candidate, reason: blocked.reason });
        }
        continue;
      }
      calls++;
      reply.model = candidate;

      let failure = await this.attempt(candidate, messages, threadId, model);
      // One same-model retry for transient errors (429/5xx) before moving on
      // -- only if nothing has streamed yet.
      if (failure?.retryable && !reply.content.trim()) {
        await sleep(RETRY_DELAY_MS.min + Math.random() * (RETRY_DELAY_MS.max - RETRY_DELAY_MS.min));
        failure = await this.attempt(candidate, messages, threadId, model);
      }

      if (!failure) {
        answeredBy = candidate;
        for (const key of [providerOf(candidate), `model:${candidate}`]) {
          if (circuits[key]) {
            await this.health()
              .recordSuccess(key)
              .catch(() => {});
          }
        }
        break;
      }

      // Text already reached the user -- switching models would duplicate or
      // contradict it, so keep what arrived and say so.
      if (reply.content.trim()) {
        reply.content += `\n\n_Response interrupted: ${failure.reason}._`;
        answeredBy = candidate;
        break;
      }
      reply.content = "";
      if (failure.providerLevel || failure.modelLevel) {
        const key = circuitKey(candidate, failure);
        circuits[key] = await this.health()
          .recordFailure(key, failure.reason)
          .catch(() => ({ failures: 1, reason: failure.reason, openUntil: Date.now() + 5 * 60_000 }));
      } else {
        budget[platform]--;
      }
      failures.push({ model: candidate, reason: failure.reason });
    }

    const content = answeredBy
      ? reply.content
      : `Couldn't get a response from any model:\n${failures
          .map((f) => `- ${f.model}: ${f.reason}`)
          .join("\n")}`;
    const fallbackReason = !answeredBy
      ? "all models failed"
      : (preFallbackReason ?? (answeredBy !== model ? (failures[0]?.reason ?? null) : null));

    try {
      const assistantMessage = await this.persistMessage(threadId, "assistant", content, undefined, reply.id, {
        model: answeredBy ?? requested,
        requestedModel: model,
        fallbackReason,
      });
      this.broadcast({ type: "message", message: assistantMessage });
    } finally {
      this.reply = null;
      this.ctx.storage.kv.delete(CHECKPOINT_KEY);
    }
  }

  // Streams one call into this.reply; resolves null on success, or the
  // classified failure. Never throws.
  private async attempt(
    model: string,
    messages: ChatTurn[],
    threadId: string,
    requestedModel: string
  ): Promise<AttemptError | null> {
    const reply = this.reply!;
    try {
      for await (const chunk of this.streamCompletion(model, messages, { threadId, requestedModel })) {
        reply.content += chunk;
        this.broadcast({ type: "delta", id: reply.id, content: chunk });
        this.checkpoint();
      }
      return reply.content.trim() ? null : new AttemptError("empty response");
    } catch (err) {
      const failure = err instanceof AttemptError ? err : classifyThrown(err);
      console.error(
        JSON.stringify({
          message: "AI attempt failed",
          threadId,
          model,
          requestedModel,
          reason: failure.reason,
          retryable: failure.retryable,
          detail: failure.detail ?? failure.message,
          streamedChars: reply.content.length,
        })
      );
      return failure;
    }
  }

  // Workers AI via env.AI.run; external providers via AI Gateway's compat
  // endpoint, which speaks OpenAI chat format for every provider (env.AI.run
  // would need each provider's native shape). BYOK: the gateway injects the
  // key stored under the `default` alias.
  private async *streamCompletion(
    model: string,
    messages: ChatTurn[],
    metadata: Record<string, string>
  ): AsyncGenerator<string> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), ms);
    };

    arm(FIRST_CHUNK_TIMEOUT_MS);
    try {
      let stream: ReadableStream;
      if (isWorkersAIModel(model)) {
        // A runtime model string can't select env.AI.run's per-model overloads.
        stream = (await withAbort(
          this.env.AI.run(
            model,
            { messages, stream: true, max_tokens: MAX_OUTPUT_TOKENS },
            { gateway: { id: GATEWAY_ID, metadata } }
          ),
          abort.signal
        )) as unknown as ReadableStream;
      } else {
        const tokenParam = model.startsWith("openai/") ? "max_completion_tokens" : "max_tokens";
        const res = await this.env.AI.gateway(GATEWAY_ID).run(
          {
            provider: "compat",
            endpoint: "chat/completions",
            headers: { "Content-Type": "application/json", "cf-aig-metadata": metadata },
            query: {
              model,
              messages,
              stream: true,
              [tokenParam]: findModel(model)?.reasoning ? MAX_OUTPUT_TOKENS_REASONING : MAX_OUTPUT_TOKENS,
            },
          },
          { signal: abort.signal }
        );
        if (!res.ok || !res.body) {
          throw classifyGatewayResponse(res.status, await res.text().catch(() => ""));
        }
        stream = res.body;
      }

      for await (const chunk of parseChatStream(stream, abort.signal)) {
        arm(IDLE_CHUNK_TIMEOUT_MS);
        yield chunk;
      }
    } catch (err) {
      if (abort.signal.aborted) {
        throw new AttemptError("timed out");
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private health() {
    return this.env.PROVIDER_HEALTH.getByName("global");
  }

  // Circuit-breaker state is advisory: if the health DO is unreachable, try
  // every provider rather than fail the reply.
  private async loadCircuits(): Promise<Record<string, CircuitState>> {
    try {
      return await this.health().snapshot();
    } catch {
      return {};
    }
  }

  // The open circuit blocking `model` (its provider's or its own), if any.
  // Past openUntil it's half-open: one caller at a time gets a probe.
  private async openCircuit(
    model: string,
    circuits: Record<string, CircuitState>
  ): Promise<CircuitState | null> {
    for (const key of [providerOf(model), `model:${model}`]) {
      const state = circuits[key];
      if (!state) {
        continue;
      }
      if (state.openUntil > Date.now()) {
        return state;
      }
      const probe = await this.health()
        .claimProbe(key)
        .catch(() => true);
      if (!probe) {
        return state;
      }
    }
    return null;
  }

  private checkpoint(): void {
    const now = Date.now();
    if (this.reply && now - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      this.ctx.storage.kv.put(CHECKPOINT_KEY, this.reply);
      this.lastCheckpointAt = now;
    }
  }

  // A checkpoint left behind means the DO restarted mid-reply: persist what
  // was generated so the thread doesn't just lose the answer.
  private async recoverInterruptedReply(): Promise<void> {
    const saved = this.ctx.storage.kv.get<ReplyInProgress>(CHECKPOINT_KEY);
    if (!saved) {
      return;
    }
    try {
      this.recovered = await this.persistMessage(
        saved.threadId,
        "assistant",
        saved.content.trim()
          ? `${saved.content}\n\n_Response interrupted: the server restarted mid-reply._`
          : "_No response: the server restarted before the model replied. Please resend._",
        undefined,
        saved.id,
        { model: saved.model, requestedModel: saved.requestedModel, fallbackReason: null }
      );
    } catch (err) {
      // Already persisted before the restart (duplicate id) -- nothing to do.
      console.error(
        JSON.stringify({
          message: "reply recovery skipped",
          threadId: saved.threadId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }
    this.ctx.storage.kv.delete(CHECKPOINT_KEY);
  }

  private async getHistory(threadId: string): Promise<{ role: string; content: string }[]> {
    const { results } = await this.env.DB.prepare(
      "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?"
    )
      .bind(threadId, HISTORY_LIMIT)
      .all<{ role: string; content: string }>();

    return results.reverse();
  }

  // image_url only accepts data URIs, not plain HTTP URLs.
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

  // Short documents inline, plus the top semantic matches from long ones.
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
      // No score threshold: results are already thread-scoped, and broad
      // queries ("explain each tool in this") score low even on the right chunks.
      const matches = await searchDocuments(this.env, threadId, query, 3);
      for (const match of matches) {
        parts.push(match.text);
      }
    } catch {
      // Vectorize/embedding hiccup -- answer with whatever inline context exists.
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
    routing?: { model: string; requestedModel: string; fallbackReason: string | null }
  ): Promise<ChatMessage> {
    const id = explicitId ?? crypto.randomUUID();
    const row = await this.env.DB.prepare(
      "INSERT INTO messages (id, thread_id, role, content, model, requested_model, fallback_reason) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, thread_id, role, content, model, requested_model, fallback_reason, created_at"
    )
      .bind(
        id,
        threadId,
        role,
        content,
        routing?.model ?? null,
        routing?.requestedModel ?? null,
        routing?.fallbackReason ?? null
      )
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Small models wrap titles in quotes or add a trailing period despite the prompt.
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

// Chunked: spreading a multi-MB buffer into String.fromCharCode overflows the stack.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
