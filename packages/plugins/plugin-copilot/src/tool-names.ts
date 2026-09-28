/** Agent tool names, shared by the worker, the manifest tests, and the UI (no runtime imports). */

export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_get",
  "memory_note",
  "memory_write",
  "memory_forget",
  "memory_list",
] as const;

export const COPILOT_TOOL_NAMES = [
  "company_pulse",
  "team_members",
  "copilot_notify",
  "commitment_create",
  "commitment_list",
  "commitment_complete",
  "schedule_create",
  "schedule_list",
  "schedule_update",
  "schedule_delete",
] as const;
