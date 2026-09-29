# Plan: Agent Initiative (every agent proactive in its role)

## Context

The Copilot (see `2026-09-28-copilot-memory-plugin.md`) is proactive about the company's internal state. Every other agent only reacted to assignments. The goal is for **every agent to come up with work in its role on its own and use the internet to do it**. For example, a CMO watches competitors, Sales looks for leads, and Engineering tracks security advisories.

Decisions:
- **Ideas and internal work are autonomous.** Anything external or costly (emailing outsiders, publishing, spending, hiring, changing live systems) waits for a person's approval (`request_confirmation`).
- **Web search comes from the model runtime.** Paperclip builds none. Tavily, Exa, and Firecrawl stay available in the Apps catalog.
- **Each agent gets an Initiative slider**: Off / Low / Balanced / High. The default is **Balanced**: up to 4 runs per rolling 24 h, and at most 20% of the monthly budget (or $2 per 24 h without a budget).

## Built

| Layer | Change |
|---|---|
| shared | `agent-initiative.ts`: the levels, the policy table, the parser, and the wake reason `agent_initiative` |
| server | `services/agent-initiative.ts`: the due and cap decision and the initiative brief. `heartbeat.tickInitiative` gathers run and cost usage and company goals, then enqueues the wake. It is called from the scheduler loop in `index.ts` and is single-flight. The heartbeat model override also covers initiative runs. |
| ui | `InitiativeSlider` in the Run Policy section of the agent configuration |
| plugin-copilot | The morning brief lists recent `Idea: …` issues. The Copilot's `AGENTS.md` makes it the coordinator for ideas: merge, route, bundle. |
| docs | `doc/agent-initiative.md` |
| tests | `server/src/__tests__/agent-initiative.test.ts`: the policy, the brief, and the tick against real Postgres |

No schema change is needed. The setting lives in `runtimeConfig.heartbeat`, and usage comes from `heartbeat_runs` and `cost_events`.

## Deferred

- Slider in the new-agent wizard. New agents get Balanced and can change it after hiring.
- Connector events (new email, CRM change) as initiative triggers.
- Per-role mandate templates. For now the agent writes its own mandate on its first run from its role, capabilities, and company goals.
- An "ideas" view in the UI. For now ideas are ordinary issues titled `Idea: …`.
