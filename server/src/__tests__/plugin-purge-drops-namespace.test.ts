import { randomUUID } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, pluginDatabaseNamespaces, plugins } from "@paperclipai/db";
import copilotManifest from "../../../packages/plugins/plugin-copilot/src/manifest.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginDatabaseService } from "../services/plugin-database.js";
import { pluginRegistryService } from "../services/plugin-registry.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("plugin purge uninstall", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("plugin-purge-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function installWithSchema() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: copilotManifest.id,
      packageName: "@paperclipai/plugin-copilot",
      version: copilotManifest.version,
      apiVersion: copilotManifest.apiVersion,
      categories: copilotManifest.categories,
      manifestJson: copilotManifest,
      status: "installed",
      installOrder: 1,
    });
    const repoRoot = path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();
    const namespace = await pluginDatabaseService(db).applyMigrations(
      pluginId,
      copilotManifest,
      path.join(repoRoot, "packages", "plugins", "plugin-copilot"),
    );
    return { pluginId, namespaceName: namespace!.namespaceName };
  }

  async function schemaExists(name: string) {
    const rows = await db.execute(
      sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${name}`,
    );
    return (rows as unknown as unknown[]).length > 0;
  }

  it("keeps plugin data on a soft uninstall", async () => {
    const { pluginId, namespaceName } = await installWithSchema();
    await pluginRegistryService(db).uninstall(pluginId, false);
    expect(await schemaExists(namespaceName)).toBe(true);
    await pluginRegistryService(db).uninstall(pluginId, true);
  });

  it("drops the plugin schema and ledgers on a purge", async () => {
    const { pluginId, namespaceName } = await installWithSchema();
    expect(await schemaExists(namespaceName)).toBe(true);

    await pluginRegistryService(db).uninstall(pluginId, true);

    expect(await schemaExists(namespaceName)).toBe(false);
    expect(await db.select().from(pluginDatabaseNamespaces)).toHaveLength(0);
    expect(await db.select().from(plugins)).toHaveLength(0);
  });
});
