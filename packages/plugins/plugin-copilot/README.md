# Copilot Memory

An always-on company Copilot with OpenClaw-style memory for Paperclip. It implements the plan in [doc/plans/2026-09-28-copilot-memory-plugin.md](../../../doc/plans/2026-09-28-copilot-memory-plugin.md). What runs in the background and how it is bounded: [doc/copilot-operations.md](../../../doc/copilot-operations.md).

## Copilot

**Turning it on.** Open **Copilot** in the sidebar and choose **Set up Copilot**. The first time needs an instance admin, because it saves the plugin's settings for the company, which is how Paperclip authorizes background work. Setting up does four things:

1. Adds a managed **Copilot** agent: OpenCode by default, $30/month budget, paused until turned on. Pick its model on the agent page.
2. Creates one tool access policy that lets the Copilot use its tools.
3. Starts the pulse.
4. Adds three built-in schedules you can change or disable: the weekday morning brief, nightly memory consolidation, and the Friday weekly review.

**How it runs:**

- **Pulse.** Every 30 minutes inside active hours, the plugin checks the company with plain queries: stale, blocked, and waiting tasks, old approvals, budget, due commitments, and new events (failed runs, people's comments, new approvals). It wakes the Copilot only when something changed, capped per hour. The Copilot follows `agents/copilot/HEARTBEAT.md` and replies `HEARTBEAT_OK` when nothing needs doing.
- **Commitments.** "I'll send the deck Friday" becomes a tracked commitment; due ones show up in the pulse.
- **Schedules.** One-time, interval, or cron wakes with a message, created by people on the Copilot page or by agents with `schedule_*` tools. For work that should create a task every time, use Paperclip routines.
- **Messages.** `copilot_notify` posts into each person's Agent Chat with the Copilot, which also reaches their inbox. There is a daily cap per person.
- **Kill switch.** **Turn off** stops the pulse and every schedule and pauses the agent.

**Core changes this plugin relies on** (all generic):
- plugin run-context contribution (`agent.context.contribute`)
- `ctx.issues.ensureConversation`
- heartbeat `activeHours`, timer `model`, and `memoryFlush`
- the `agent.session.rotated` event
- purge-uninstall dropping the plugin schema


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

**Agent tools:**
- `memory_search`
- `memory_get`
- `memory_note` (append to today's log)
- `memory_write` (curate a file)
- `memory_forget`
- `memory_list`

Every write keeps the previous version as a revision; the Memory page's **History** can restore any of them. Writes to company memory are recorded in the activity log.

Agents can call plugin tools only when a tool access policy allows them. The Memory page offers **Allow for all agents**, which creates one editable policy.

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
