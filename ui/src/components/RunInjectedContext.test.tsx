// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunInjectedContext } from "./RunInjectedContext";

describe("RunInjectedContext", () => {
  it("renders nothing for ordinary runs", () => {
    expect(renderToStaticMarkup(<RunInjectedContext run={{ contextSnapshot: { issueId: "x" } }} />)).toBe("");
    expect(renderToStaticMarkup(<RunInjectedContext run={{ contextSnapshot: null }} />)).toBe("");
  });

  it("shows plugin sources, failures, and the injected markdown", () => {
    const html = renderToStaticMarkup(
      <RunInjectedContext
        run={{
          contextSnapshot: {
            paperclipPluginContextSources: [
              { pluginKey: "paperclipai.plugin-copilot", chars: 1200, truncated: false },
              { pluginKey: "other.plugin", chars: 0, error: "timed out after 1500ms" },
            ],
            paperclipPluginContextMarkdown: "## Copilot Memory\n\nLaunch is Friday.",
          },
        }}
      />,
    );
    expect(html).toContain("paperclipai.plugin-copilot 1,200 chars");
    expect(html).toContain("other.plugin: timed out after 1500ms");
    expect(html).toContain("Launch is Friday.");
  });

  it("labels memory flush runs", () => {
    const html = renderToStaticMarkup(
      <RunInjectedContext run={{ contextSnapshot: { paperclipMemoryFlushNote: "save now" } }} />,
    );
    expect(html).toContain("Memory flush run.");
  });
});
