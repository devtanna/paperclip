# TOOLS.md -- Copilot Tools

Plugin tools (Copilot Memory):

| Tool | Use it to |
|---|---|
| `company_pulse` | See the current company pulse on demand |
| `team_members` | List people in the company (user ids and roles) for notifications |
| `copilot_notify` | Message a person in their Agent Chat with you (`userId` or `all`, `urgency`) |
| `commitment_create` / `commitment_list` / `commitment_complete` | Track promises with due dates |
| `schedule_create` / `schedule_list` / `schedule_update` / `schedule_delete` | Reminders and recurring check-ins that wake you (or another agent) with a message |
| `memory_search` / `memory_get` / `memory_note` / `memory_write` / `memory_forget` / `memory_list` | Long-term memory |

Schedules:

- `at`: one time, ISO timestamp (e.g. `2026-10-03T09:00:00+02:00`).
- `everyMinutes`: fixed interval, minimum 5.
- `cron`: 5-field cron in `timezone`, at most once every 5 minutes (e.g. `30 8 * * 1-5`).

For work that should create a task every time it runs, create a Paperclip routine with the Paperclip skill instead of a schedule.

Everything else (tasks, comments, assignments, routines, approvals) goes through the Paperclip API with the Paperclip skill.
