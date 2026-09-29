# Agent Initiative

Every agent can start work on its own, for its role, without being assigned anything. On an initiative run the agent:

1. Recalls its standing mandate and what it checked last time. It writes a mandate first if it has none.
2. Looks outward. It uses web search and fetch if its runtime has them, and it checks the company's own work for gaps in its area.
3. Picks at most 3 new ideas that would move the company goals forward.
4. Opens one `Idea: …` issue per idea. Internal, reversible work starts right away. Anything external or costly waits for a person's approval through a `request_confirmation` interaction.
5. Records what it did in memory, so the next run builds on this one.

Paperclip has no built-in web search. Agents use whatever web tools their model runtime provides. For example, Claude Code has web search and fetch built in. An agent without web tools works from company data only. Tavily, Exa, and Firecrawl can be connected from the Apps catalog.

## Setting

**Agent → Configuration → Run Policy → Initiative**, stored as `runtimeConfig.heartbeat.initiative`. If it is unset, the level is **Balanced**.

| Level | Runs per rolling 24 h | Share of monthly budget | Cap without a monthly budget |
|---|---|---|---|
| Off | 0 | 0% | — |
| Low | 1 | 10% | $0.50 / 24 h |
| Balanced (default) | 4 | 20% | $2.00 / 24 h |
| High | 12 | 40% | $5.00 / 24 h |

Budget caps count only the cost of initiative runs. The rest of the budget stays free for assigned work. The company and agent budget hard-stops still apply as usual.

## Scheduling

The server scheduler calls `heartbeat.tickInitiative` on every tick (`server/src/services/heartbeat.ts`). The due and cap decision is in `server/src/services/agent-initiative.ts`. An agent is woken only when all of these are true:

- the level is not Off, and **Wake on demand** is on
- the agent is invokable: not paused, terminated, pending approval, or under a broken org chain
- the current time is inside the heartbeat **active hours**, if they are set
- the agent has no queued, running, or retrying run
- the agent is at least 1 hour old, or it has had an initiative run before
- it is under the level's run count and its budget or daily cost cap
- enough time has passed since its last initiative run: the active window divided by runs per day. For Balanced this is 6 h around the clock, or 3 h inside a 12 h window.

At most one company agent starts per tick, so a company's agents never all start at once. The scheduler does not run in worktree dev instances (execution cutoff) or while scheduling is suppressed.

The run is an `automation` wake with the wake reason `agent_initiative` and the task key `__initiative__`. It always starts a fresh session, so continuity comes from the agent's memory. If **Heartbeat model** is set, initiative runs use that cheaper model. Assigned work keeps the adapter model.

## Copilot

When the Copilot plugin is installed, the morning brief lists `Idea: …` issues opened in the last 36 hours. The Copilot merges duplicates, routes each idea to its owner, and tells each person which ideas are waiting for their approval.
