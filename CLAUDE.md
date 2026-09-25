# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Personal Standards

These files are auto-loaded at session start via the SessionStart hook — do not read them manually:

- `knowledge-base/about-me.md`
- `knowledge-base/architecture-principles.md`
- `knowledge-base/coding-standards.md`
- `knowledge-base/review-checklist.md` — check against this before presenting any implementation as complete

---

## Project Knowledge — Read When Working on This Repo

- `knowledge-base/project/context/architecture.md` — target architecture, repo layout, build order, key decisions
- `knowledge-base/project/context/dev.md` — accounts, commands, deployed URLs, gotchas

---

## What this project is

Learning-focused, production-grade build on Cloudflare's stack (Workers, D1, Durable Objects, R2, Queues, Vectorize, AI Gateway, Access) — go service by service, explain each one, keep cost-consciousness in mind (avoid unnecessary writes, watch free-tier limits).

The `cloudflare` Claude Code plugin is installed (skills: `wrangler`, `durable-objects`, `workers-best-practices`, `cloudflare-one`, etc., plus the official `mcp.cloudflare.com` MCP server). Prefer these over memorized Cloudflare API/CLI knowledge — retrieve current docs/config rather than assuming.
