# Copilot Memory

OpenClaw-style long-term memory for a Paperclip company. It is the first part of the company copilot plan in [doc/plans/2026-09-28-copilot-memory-plugin.md](../../../doc/plans/2026-09-28-copilot-memory-plugin.md).

## What it does

**Markdown memory, three scopes.** Every file is one of:
- **company:** shared by every agent and teammate (`MEMORY.md`, `memory/YYYY-MM-DD.md`)
- **agent:** one agent's private memory (same layout)
- **user:** one person's `USER.md` and notes, visible only to that person on the Memory page

**Recalled into every run.** Through the host `contributeRunContext` hook (capability `agent.context.contribute`), each agent run starts with:
- company and agent `MEMORY.md`
- the conversation user's `USER.md` (Agent Chat runs only)
- today's and yesterday's daily notes
- the top recalled snippets for the run's issue or wake reason

Everything fits inside the budget the host sets, and the run's context snapshot records what was injected.

**Hybrid search**, using OpenClaw's defaults:
- chunks of ~400 tokens with 80 tokens of overlap
- Postgres full-text plus vectors, weighted 0.7 vector and 0.3 keyword
- a 30-day half-life for dated notes (`MEMORY.md` and `USER.md` never decay)
- MMR (λ = 0.7) to drop near-duplicates
- snippets capped at 700 characters

**Agent tools:** `memory_search`, `memory_get`, `memory_note` (append to today's log), `memory_write` (curate a file), `memory_forget`, `memory_list`. Every write keeps the previous version as a revision. Writes to company memory are recorded in the activity log.

**Auto-capture:** each finished or failed agent run appends one line to that agent's daily log. Turn it off with **Log agent runs to daily notes**.

**Memory page and sidebar entry:** browse the files, edit them, and search with per-hit vector and keyword scores.

## Storage

Documents live in the plugin's Postgres namespace (`memory_documents`), not on disk. The layout mirrors an OpenClaw workspace, and a database fits a multi-user hosted server better:
- nothing to configure per company
- `pg_dump` backs it up
- remote runners reach it through the tools

A reindex job runs every minute and chunks and embeds any document whose content changed.

## Vector search

Semantic recall needs two things:

1. **An embeddings key.** In plugin settings, set **Embeddings API key** to a Paperclip secret. The default endpoint is OpenAI's `text-embedding-3-small`; any OpenAI-compatible `/embeddings` API works via **Embeddings base URL**.
2. **pgvector, for speed.** With the `vector` extension installed (the Hetzner compose file enables it), similarity runs in Postgres. Without it, as in local embedded Postgres, the worker scores up to 5,000 recent chunks in-process.

With no key, search is keyword-only.

## Development

```bash
pnpm --filter @paperclipai/plugin-copilot typecheck
pnpm --filter @paperclipai/plugin-copilot test
pnpm --filter @paperclipai/plugin-copilot build
# SQL against real Postgres through the host's plugin SQL validators:
pnpm --filter @paperclipai/server exec vitest run src/__tests__/plugin-copilot-memory-store.test.ts
```

To install locally, open **Settings → Plugins**, choose the bundled **Copilot Memory** plugin, or install from the local path `packages/plugins/plugin-copilot`.
