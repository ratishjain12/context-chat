import { ChatThreadDO } from "./chat-thread.js";

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
}

interface ThreadMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
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
      "SELECT id, thread_id, role, content, created_at FROM messages WHERE thread_id = ? ORDER BY created_at"
    )
      .bind(threadId)
      .all<ThreadMessage>(),
    env.DB.prepare(
      "SELECT id, message_id, filename, mime_type, size_bytes FROM attachments WHERE thread_id = ? AND message_id IS NOT NULL"
    )
      .bind(threadId)
      .all<AttachmentInfo & { message_id: string }>(),
  ]);

  for (const message of messages) {
    const forMessage = attachments.filter((a) => a.message_id === message.id);
    if (forMessage.length > 0) {
      message.attachments = forMessage.map(({ id, filename, mime_type, size_bytes }) => ({
        id,
        filename,
        mime_type,
        size_bytes,
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
  created_at: number;
}

interface FileProcessingMessage {
  attachmentId: string;
  r2Key: string;
  mimeType: string;
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
  const mimeType = request.headers.get("Content-Type") || "application/octet-stream";
  const id = crypto.randomUUID();
  const r2Key = `threads/${threadId}/${id}-${filename}`;

  // Stream straight into R2 rather than buffering the whole file in memory.
  const object = await env.UPLOADS.put(r2Key, request.body, {
    httpMetadata: { contentType: mimeType },
  });

  const attachment = await env.DB.prepare(
    `INSERT INTO attachments (id, thread_id, r2_key, filename, mime_type, size_bytes)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING id, thread_id, filename, mime_type, size_bytes, created_at`
  )
    .bind(id, threadId, r2Key, filename, mimeType, object.size)
    .first<Attachment>();

  // Decoupled from the response -- processing (Step 6: chunk + embed) happens
  // async in the queue consumer, not inline in the upload request.
  await env.FILE_QUEUE.send({ attachmentId: id, r2Key, mimeType } satisfies FileProcessingMessage);

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

  // TODO(step 6 - Vectorize): chunk the extracted text and store embeddings.
  if (job.mimeType.startsWith("text/")) {
    const text = await object.text();
    console.log(
      JSON.stringify({
        message: "processed text attachment",
        attachmentId: job.attachmentId,
        chars: text.length,
      })
    );
  } else {
    console.log(
      JSON.stringify({
        message: "queued non-text attachment for future embedding pipeline",
        attachmentId: job.attachmentId,
        mimeType: job.mimeType,
      })
    );
  }
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

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/(ws|messages|attachments)$/);
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
} satisfies ExportedHandler<Env, FileProcessingMessage>;
