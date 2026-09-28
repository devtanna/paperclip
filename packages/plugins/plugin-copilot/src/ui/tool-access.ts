import { COPILOT_TOOL_NAMES, MEMORY_TOOL_NAMES } from "../tool-names.js";
import { ApiError, coreApi, PLUGIN_KEY } from "./shared.js";

/**
 * Agents may only call plugin tools that a tool policy allows. These helpers
 * create two ordinary, visible "allow" policies through Paperclip's own API,
 * as the signed-in user: memory tools for every agent, and the Copilot's
 * tools for the Copilot only. Both can be edited or removed in Access settings.
 */

export const MEMORY_POLICY_NAME = "Copilot Memory: memory tools for all agents";
export const COPILOT_POLICY_NAME = "Copilot Memory: Copilot tools for the Copilot";

interface ToolPolicy {
  id: string;
  name: string;
  enabled: boolean;
  policyType: string;
}

const namespaced = (names: readonly string[]) => names.map((name) => `${PLUGIN_KEY}:${name}`);

export async function listCopilotPolicies(companyId: string): Promise<{ memory: ToolPolicy | null; copilot: ToolPolicy | null }> {
  const { policies } = await coreApi<{ policies: ToolPolicy[] }>(`/companies/${companyId}/tools/policies`);
  return {
    memory: policies.find((policy) => policy.name === MEMORY_POLICY_NAME) ?? null,
    copilot: policies.find((policy) => policy.name === COPILOT_POLICY_NAME) ?? null,
  };
}

async function createPolicy(companyId: string, body: Record<string, unknown>): Promise<void> {
  try {
    await coreApi(`/companies/${companyId}/tools/policies`, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    // A policy with this name already exists: nothing to do.
    if (error instanceof ApiError && error.status === 409) return;
    throw error;
  }
}

export function allowMemoryToolsForAllAgents(companyId: string): Promise<void> {
  return createPolicy(companyId, {
    name: MEMORY_POLICY_NAME,
    description: "Lets every agent search, read, and write company memory through the Copilot Memory plugin.",
    policyType: "allow",
    priority: 50,
    enabled: true,
    selectors: { actorType: "agent", toolNames: namespaced(MEMORY_TOOL_NAMES) },
  });
}

export function allowCopilotTools(companyId: string, copilotAgentId: string): Promise<void> {
  return createPolicy(companyId, {
    name: COPILOT_POLICY_NAME,
    description: "Lets the Copilot agent use its memory, pulse, commitment, schedule, and notification tools.",
    policyType: "allow",
    priority: 50,
    enabled: true,
    selectors: {
      actorType: "agent",
      agentIds: [copilotAgentId],
      toolNames: namespaced([...COPILOT_TOOL_NAMES, ...MEMORY_TOOL_NAMES]),
    },
  });
}

/**
 * Background work (the pulse, schedules, embeddings) may only act for
 * companies where an operator saved this plugin's configuration: that is the
 * host's consent boundary for proactive plugin access. Saving the existing (or
 * empty) configuration grants it. Requires an instance admin.
 */
export async function ensurePluginConfigured(companyId: string): Promise<void> {
  const existing = await coreApi<{ configJson?: Record<string, unknown> } | null>(
    `/plugins/${PLUGIN_KEY}/config?companyId=${companyId}`,
  );
  if (existing && existing.configJson) return;
  try {
    await coreApi(`/plugins/${PLUGIN_KEY}/config`, {
      method: "POST",
      body: JSON.stringify({ companyId, configJson: {} }),
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      throw new Error("An instance admin needs to turn on the Copilot the first time (it saves the plugin's settings for this company).");
    }
    throw error;
  }
}
