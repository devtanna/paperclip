import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as any;
}

describeEmbeddedPostgres("plugin issues.ensureConversation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-ensure-conversation-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const company = await db
      .insert(companies)
      .values({ name: `Chat ${randomUUID()}`, issuePrefix: `C${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    const agent = await db
      .insert(agents)
      .values({ companyId: company.id, name: "Copilot", role: "general", adapterType: "process", adapterConfig: {}, permissions: {} })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "user-alice",
      status: "active",
      membershipRole: "owner",
    });
    return { company, agent };
  }

  it("opens one conversation per agent and member and reuses it", async () => {
    const { company, agent } = await seed();
    const services = buildHostServices(db, "plugin-record-id", "copilot", createEventBusStub());

    const first = await services.issues.ensureConversation({ companyId: company.id, agentId: agent.id, userId: "user-alice" });
    const second = await services.issues.ensureConversation({ companyId: company.id, agentId: agent.id, userId: "user-alice" });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      conversationAgentId: agent.id,
      conversationUserId: "user-alice",
      assigneeAgentId: agent.id,
      title: "Chat with Copilot",
    });
    expect(await db.select().from(issues)).toHaveLength(1);
    services.dispose();
  });

  it("refuses non-members and agents from other companies", async () => {
    const { company, agent } = await seed();
    const other = await seed();
    const services = buildHostServices(db, "plugin-record-id", "copilot", createEventBusStub());

    await expect(
      services.issues.ensureConversation({ companyId: company.id, agentId: agent.id, userId: "user-mallory" }),
    ).rejects.toThrow(/not an active member/);
    await expect(
      services.issues.ensureConversation({ companyId: company.id, agentId: other.agent.id, userId: "user-alice" }),
    ).rejects.toThrow(/Agent not found/);
    expect(await db.select().from(issues)).toHaveLength(0);
    services.dispose();
  });
});
