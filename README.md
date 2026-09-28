# context

A multi-model AI chat app built end-to-end on Cloudflare's stack — Workers, D1, Durable Objects, R2, Queues, Vectorize, Workers AI, AI Gateway, and Access. Built as a learning project to go service-by-service through Cloudflare's platform while shipping something real.

Live at [context-chat.ratishfolio.com](https://context-chat.ratishfolio.com) (behind Cloudflare Access).

## Features

- **Real-time streaming chat** over WebSockets, backed by a Durable Object per thread
- **Model switching** across the full Workers AI catalog (30+ models), auto-synced from Cloudflare's own catalog — searchable picker with capability badges (vision / reasoning / function calling), pricing, and context window
- **Vision input** — attach images, routed to a vision-capable model automatically if the selected model can't see
- **Document RAG** — upload PDF, DOCX, TXT, MD, or CSV files; short documents are inlined into the prompt, long ones are chunked, embedded, and retrieved from Vectorize
- **Markdown + Mermaid rendering** in replies, with diagrams lazy-loaded so they don't cost anything until a message actually uses one
- **Auto-titled threads** — a cheap model titles each thread from its first message, like ChatGPT/Claude
- **Thread management** — create, delete (with confirmation), rename via auto-title
- **Cloudflare Access** in front of the whole app (self-hosted Access application on a custom domain)
- **Orphaned attachment cleanup** via a Cron Trigger

## Architecture

| Service | What it's used for |
|---|---|
| **Workers** | Hosts the app — API routes, static assets (React SPA), and the Worker entrypoint |
| **Durable Objects** | One `ChatThreadDO` instance per thread — owns the WebSocket connections and message ordering for that thread |
| **D1** | System of record — threads, messages, attachments (SQLite at the edge) |
| **R2** | Stores uploaded file attachments |
| **Queues** | Async pipeline for attachment text extraction (PDF/DOCX/plain text) and embedding, decoupled from the upload request |
| **Vectorize** | Vector search over chunked document embeddings, scoped per-thread |
| **Workers AI** | Chat completions, vision, and text embeddings — no external LLM API keys |
| **AI Gateway** | Routes all Workers AI calls, for caching/analytics on top of the model calls |
| **Access** | Zero Trust auth in front of the custom domain — no code in the app handles auth itself |
| **Cron Triggers** | Hourly job to clean up R2 objects / Vectorize vectors / D1 rows for attachments that were uploaded but never sent |

### Data flow

1. Client connects to a thread's Durable Object over WebSocket (`/api/threads/:id/ws`)
2. Sending a message persists it to D1, broadcasts it to all connected clients, then streams the model's reply token-by-token through AI Gateway → Workers AI
3. File uploads go straight to R2; documents (not images) get queued for extraction — the frontend polls attachment status and blocks sending until extraction/embedding finishes, so asking about a just-uploaded file in the same message works correctly
4. On the first message in a thread, a cheap model (`llama-3.2-1b-instruct`) generates a short title in parallel with the real reply, broadcast back over the same socket

## Project structure

```
app/
  worker/            Worker entrypoint, Durable Object, RAG, PDF/DOCX extraction
  src/                React frontend (Vite)
    components/
      ai-elements/    Message rendering, Mermaid, conversation UI (owned, not a package)
      ui/             shadcn-based UI primitives
  shared/             Code shared between worker/ and src/ (file type rules, model catalog)
  scripts/            sync-models.mjs -- regenerates shared/models.ts from Cloudflare's live catalog
  migrations/         D1 schema migrations
```

## Getting started

```bash
cd app
pnpm install
pnpm run dev       # local dev via Vite
```

Requires a Cloudflare account with Workers AI, D1, R2, Queues, and Vectorize enabled, and the resource bindings in `wrangler.jsonc` created under your own account (`wrangler d1 create`, `wrangler r2 bucket create`, etc.).

## Deploy

```bash
pnpm run deploy     # builds + wrangler deploy
```

## Other scripts

```bash
pnpm run models:sync   # regenerate shared/models.ts from Cloudflare's current Workers AI catalog
pnpm run cf-typegen     # regenerate Env types from wrangler.jsonc bindings
```
