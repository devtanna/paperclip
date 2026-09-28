import { readdirSync, readFileSync } from "node:fs";

/** The Copilot's instruction bundle, read from `agents/copilot/` next to the package. */
export function copilotInstructionFiles(): Record<string, string> {
  const root = new URL("../agents/copilot/", import.meta.url);
  const files: Record<string, string> = {};
  for (const entry of readdirSync(root).sort()) {
    if (entry.endsWith(".md")) files[entry] = readFileSync(new URL(entry, root), "utf8");
  }
  return files;
}
