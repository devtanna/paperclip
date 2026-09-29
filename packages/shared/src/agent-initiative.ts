/**
 * Agent initiative: how much work an agent starts on its own, for its role,
 * without being assigned anything. Stored as
 * `runtimeConfig.heartbeat.initiative` and read by the initiative scheduler.
 * An unset value means the default level.
 */
export const AGENT_INITIATIVE_LEVELS = ["off", "low", "balanced", "high"] as const;
export type AgentInitiativeLevel = (typeof AGENT_INITIATIVE_LEVELS)[number];

export const DEFAULT_AGENT_INITIATIVE_LEVEL: AgentInitiativeLevel = "balanced";

export interface AgentInitiativePolicy {
  level: AgentInitiativeLevel;
  label: string;
  description: string;
  /** Self-started runs allowed in any rolling 24 hours. */
  maxRunsPerDay: number;
  /** Share of the agent's monthly budget self-started runs may spend. */
  monthlyBudgetSharePercent: number;
  /** Rolling 24-hour spend cap for self-started runs when the agent has no monthly budget. */
  fallbackDailyCostCents: number;
}

export const AGENT_INITIATIVE_POLICIES: Record<AgentInitiativeLevel, AgentInitiativePolicy> = {
  off: {
    level: "off",
    label: "Off",
    description: "Only works on what it is assigned.",
    maxRunsPerDay: 0,
    monthlyBudgetSharePercent: 0,
    fallbackDailyCostCents: 0,
  },
  low: {
    level: "low",
    label: "Low",
    description: "Once a day, checks its field and proposes a few ideas.",
    maxRunsPerDay: 1,
    monthlyBudgetSharePercent: 10,
    fallbackDailyCostCents: 50,
  },
  balanced: {
    level: "balanced",
    label: "Balanced",
    description: "Up to 4 times a day, looks for new work in its role; stays quiet when nothing is new.",
    maxRunsPerDay: 4,
    monthlyBudgetSharePercent: 20,
    fallbackDailyCostCents: 200,
  },
  high: {
    level: "high",
    label: "High",
    description: "Up to 12 times a day, keeps looking for ways to move its goals forward.",
    maxRunsPerDay: 12,
    monthlyBudgetSharePercent: 40,
    fallbackDailyCostCents: 500,
  },
};

export function parseAgentInitiativeLevel(value: unknown): AgentInitiativeLevel {
  return typeof value === "string" && (AGENT_INITIATIVE_LEVELS as readonly string[]).includes(value)
    ? (value as AgentInitiativeLevel)
    : DEFAULT_AGENT_INITIATIVE_LEVEL;
}

/** Reads the level from an agent's `runtimeConfig`. */
export function agentInitiativeLevelFromRuntimeConfig(runtimeConfig: unknown): AgentInitiativeLevel {
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    return DEFAULT_AGENT_INITIATIVE_LEVEL;
  }
  const heartbeat = (runtimeConfig as Record<string, unknown>).heartbeat;
  if (!heartbeat || typeof heartbeat !== "object" || Array.isArray(heartbeat)) {
    return DEFAULT_AGENT_INITIATIVE_LEVEL;
  }
  return parseAgentInitiativeLevel((heartbeat as Record<string, unknown>).initiative);
}

/** Wake reason on every self-started run; the scheduler counts runs by it. */
export const AGENT_INITIATIVE_WAKE_REASON = "agent_initiative";
