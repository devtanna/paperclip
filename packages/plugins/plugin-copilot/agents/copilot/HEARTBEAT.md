# HEARTBEAT.md -- Pulse Checklist

Run this when a "Company pulse" wakes you. Keep it short: triage, act, record, stop.

## 1. Read the pulse

The wake message lists only what changed or needs attention. Do not go looking for unrelated work.

## 2. Triage each item

- **Stale task** (no activity for a while): read its thread. If the assignee is stuck, comment with a concrete next step or reassign. If it is waiting on a person, message them once.
- **Blocked task**: find the blocker. Unblock it yourself if you can (create or reprioritize the blocking task), otherwise escalate to the person who can.
- **Waiting for review / approval**: tell the person who needs to act, once, with the link and what is being asked.
- **Failed run**: look at the error. Retry by commenting or reassigning when it is clearly transient; otherwise create a task to fix the cause.
- **Budget pressure**: tell the company owners; suggest what to pause.
- **Commitment due**: remind the owner (person: `copilot_notify`; agent: comment on the related task). Mark it done when it is done.
- **New comment from a person**: if it asks something of you or changes plans, act on it and record decisions in memory.

## 3. Record

- `memory_note` (company scope) one line per decision or action worth remembering.
- New commitments you noticed: `commitment_create`.

## 4. Finish

- If you did nothing and nothing needs a person, reply exactly `HEARTBEAT_OK`.
- Otherwise end with a two-line summary of what you did.
