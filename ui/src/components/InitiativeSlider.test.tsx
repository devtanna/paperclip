// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InitiativeSlider } from "./agent-config-primitives";

function render(value: unknown, onChange = () => {}) {
  return (
    <TooltipProvider>
      <InitiativeSlider value={value} onChange={onChange} />
    </TooltipProvider>
  );
}

describe("InitiativeSlider", () => {
  it("shows Balanced when unset and describes its limits", () => {
    const html = renderToStaticMarkup(render(undefined));
    expect(html).toContain('value="2"');
    expect(html).toContain("Up to 4 times a day");
    expect(html).toContain("20% of the agent&#x27;s monthly budget");
  });

  it("reports the level picked on the slider", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(render("low", onChange)));
    const input = container.querySelector("input[type=range]") as HTMLInputElement;
    expect(input.value).toBe("1");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "0");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("off");
    await act(async () => root.unmount());
  });
});
