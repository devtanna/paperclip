# Copilot Operations

What the Copilot Memory plugin (`packages/plugins/plugin-copilot`) runs in the background, what it costs, how it is bounded, where its data lives, and how to remove it completely.

## No new processes

Everything runs inside processes Paperclip already supervises:

- **The Paperclip server** runs its existing scheduler, which fires plugin jobs.
- **One plugin worker process**, started, restarted, and stopped by the server. It is killed when the server stops or the plugin is disabled.
- **Agent runs**, the same as any agent's, with Paperclip's existing reapers, watchdogs, and budgets.

The plugin adds no OS cron, no launch agents or systemd units, no listening ports, and no global installs.

## Background jobs

| Job | Schedule | Work per run | Cost when idle | Bounds |
|---|---|---|---|---|
| `memory-reindex` | every minute | Chunk and embed documents whose content changed | One indexed query that finds nothing | 50 documents per run; embedding calls only for new text (cached by hash) |
| `copilot-tick` | every minute, only for companies with the Copilot on | 1. fire due schedules 2. evaluate the pulse when due 3. prune history once a day | A few indexed queries | See below |

### `copilot-tick` in detail

1. **Schedules.**
   - At most 20 due schedules fire per company per tick.
   - A run more than 2 hours late (for example after downtime) is recorded as skipped instead of firing late, so a backlog never replays.
   - Turning the Copilot back on moves overdue schedules to their next future time.
2. **Pulse.** It runs only when the interval has passed (default 30 minutes) or an urgent signal arrived, and only inside active hours. It is plain queries, never an LLM call:
   - task lists by status (up to 200 each)
   - pending approvals
   - company budget
   - due commitments
   - buffered signals (up to 50)

   The Copilot is **woken only if** the pulse has items **and** differs from the last one it saw **and** fewer than `max check-ins per hour` wakes happened in the last hour **and** the Copilot is not already running.
3. **Retention.** Once a day it deletes:
   - signals older than 7 days
   - wakes, notifications, and schedule runs older than 30 days
   - closed commitments older than 90 days
   - memory revisions older than 90 days beyond the newest 20 per file

   Once a day per worker it also deletes cached embeddings that no chunk uses.

The tick never overlaps itself, and one company's failure cannot stop the others.

## Guardrails

| Risk | Guard |
|---|---|
| Runaway LLM spend | The Copilot wakes only on change and is capped per hour. Its agent starts with a $30/month budget, and Paperclip's budget hard-stop pauses it. |
| Wake loops | Events caused by the Copilot itself, and plugin-originated events, never become signals. Chat messages to the Copilot wake it through Agent Chat, not the pulse. |
| Schedule storms | Minimum interval of 5 minutes (cron included); at most 50 active schedules per company; at most 20 fires per tick. |
| Message spam | Only the Copilot can message people; each person gets at most N messages a day (default 6). |
| Unbounded tables | Daily retention (above). Commitments cap at 200 open per company. Memory documents cap at 64k characters each. |
| Prompt bloat | Memory added to a run is capped (plugins share 24k characters per run, with a 1.5 second timeout). Pulses show at most 8 items per section. |
| Prompt injection into memory | Nightly consolidation promotes only facts from people, the Copilot, or other agents' own work; external content stays unverified. |
| Something goes wrong | **Turn off** on the Copilot page: stops the pulse and every schedule immediately and pauses the Copilot agent (cancelling a run in progress). |

## Where the data lives

| Data | Location | Removed by |
|---|---|---|
| Memory documents, revisions, chunks, embeddings | Postgres schema `plugin_copilot_8879e97898` | Uninstalling the plugin with **purge** (drops the schema); deleting a company deletes its rows |
| Copilot settings, signals, commitments, schedules, wakes, notifications | Same schema | Same |
| The Copilot agent, its runs, and its chat conversations | Core Paperclip tables | Deleting the agent / company in Paperclip |
| Tool access policies it offered to create | Core `tool_policies` | Access settings, or deleting the company |
| Memory text sent for embeddings | Your embeddings provider (only if you configured a key) | Provider's own retention policy |

Local development keeps all of this inside `~/.paperclip/instances/<instance>/`. The Hetzner deployment keeps it in its Docker volumes; see `docs/deploy/hetzner.md` → Teardown.

## Turn off, uninstall, or remove completely

- **Pause everything now:** Copilot page → **Turn off**.
- **Remove the plugin but keep the data:** Settings → Plugins → uninstall.
- **Remove the plugin and every piece of its data:** uninstall with purge (`DELETE /api/plugins/paperclipai.plugin-copilot?purge=true`). This drops the plugin's schema. Then delete the Copilot agent from the Agents page if you do not want its run history.

## Soak test

See the results at the end of `doc/plans/2026-09-28-copilot-memory-plugin.md` (Soak test).
