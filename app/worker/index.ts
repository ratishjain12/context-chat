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

interface ThreadMessage {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: number;
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
  const { results } = await env.DB.prepare(
    "SELECT id, thread_id, role, content, created_at FROM messages WHERE thread_id = ? ORDER BY created_at"
  )
    .bind(threadId)
    .all<ThreadMessage>();

  return Response.json(results);
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

    const threadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/(ws|messages)$/);
    if (threadMatch) {
      const [, threadId, action] = threadMatch;
      if (action === "messages" && request.method === "GET") {
        return getThreadMessages(threadId, env);
      }
      if (action === "ws") {
        return env.CHAT_THREAD.getByName(threadId).fetch(request);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
