import { ChatThreadDO } from "./chat-thread.js";
import { ruleForFilename, type FileCategory } from "./file-types.js";
import { indexDocument, searchDocuments } from "./rag.js";

export { ChatThreadDO };

// TODO(step 8 - Access): replace with the authenticated user's id from the
// Cf-Access-Jwt-Assertion header instead of a hardcoded dev user.
const DEV_USER_ID = "dev-user";

interface Thread {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  category: FileCategory;
}

interface ThreadMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  model: string | null;
  created_at: number;
  attachments?: AttachmentInfo[];
}

async function listThreads(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, title, created_at, updated_at FROM threads WHERE user_id = ? ORDER BY updated_at DESC"
  )
    .bind(DEV_USER_ID)
    .all<Thread>();

  return Response.json(results);
}

async function createThread(request: Request, env: Env): Promise<Response> {
  const body = await request
    .json<{ title?: string }>()
    .catch((): { title?: string } => ({}));
  const id = crypto.randomUUID();
  const title = body.title?.trim() || "New chat";

  const thread = await env.DB.prepare(
    "INSERT INTO threads (id, user_id, title) VALUES (?, ?, ?) RETURNING id, title, created_at, updated_at"
  )
    .bind(id, DEV_USER_ID, title)
    .first<Thread>();

  return Response.json(thread, { status: 201 });
}

async function getThreadMessages(threadId: string, env: Env): Promise<Response> {
  const [{ results: messages }, { results: attachments }] = await Promise.all([
    env.DB.prepare(
      "SELECT id, thread_id, role, content, model, created_at FROM messages WHERE thread_id = ? ORDER BY created_at"
    )
      .bind(threadId)
      .all<ThreadMessage>(),
    env.DB.prepare(
      "SELECT id, message_id, filename, mime_type, size_bytes, category FROM attachments WHERE thread_id = ? AND message_id IS NOT NULL"
    )
      .bind(threadId)
      .all<AttachmentInfo & { message_id: string }>(),
  ]);

  for (const message of messages) {
    const forMessage = attachments.filter((a) => a.message_id === message.id);
    if (forMessage.length > 0) {
      message.attachments = forMessage.map(({ id, filename, mime_type, size_bytes, category }) => ({
        id,
        filename,
        mime_type,
        size_bytes,
        category,
      }));
    }
  }

  return Response.json(messages);
}

interface Attachment {
  id: string;
  thread_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  category: FileCategory;
  created_at: number;
}

interface FileProcessingMessage {
  attachmentId: string;
  threadId: string;
  r2Key: string;
  mimeType: string;
  category: FileCategory;
}

async function uploadAttachment(
  request: Request,
  threadId: string,
  env: Env
): Promise<Response> {
  if (!request.body) {
    return Response.json({ error: "Missing file body" }, { status: 400 });
  }

  const filename = request.headers.get("X-Filename") || "upload";
  const rule = ruleForFilename(filename);
  if (!rule) {
    return Response.json({ error: `Unsupported file type: ${filename}` }, { status: 415 });
  }

  // Content-Length is a soft check (a client could omit or lie about it) --
  // acceptable for now since nothing here is authenticated yet either (Step 8).
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > rule.maxBytes) {
    return Response.json(
      { error: `File too large: max ${Math.round(rule.maxBytes / (1024 * 1024))}MB for this type` },
      { status: 413 }
    );
  }

  const id = crypto.randomUUID();
  const r2Key = `threads/${threadId}/${id}-${filename}`;

  // Stream straight into R2 rather than buffering the whole file in memory.
  // Trust our own rule's mimeType, not the client's Content-Type header --
  // browsers report it inconsistently for some extensions (.md especially).
  const object = await env.UPLOADS.put(r2Key, request.body, {
    httpMetadata: { contentType: rule.mimeType },
  });

  const attachment = await env.DB.prepare(
    `INSERT INTO attachments (id, thread_id, r2_key, filename, mime_type, size_bytes, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     RETURNING id, thread_id, filename, mime_type, size_bytes, category, created_at`
  )
    .bind(id, threadId, r2Key, filename, rule.mimeType, object.size, rule.category)
    .first<Attachment>();

  // Images need no processing -- they go straight to the model as multimodal
  // input (Step 7). Only documents/data need the extraction pipeline.
  if (rule.category !== "image") {
    await env.FILE_QUEUE.send({
      attachmentId: id,
      threadId,
      r2Key,
      mimeType: rule.mimeType,
      category: rule.category,
    } satisfies FileProcessingMessage);
  }

  return Response.json(attachment, { status: 201 });
}

async function getAttachment(id: string, env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT r2_key, filename, mime_type FROM attachments WHERE id = ?"
  )
    .bind(id)
    .first<{ r2_key: string; filename: string; mime_type: string }>();

  if (!row) {
    return new Response("Not found", { status: 404 });
  }

  const object = await env.UPLOADS.get(row.r2_key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": `inline; filename="${row.filename}"`,
    },
  });
}

async function processAttachment(job: FileProcessingMessage, env: Env): Promise<void> {
  const object = await env.UPLOADS.get(job.r2Key);
  if (!object) {
    throw new Error(`R2 object not found: ${job.r2Key}`);
  }

  // txt/md/csv are plain text already -- no parsing library needed.
  // pdf/docx need a real extraction library; not implemented yet.
  const isPlainText = job.mimeType === "text/plain" || job.mimeType === "text/markdown" || job.mimeType === "text/csv";

  if (!isPlainText) {
    console.log(
      JSON.stringify({
        message: "extraction not yet implemented for this format",
        attachmentId: job.attachmentId,
        mimeType: job.mimeType,
      })
    );
    return;
  }

  const text = await object.text();
  const result = await indexDocument(env, job.attachmentId, job.threadId, text);
  console.log(
    JSON.stringify({
      message: "indexed document",
      attachmentId: job.attachmentId,
      chars: text.length,
      ...result,
    })
  );
}

// Files upload to R2 before the message that will reference them exists
// (Step 4's upload-before-send flow) -- if the user never sends that
// message, the attachment row (message_id NULL) and its R2 object, and for
// long documents its Vectorize vectors, are orphaned. R2 lifecycle rules
// can't express this: they only know object age + key prefix, not "is this
// still unlinked in D1" -- so a scheduled job that knows our actual data
// model is the right tool, not a bucket-level rule.
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

async function cleanupOrphanedAttachments(env: Env): Promise<void> {
  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key, chunk_count FROM attachments WHERE message_id IS NULL AND created_at < ?"
  )
    .bind(cutoff)
    .all<{ id: string; r2_key: string; chunk_count: number }>();

  if (results.length === 0) {
    console.log(JSON.stringify({ message: "no orphaned attachments to clean up" }));
    return;
  }

  await env.UPLOADS.delete(results.map((r) => r.r2_key));

  const vectorIds = results.flatMap((r) =>
    Array.from({ length: r.chunk_count }, (_, i) => `${r.id}-${i}`)
  );
  if (vectorIds.length > 0) {
    await env.VECTORIZE.deleteByIds(vectorIds);
  }

  const placeholders = results.map(() => "?").join(",");
  await env.DB.prepare(`DELETE FROM attachments WHERE id IN (${placeholders})`)
    .bind(...results.map((r) => r.id))
    .run();

  console.log(
    JSON.stringify({
      message: "cleaned up orphaned attachments",
      count: results.length,
      vectorsDeleted: vectorIds.length,
    })
  );
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/threads") {
      if (request.method === "GET") {
        return listThreads(env);
      }
      if (request.method === "POST") {
        return createThread(request, env);
      }
    }

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/(ws|messages|attachments|search)$/);
    if (threadMatch) {
      const [, threadId, action] = threadMatch;
      if (action === "messages" && request.method === "GET") {
        return getThreadMessages(threadId, env);
      }
      if (action === "ws") {
        return env.CHAT_THREAD.getByName(threadId).fetch(request);
      }
      if (action === "attachments" && request.method === "POST") {
        return uploadAttachment(request, threadId, env);
      }
      if (action === "search" && request.method === "GET") {
        const query = url.searchParams.get("q");
        if (!query) {
          return Response.json({ error: "Missing ?q=" }, { status: 400 });
        }
        return Response.json(await searchDocuments(env, threadId, query));
      }
    }

    const attachmentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
    if (attachmentMatch && request.method === "GET") {
      return getAttachment(attachmentMatch[1], env);
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processAttachment(message.body, env);
      } catch (err) {
        console.error(
          JSON.stringify({
            message: "file processing failed, retrying",
            attachmentId: message.body.attachmentId,
            error: err instanceof Error ? err.message : String(err),
          })
        );
        message.retry();
      }
    }
  },

  async scheduled(_controller, env): Promise<void> {
    await cleanupOrphanedAttachments(env);
  },
} satisfies ExportedHandler<Env, FileProcessingMessage>;
