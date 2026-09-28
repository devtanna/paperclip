# Plan: OpenClaw-style Memory + Proactive 24/7 Company Copilot for Paperclip

## Context

Goal: turn this Paperclip fork into a **company copilot** that works like OpenClaw. It should:
- run 24/7 in the background
- remember everything in inspectable markdown memory
- find and do work proactively
- create cron jobs on its own or at a cofounder's request
- run on a Hetzner server where the user and their cofounders log in

Decisions already made:
- **Fully autonomous:** acts without approval gates, bounded by budget hard-stops and the guardrails below.
- **Delivery is in-app only:** Agent Chat plus inbox.
- **Search:** pgvector plus OpenAI embeddings (hybrid with Postgres full-text).
- **Runtime:** OpenRouter or any OpenAI-compatible endpoint with an API key.

### What is actually new (short version)

| Build | What it is |
|---|---|
| **1. Memory** (Phase 1) | OpenClaw-style markdown memory: company, per-person and per-agent `MEMORY.md`/`USER.md`, daily logs, hybrid pgvector plus keyword search, `memory_*` tools, injection into every run, a flush before compaction, nightly dreaming, and a Memory page |
| **2. Proactivity** (Phase 2) | A managed **Copilot** agent that watches the whole company: a 30-minute heartbeat with a computed "company pulse", instant wake on urgent events, commitments ("you said X by Friday"), in-app DMs and morning briefs, and a Copilot page with a kill switch |
| **3. Self-scheduling** (Phase 3) | Tools so the Copilot creates, edits and deletes its **own** schedules. Lightweight reminders that wake it without creating an issue are new. Recurring work uses the **existing Routines** (unchanged; the Copilot just calls them) |
| **4. Small core hooks** | Plugins can add to a run's prompt, a flush turn before compaction, heartbeat active hours and a cheap heartbeat model, a new event type, and three fields in the agent settings form |

**Reused unchanged:** routines (cron, timezone, webhooks, catch-up), heartbeat scheduler, auth, members, invites, roles, Agent Chat, inbox, budgets, activity log, Docker setup, and the existing onboarding "Connect a model" step (the OpenRouter API key is pasted there).

**Deferred (not in this plan):** a static server-wide API key from `.env.local` with onboarding locked to it.

### What OpenClaw does (research summary)

**Memory.** Plain markdown is the source of truth.
- **Workspace files:**
  - `AGENTS.md` (operating rules)
  - `SOUL.md` (persona)
  - `IDENTITY.md`
  - `USER.md` (the human's profile, 4k-character budget)
  - `MEMORY.md` (curated long-term facts, loaded every private session)
  - `memory/YYYY-MM-DD.md` (daily append-only logs; today's and yesterday's auto-load)
  - `HEARTBEAT.md` (checklist for each heartbeat run)
  - `DREAMS.md` (consolidation diary)
- **Index:** a SQLite database per agent, holding chunks of about 400 tokens with 80 tokens of overlap, a full-text (FTS/BM25) index and vectors.
- **Search:** hybrid scoring of **0.7 × vector + 0.3 × BM25**, fetching 4× the candidates first. It then applies:
  - a **30-day half-life** decay for dated notes (MEMORY.md, USER.md and undated files never decay)
  - MMR diversity reranking with λ = 0.7
  - a 700-character cap per snippet
- **Tools:** `memory_search`, `memory_get`, and `intent`, which records standing "do X when Y" commitments.
- **Memory flush:** a silent turn before context compaction tells the agent to write down durable facts.
- **Dreaming:** background consolidation that promotes qualified facts into MEMORY.md, with taint gating that blocks untrusted content.

**Heartbeat.** A periodic agent turn every 30 minutes by default.
- It respects `activeHours` and a timezone.
- A reply of `HEARTBEAT_OK` is suppressed so quiet runs don't spam anyone.
- It can use light context, an isolated session and a cheaper model.
- Rule of thumb: heartbeat asks "did anything change?"; cron means "do X at 9:00 sharp".

**Cron / automations.**
- Schedule kinds: `at` (one-shot), `every` and `cron`, each with a timezone.
- Payloads:
  - `systemEvent`: injected into the main session, optionally waking it now or at the next heartbeat
  - `agentTurn`: runs in a fresh isolated session
- Other features: `deleteAfterRun`, retries, run history, and **the agent creates its own jobs through a tool**.

### What Paperclip already has (reuse, don't rebuild)

| Need | Existing piece |
|---|---|
| Interval heartbeat | `agents.runtimeConfig.heartbeat` + `heartbeat.tickTimers()` in `server/src/services/heartbeat.ts:29620`, driven by the scheduler loop in `server/src/index.ts:~1626` |
| Cron with timezone, catch-up, concurrency, webhooks, UI | Routines: `packages/db/src/schema/routines.ts`, `server/src/services/routines.ts` (`tickScheduledTriggers`), `server/src/services/cron.ts`, `ui/src/pages/Routines.tsx` |
| Plugin framework | `packages/plugins/sdk` offers jobs (cron), a database namespace, state, local folders, agent tools (exposed through `tool-gateway.ts` `pluginTools()`), API routes, UI slots, event subscriptions, and managed agents, skills and routines |
| Template to copy | `packages/plugins/plugin-llm-wiki` has a managed agent, managed routines, tools, a database namespace, a local folder and UI pages |
| Per-agent bootstrap files | `server/src/services/agent-instructions.ts`, `default-agent-instructions.ts`, `server/src/onboarding-assets/ceo/{AGENTS,HEARTBEAT,SOUL,TOOLS}.md` |
| Daily notes and MEMORY.md convention | `skills/para-memory-files` (prompt convention only; nothing on the server) |
| Session compaction | `evaluateSessionCompaction` in `heartbeat.ts:11983` plus a handoff markdown (the natural flush hook point) |
| OpenRouter runtime | the `opencode_local` adapter plus `server/src/services/ai-connection-runtime.ts`, which already maps `OPENROUTER_API_KEY` |
| In-app delivery | Agent Chat, i.e. conversations stored as issues (`issues.conversationUserId`, `server/src/services/agent-conversations.ts`, `ui/src/pages/AgentChat.tsx`; `enableAgentChat` flag) plus the inbox |
| Multi-user team | Better Auth (`server/src/auth/better-auth.ts`), `authenticated`/`public` deployment mode, `invites`/`join_requests`, `company_memberships`, `principal_permission_grants`, `ui/src/pages/CompanyInvites.tsx` |
| Deployment | `Dockerfile`, `docker/docker-compose.yml` (Postgres 17 plus server), `doc/DOCKER.md`, `doc/DEPLOYMENT-MODES.md` |
| Prior design | `doc/plans/2026-03-17-memory-service-surface-api.md` (never implemented); scope, provenance and hook concepts are borrowed from it |

**Gaps:**
- no memory search or tools
- no prompt injection from plugins
- no pre-compaction flush
- no vectors anywhere
- plugins can't run `CREATE EXTENSION`
- no heartbeat active hours or per-wake model choice
- the CEO agent is explicitly **reactive** ("never look for unassigned work")

## Architecture

The work is **plugin-first**, to keep the fork easy to rebase on upstream: a new package `packages/plugins/plugin-copilot` modelled on plugin-llm-wiki. It needs **five small, generic core hooks** that the plugin can't provide itself. Each is written so it could be sent upstream.

```
┌──────────── plugin-copilot ─────────────────────────────────────┐
│ Memory engine: md files → chunker → FTS + pgvector → hybrid rank │
│ Tools: memory_*, commitment_*, schedule_*, copilot_notify, pulse │
│ Managed "Copilot" agent (opencode_local + OpenRouter)            │
│ Jobs: indexer, schedule ticker, pulse builder                    │
│ Managed routines: morning brief, nightly dreaming, weekly review │
│ Event subscriptions → signal buffer → wake now / next heartbeat  │
│ UI: Memory page, Copilot page (schedules, activity, kill switch) │
└──────────────┬───────────────────────────────────────────────────┘
      core hooks C1–C5 (generic)
┌──────────────┴───────────────────────────────────────────────────┐
│ heartbeat.ts · adapter-utils prompt sections · shared constants  │
└──────────────────────────────────────────────────────────────────┘
```

### Core hooks (small, generic, contracts kept in sync across db, shared, server and ui)

- **C1: plugin run-context contribution.** Plugins declare a new capability, `agent.context.contribute`, and the worker gets an RPC `contributeRunContext({companyId, agentId, runId, wakeReason, issueId})` that returns markdown.
  - `heartbeat.ts` calls it before the adapter executes, with a hard timeout of about 1.5 s and a token budget. A failure is logged to the run log and skipped.
  - The result goes into `context.paperclipPluginContextMarkdown`, which a shared helper in `packages/adapter-utils` renders next to `renderPaperclipWakePrompt`.
  - Wire it into `claude-local` and `opencode-local` first.
- **C2: pre-compaction memory flush.** Before `evaluateSessionCompaction` rotates a session, when `runtimeConfig.memoryFlush.enabled` is set:
  - enqueue one silent `reason: "memory_flush"` turn on the old session with a fixed flush prompt ("write durable facts via memory tools, reply NO_REPLY")
  - only then rotate
  - emit a new plugin event, `agent.session.rotating`
  - Deduplicate per session generation, as OpenClaw does with `memoryFlushCompactionCount`.
- **C3: heartbeat policy extensions.** Add `runtimeConfig.heartbeat.activeHours {start, end, timezone}`; `tickTimers` skips wakes outside that window. Add `runtimeConfig.heartbeat.model`, a model override used only for timer wakes so cheap models handle triage.
- **C4: new plugin event type.** Add `agent.session.rotating` to `PLUGIN_EVENT_TYPES` in `packages/shared/src/constants.ts`.
- **C5: pgvector availability (ops only, no core migration).**
  - The deployment's Postgres image is `pgvector/pgvector:pg17`, with an init SQL of `CREATE EXTENSION IF NOT EXISTS vector`.
  - The plugin detects `pg_extension` at startup: vector mode if present, otherwise keyword-only (embedded PGlite in local dev).
  - Embeddings are stored as `real[]` and cast to `vector` at query time, so plugin migrations never depend on the extension. That is fine for a startup-sized corpus (up to about 100k chunks); an optional HNSW expression index can be added later as an ops step.

## Phase 1: Memory engine (OpenClaw memory model)

**Implementation note (2026-09-28):** the markdown documents are stored in the plugin's Postgres namespace (`memory_documents`, with revisions), not in a local folder. Plugin local folders need an absolute path configured per company, which fits a hosted multi-user server poorly. Postgres gets backed up by `pg_dump`, needs no setup, and works with remote runners. The file layout below is unchanged; it is the document path within each scope.

```
<company>/  (scope → path)
  company/MEMORY.md             # shared curated long-term facts (evergreen)
  company/memory/YYYY-MM-DD.md  # company daily log (decays)
  company/DREAMS.md
  users/<userId>/USER.md        # per-cofounder profile/preferences (evergreen)
  users/<userId>/memory/…       # private notes from that person's DMs
  agents/<agentId>/MEMORY.md    # per-agent private memory
  agents/<agentId>/memory/YYYY-MM-DD.md
```

**Index.** Plugin DB namespace `copilot` (migrations in `packages/plugins/plugin-copilot/migrations/`):
- `memory_files`: company, scope_kind (company, user or agent), scope_id, path, sha256, evergreen, note_date
- `memory_chunks`: file_id, start_line and end_line, text, `tsv` (tsvector built in the insert), `embedding real[]`, embedding_model
- `embedding_cache`: (content_hash, model) → embedding

**Indexer.** A plugin job runs every minute and reconciles by hash, so edits made directly on disk are picked up. Memory tool writes and `agent.run.finished` also trigger incremental reindexing.
- Chunks are 400 tokens with 80 tokens of overlap.
- Embeddings are sent in batches of about 8k tokens with a concurrency of 4.

**Embeddings** use a configurable OpenAI-compatible endpoint. The default is `text-embedding-3-small` with 1536 dimensions. The API key is a Paperclip secret reference (see `doc/plans/2026-04-26-plugin-secret-ref-company-scope.md`). With no key, search falls back to keyword-only.

**Search:** `score = (0.7·vec + 0.3·bm25) × recencyDecay(30d half-life, dated files only)`.
- It fetches 4× the candidates first, then applies MMR with λ = 0.7 and caps each snippet at 700 characters.
- **Scope visibility:**
  - an agent sees company scope plus its own agent scope
  - the Copilot also sees user scopes
  - **user-private notes are never quoted into another user's conversation** (an instruction rule plus a tool-level filter keyed on the conversation's user)

**Tools** are registered through `ctx.tools.register` and reach every agent through the tool gateway:
- `memory_search(query, scopes?, topK?)`
- `memory_get(path, fromLine?, lines?)`
- `memory_note(text, scope?)`, which appends to today's daily log
- `memory_write(path, content | {section, content})`, for curated edits to MEMORY.md and USER.md
- `memory_forget(path, match)`, which supersedes rather than deletes, following the para-memory-files rule

**Context injection (C1).** For each run, the plugin contributes the following, within a budget of about 6k tokens:
- IDENTITY/SOUL (Copilot only)
- the company MEMORY.md
- the agent's MEMORY.md
- the requesting user's USER.md, when the run is a chat conversation
- today's and yesterday's daily notes
- the top-5 `memory_search` hits for the wake reason or issue title

If MEMORY.md is over budget, it is truncated and a consolidation task is flagged.

**Auto-capture** is deterministic and uses no LLM. On `agent.run.finished`, one timeline line (agent, issue, outcome) is appended to the agent's daily log. Human comments on issues are appended to the company daily log, and this can be switched off.

**Update `skills/para-memory-files`** so it points agents at the memory tools instead of `qmd`.

## Phase 2: The Copilot agent and proactivity

**Managed agent "Copilot."** The plugin installs it through managed resources, the same way llm-wiki installs Wiki Maintainer.
- adapter `opencode_local`, using the company's existing OpenRouter AI connection (the key pasted in onboarding; mapped by `ai-connection-runtime.ts:290`)
- main model is a strong one; `heartbeat.model` (C3) is a cheap triage model
- heartbeat `intervalSec: 1800`, `activeHours` in the company timezone
- `memoryFlush.enabled: true`
- company-wide read access

**Bootstrap files** live in `packages/plugins/plugin-copilot/templates/`:
- `AGENTS.md`: an explicit proactive charter that overrides the CEO's "never look for unassigned work" rule. The Copilot's job is to watch the whole company, notice what's stuck, and act.
- `SOUL.md`
- `IDENTITY.md`
- `TOOLS.md`
- `HEARTBEAT.md`, the per-heartbeat checklist:
  1. read the pulse
  2. check commitments that are due
  3. act (create or assign issues, nudge agents, unblock, answer)
  4. note in memory
  5. notify only if a human needs to know; otherwise reply `HEARTBEAT_OK` and exit

**Company pulse.** A deterministic snapshot the plugin builds from `ctx.issues`, `ctx.approvals`, `ctx.agents` and cost data, without an LLM, and injects at each heartbeat. It lists:
- stale `in_progress` issues (no activity for more than N hours)
- `blocked` issues and their blockers
- approvals pending more than X hours
- failed or stuck runs
- budget above 80%
- goals with no active issues
- unanswered @mentions of the Copilot
- new human comments since the last pulse
- commitments due soon

**Event-driven wakes.** The plugin subscribes to `issue.*`, comment and document events, `approval.*`, `agent.run.failed`, `agent.session.rotating` and similar, writing them to a `copilot_signals` buffer.
- **Urgent signals wake the Copilot now** (`ctx.agents` wakeup): a human @mention, a failed run on a high-priority issue, or a budget incident.
- Everything else waits for the next heartbeat, as in OpenClaw's `now` versus `next-heartbeat` modes.
- The Copilot's own events are ignored, to avoid loops.

**Commitments (prospective memory, OpenClaw's `intent`).** A `copilot_commitments` table stores owner (user or agent), text, due date, source reference and status. The Copilot writes to it when someone says "I'll do X by Friday" or "remind me when Y ships". Tools: `commitment_create`, `commitment_list`, `commitment_complete`. They show up in the pulse and in the morning brief.

**Delivery (in-app).**
- `copilot_notify(userId, message, urgency)` finds or creates that user's Agent Chat conversation with the Copilot (an issue with `conversationUserId`) and posts a comment. The message then appears in their chat and inbox.
- `enableAgentChat` is required, so set it on.
- **Morning brief:** a managed routine per member at 08:30 in their timezone, covering yesterday's outcomes, today's priorities, open commitments and decisions needed.

## Phase 3: Cron jobs (manual + automatic)

There are two tiers, matching OpenClaw's `systemEvent` versus `agentTurn`:

| Tier | Storage | Fires as | Use |
|---|---|---|---|
| **Lightweight schedules** | plugin tables `copilot_schedules` (kind `at`, `every` or `cron`, tz, message, target agent, `wakeMode` `now` or `next_heartbeat`, `deleteAfterRun`, retries) and `copilot_schedule_runs` | a plugin job that ticks every minute and wakes the target agent with the message as wake payload; no issue is created | reminders, check-ins, "look at X at 9am" |
| **Routines** | existing Paperclip routines, created through the plugin SDK routines client | an issue per run plus an agent wake, with full catch-up and concurrency policy | real recurring work: weekly metrics report, dependency audit |

- **Automatic:** the tools `schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete` and `schedule_run_now` (plus `routine_create` for tier 2) let the Copilot schedule itself, for example "remind Sam Friday 3pm" or "check deploy health every morning".
- **Manual:** the Copilot page lists schedules with create, edit and pause controls. The existing Routines page stays the manual UI for tier 2. In chat, "remind me …" becomes a schedule.
- `server/src/services/cron.ts` (`parseCron` and next-run logic) is reused by importing it through shared code, or duplicated inside the plugin if it isn't exported.

## Phase 4: Dreaming, UI, and guardrails

**Nightly dreaming.** A managed routine at 03:00 company time, on the cheap model:
- read the last 1–7 days of daily logs
- promote durable facts into `MEMORY.md` and `USER.md`
- dedupe and mark superseded facts
- expire temporary constraints
- write a review summary to `DREAMS.md`
- **Taint gate:** only promote facts whose source is a board user, the Copilot itself, or another agent's run output. Inbound external content (email, webhooks, fetched web pages) is never promoted automatically, which guards against prompt injection.

A **weekly review** routine rewrites the summaries and produces a "week in review" brief.

The UI for dreaming (DREAMS.md review) is in the **UI** section below; each phase ships its own screens.

**Guardrails** for full autonomy; these are required because Paperclip's invariants stay in force:
- a budget policy for the Copilot with a hard-stop auto-pause, using the existing `budget_policies`
- every action goes through the Paperclip API, so it is written to the activity log
- anti-spam limits:
  - at most N proactive notifications per user per day
  - quiet hours taken from `activeHours`
  - schedules no more frequent than every 5 minutes
  - at most 50 active schedules per company
- loop guard: no wake on the Copilot's own events, and a limit on wake rate per hour

## UI (shipped with each phase, not at the end)

**Rules:**
- Plugin screens use the plugin UI slots that llm-wiki uses (`sidebar`, `page`, `settingsPage`, `dashboardWidget`, `detailTab`), built into `packages/plugins/plugin-copilot/src/ui/` (`app.tsx`, `index.tsx`), with data from the plugin's `apiRoutes`.
- Every color, spacing and type value comes from the token layer in `ui/src/index.css`, per `DESIGN.md`. `pnpm check:token-gates` must pass.
- API errors are shown, never silently swallowed (AGENTS.md §9).
- Wizard and settings footers keep Cancel on the left and the primary action on the right.

### Sidebar

Two new entries under the company nav:
- **Copilot**, with a status dot (active, paused, over budget)
- **Memory**

### Copilot page (`/:company/copilot`) — ships with Phase 2 and grows in Phase 3

```
┌ Copilot ● active   next heartbeat 14:30   [Pause] [Run heartbeat now] ┐
│ Tabs: Activity | Schedules | Commitments | Pulse | Settings           │
├───────────────────────────────────────────────────────────────────────┤
│ Activity   timeline of heartbeats and actions:                        │
│   14:00 heartbeat → HEARTBEAT_OK (collapsed, grey)                    │
│   13:30 heartbeat → created PAP-812, nudged @Eng on PAP-790 (links)   │
│   09:12 woke on @mention (PAP-801) → replied                          │
│ Schedules  table: name · kind (at/every/cron) · next run · target ·   │
│            created by (you / Copilot) · last result · pause/edit/del  │
│            [+ New schedule] dialog with cron builder + tz + preview   │
│            of next 5 fire times; tier-2 rows link to Routines page    │
│ Commitments owner · what · due · source link · status · [Done]        │
│ Pulse      live view of what the next heartbeat will see (stale,      │
│            blocked, pending approvals, budget, failed runs)           │
│ Settings   heartbeat interval, active hours + tz, main/triage model,  │
│            notification cap per user/day, quiet hours, KILL SWITCH    │
└───────────────────────────────────────────────────────────────────────┘
```

- **Activity** comes from Copilot `heartbeat_runs` plus activity-log entries whose actor is the Copilot.
- **Settings** writes the agent's `runtimeConfig` through the existing agent API. The kill switch pauses the agent and disables every schedule, and records an activity-log entry.

### Memory page (`/:company/memory`) — ships with Phase 1

```
┌ Memory                         [ search memory…            ] ┐
├ Scopes ─────────┬ File ──────────────────────────────────────┤
│ ▾ Company       │ MEMORY.md   evergreen · 3.1k tok / 6k       │
│    MEMORY.md    │ [View | Edit]  markdown editor, save = write│
│    DREAMS.md    │ via memory API (hash-checked, audit-logged) │
│    ▸ daily 2026-│                                             │
│ ▾ People        │ Search results mode: snippet · file:lines · │
│    Dev (USER.md)│ score (vec / bm25 / decay) · source link     │
│    Sam (USER.md)│ (issue / run / comment)                     │
│ ▸ Agents        │                                             │
└─────────────────┴─────────────────────────────────────────────┘
  status bar: index mode (hybrid | keyword-only) · chunks · last sync
```

- **Visibility:** each user sees company and agent scopes, plus **only their own** `users/<id>` folder. Instance admins see everything.
- **Dreams tab** (Phase 4) shows DREAMS.md entries with each promotion as a diff and an **Undo** button, which reverts that edit to MEMORY.md.

### Changes to existing core UI (kept in sync with C1–C3)

- `ui/src/components/AgentConfigForm.tsx` and `agent-config-defaults.ts`: in the heartbeat section, add **Active hours (start/end/timezone)**, **Heartbeat model (timer wakes only)** and **Memory flush before compaction**. These apply to every agent, not just the Copilot.
- The run detail view in `ui/src/pages/AgentDetail.tsx`:
  - a collapsible **"Injected context"** block showing what C1 contributed (which memory files and search hits, with token count)
  - `memory_flush` runs labelled so they are not confused with real work
- Agent Chat (`ui/src/pages/AgentChat.tsx`):
  - Messages the Copilot starts itself get a **"proactive"** badge and an urgency color.
  - A "Remind me…" / "Remember this" quick action calls the schedule or memory tools.
  - Enable `enableAgentChat` by default in this fork.
- **Dashboard:** a `dashboardWidget` slot, **"Today's brief"**, showing the latest morning brief, open commitments and a count of things needing you.
- **Inbox:** proactive Copilot messages already arrive as conversation comments, so they appear in the inbox with no new work. Check this during Phase 2.
- **Plugin settings page** (`settingsPage`): embeddings endpoint, model and secret reference; auto-capture toggles; the taint-gate source allowlist.

### UI verification

- Component tests (Vitest and Testing Library, following `AgentDetail.instructions.test.tsx`) for:
  - the schedule dialog's cron preview
  - memory scope visibility for user A versus user B
  - kill-switch state
- A browser walkthrough with Claude in Chrome against `pnpm dev`:
  1. edit MEMORY.md
  2. search
  3. create a schedule
  4. watch it fire in Activity
  5. confirm the proactive badge in chat
  6. log in as a second invited user and confirm they cannot see the first user's USER.md
- Mobile width check. Paperclip has mobile-specific pickers, so use the same patterns.

## Phase 5: Hetzner deployment with the team

**Already built, nothing new needed:**
- sign-in and sign-up (Better Auth)
- Settings → Members: single-use invite links with Viewer, Operator, Admin and Owner roles, invite history, and a join-request queue
- Settings → Access (permission grants) and Settings → Secrets
- company-level membership: everyone invited sees all projects in the company

This phase is configuration plus a runbook in `docs/deploy/hetzner.md`. Models are connected through the existing onboarding step by pasting the OpenRouter API key; subscription sign-in is already disabled in public mode. Set a monthly company budget (`budget_policies`) so the hard-stop caps spend.

**End state:**
- The team's domain points at the Hetzner box.
- Every visitor must sign in.
- **Public sign-up is off (invite-only):** `PAPERCLIP_AUTH_INVITE_ONLY_SIGN_UP=true` (new). `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true` is not usable here: Better Auth would also refuse invitees, whose accounts are created through the same `/api/auth/sign-up/email` endpoint. The new guard (`server/src/auth/invite-only-sign-up.ts`) admits a sign-up only with a live human invite token sent by the invite page.
- The first admin is created with `bootstrap-ceo`.
- The admin creates the company and invites cofounders from Settings → Members.
- Invitees follow the link, create an account, and join with their role.
- `/api/health` reports `authSignUpMode` (`open`, `invite_only` or `disabled`); `ui/src/pages/Auth.tsx` hides "Create one" unless it is `open`. `InviteLanding` keeps sign-up and sends the invite token.
- Only instance admins can create companies (the existing rule at `server/src/routes/companies.ts:1193-1204`).

- **Server:** a CX32 or CPX31 (4 vCPU, 8 GB) is enough because models are remote. Firewall: ufw open only on 22, 80 and 443.
- **Compose:** `docker/hetzner/docker-compose.yml`, a standalone file based on `docker/docker-compose.yml`:
  - Postgres image `pgvector/pgvector:pg17`, with an init SQL that creates the `vector` extension
  - strong database credentials, and **port 5432 not published**
  - a **Caddy** service providing automatic TLS
- **Settings:** `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `EXPOSURE=public`, `PAPERCLIP_PUBLIC_URL`, `BETTER_AUTH_SECRET`, sign-up disabled (invite-only).
- **Team setup:** run `pnpm paperclipai auth bootstrap-ceo` for the first admin, then invite cofounders through the Company Invites page. On their first chat, the Copilot starts `USER.md` for each of them.
- **Backups:** nightly `pg_dump` plus the instance root (which includes `memory-root/`), sent through restic to a Hetzner Storage Box.
- **Later, optional:** transactional email for password resets and emailed invites, using Better Auth `sendResetPassword` over SMTP or Resend.

## Implementation order

**Deploy first, then ship each phase to the live server.**

1. Write this plan to `doc/plans/2026-09-28-copilot-memory-plugin.md`, as the repo rule requires.
2. **Phase 5a: thin Hetzner deploy of stock Paperclip from the fork.**
   - `docker/hetzner/docker-compose.yml` (pgvector image, Caddy TLS, no public 5432, secrets from a `.env` beside the compose file)
   - the existing `.github/workflows/docker.yml` already publishes `ghcr.io/<fork>:sha-<short>` when run in the fork (manual dispatch or push to master); the server pulls that pinned tag
   - authenticated/public mode, invite-only, `bootstrap-ceo`, cofounders invited
   - invite-only sign-up mode (server guard plus hidden sign-up link)
   - nightly backups sent through restic to a Storage Box
   - `docs/deploy/hetzner.md`
   - Paste the OpenRouter key through the existing onboarding step.
   - Every later migration must be forward-only and safe for live data. Take a backup before each deploy.
3. Core hooks C1, C3 and C4; C2 comes after the memory tools exist.
4. Phase 1: the plugin skeleton (copy the plugin-llm-wiki structure and manifest), the memory engine, tools, context injection and auto-capture. UI: Memory page and plugin settings page.
5. Phase 2: the Copilot agent, pulse, signals, commitments and notify. UI: Copilot page (Activity, Pulse, Commitments, Settings), the AgentConfigForm heartbeat fields, the chat proactive badge and the dashboard widget.
6. Phase 3: schedules. UI: Schedules tab and cron-builder dialog.
7. C2 flush, then Phase 4 dreaming. UI: Dreams tab with undo, and the injected-context and memory-flush run views.
8. Later and optional: transactional email (password reset, emailed invites), and the deferred static `.env.local` API key.

Each step is tested locally with `pnpm dev`, then deployed to Hetzner and checked there. The 24/7 behavior (heartbeats, schedules, dreaming) is verified on the server.

**Phase 5a verification:**
- `https://<domain>` serves over TLS and redirects to sign-in.
- The sign-up link is hidden, and a direct sign-up POST is rejected.
- An invite link lets a cofounder create an account and join with the chosen role.
- An agent run on `opencode_local` with the pasted OpenRouter key succeeds.
- Port 5432 is not reachable from outside.
- `SELECT extname FROM pg_extension WHERE extname='vector'` returns a row.
- A restic snapshot exists after the first nightly backup, and a test restore works.

**Critical files:**
- new: `packages/plugins/plugin-copilot/**`
- `server/src/services/heartbeat.ts` (`tickTimers`, `evaluateSessionCompaction`, the pre-execute context build)
- `packages/adapter-utils/src/server-utils.ts` (prompt section helper)
- `packages/adapters/{claude-local,opencode-local}/src/server/execute.ts`
- `packages/shared/src/constants.ts` (event types and capability)
- `packages/plugins/sdk/src/types.ts` (the `contributeRunContext` worker hook)
- `server/src/services/plugin-*` (RPC dispatch for C1)
- `skills/para-memory-files/SKILL.md`
- `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/agent-config-defaults.ts`, `ui/src/pages/AgentDetail.tsx`, `ui/src/pages/AgentChat.tsx`
- `packages/plugins/plugin-copilot/src/ui/**`
- `docker/hetzner/docker-compose.yml`
- `docs/deploy/hetzner.md`

## Verification

**Unit tests** (Vitest, inside the plugin package):
- chunker boundaries and overlap
- hybrid scoring, 30-day decay (evergreen files exempt) and MMR
- the scope visibility filter, including that user-private notes never cross between users
- cron, `every` and `at` next-run calculation with timezones, and `deleteAfterRun`
- rate limits and the loop guard

**Core tests:**
- `tickTimers` respects `activeHours`
- the timer-only model override
- the C1 timeout and failure path (the run still proceeds)
- C2 enqueues exactly one flush per rotation

**Local end-to-end** (`pnpm dev`, embedded database, so keyword-only mode):
1. Install the plugin; the Copilot agent appears.
2. `memory_note` then `memory_search` returns the note.
3. The next run's prompt contains MEMORY.md and today's log (check the run log).
4. Create an `at` schedule one minute out and confirm the wake fires.
5. Leave an issue `in_progress` with no activity and confirm the heartbeat surfaces it and posts to Agent Chat.
6. Say "remind me tomorrow 9am" in chat and confirm a schedule is created.

**pgvector check:** `docker compose -f docker/hetzner/docker-compose.yml up`, set the embeddings key, then confirm vector mode is detected and a semantic query (a paraphrase with no keyword overlap) finds the note.

**Full gate before the PR:** `pnpm -r typecheck && pnpm test:run && pnpm build && pnpm check:token-gates`.

## Implementation notes (2026-09-28)

Where the build differs from the plan above, and why:

- **No blind heartbeat for the Copilot.**
  - The plugin's pulse (plain queries every N minutes) wakes the Copilot through `ctx.agents.invoke`, and only when the pulse has items and changed. The agent's own interval heartbeat stays off.
  - This is cheaper than an LLM "anything changed?" turn every 30 minutes.
  - C3's heartbeat `activeHours` and timer `model` remain as generic agent features.
- **Memory flush setting lives under the heartbeat policy:** `runtimeConfig.heartbeat.memoryFlush: true`. The agent settings form edits heartbeat fields as one object, and a separate top-level key would have been overwritten by other edits.
  - The flush keeps the old session for one more run and prepends a "save memory" note, rather than making an extra silent run. So a flush costs no additional LLM run.
- **Rotation event:** named `agent.session.rotated` and emitted when rotation happens.
- **Morning brief, nightly consolidation, weekly review:** built-in plugin schedules (editable, disableable), not managed routines. Routines create an issue per run and are one per company in the manifest, while these are lightweight wakes.
  - For recurring work that should produce tasks, the Copilot creates ordinary Paperclip routines through the Paperclip API. The plugin SDK can only manage manifest-declared routines.
- **Delivery:**
  - New SDK method `ctx.issues.ensureConversation` opens (or finds) the Agent Chat between the Copilot and a person.
  - `copilot_notify` then posts there as the Copilot. Only the Copilot may notify, capped per person per day.
- **Tool access:** Paperclip denies plugin tools unless a tool policy allows them. The UI offers two ordinary allow-policies, created through the core API as the signed-in user:
  - the Copilot's tools, for the Copilot
  - memory tools, for all agents
- **Proactive scope:** background plugin work may only act for companies where an operator saved the plugin's config (the host's consent boundary). Turning the Copilot on saves it; the first time needs an instance admin.
- **Undo for dreaming:** every memory write keeps a revision, and the Memory page's **History** restores any version. The dedicated diff-per-promotion Dreams tab became this general history, which also covers manual edits.
- **Deferred:**
  - the chat "proactive" badge (Copilot messages are ordinary Agent Chat comments)
  - per-member timezones for the morning brief (it uses the Copilot's timezone)
  - "goals with no active issues" in the pulse

Operations, bounds, and teardown are documented in `doc/copilot-operations.md`.

## Research sources

- https://docs.openclaw.ai/concepts/memory
- https://docs.openclaw.ai/concepts/memory-search
- https://docs.openclaw.ai/concepts/agent-workspace
- https://docs.openclaw.ai/gateway/heartbeat
- https://docs.openclaw.ai/automation/cron-jobs.md
- https://www.mmntm.net/articles/openclaw-memory-architecture
