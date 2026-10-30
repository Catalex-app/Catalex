import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposedChangesPanel } from "./proposed-changes-panel";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProposedChangesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.replaceChildren();
  });

  it("renders as a top toolbar with navigation and file-level actions only", () => {
    act(() => {
      root.render(
        <ProposedChangesPanel
          change={{
            id: "change-1",
            filePath: "main.tex",
            absolutePath: "/tmp/main.tex",
            oldContent: "one\ntwo",
            newContent: "one\ntwo\nthree",
            toolName: "CodexEdit",
            timestamp: 1,
          }}
          mergeChunkInfo={{ current: 1, total: 2 }}
          onPreviousChunk={vi.fn()}
          onNextChunk={vi.fn()}
          onKeep={vi.fn()}
          onUndo={vi.fn()}
        />,
      );
    });

    const panel = container.querySelector(
      "[data-proposed-changes-panel='true']",
    );
    expect(panel?.className).toContain("h-12");
    expect(panel?.className).toContain("border-b");
    expect(panel?.className).not.toContain("border-t");
    expect(container.textContent).not.toContain("main.tex");
    expect(container.textContent).not.toContain("files");
    expect(container.textContent).not.toContain("CodexEdit");
    expect(container.textContent).toContain("1/2");
    expect(container.textContent).toContain("Accept All");
    expect(container.textContent).toContain("Reject All");
    expect(container.textContent).not.toContain("Keep All");
    expect(container.textContent).not.toContain("Undo All");
    const reviewActions = Array.from(panel?.querySelectorAll("button") ?? [])
      .map((button) => button.textContent ?? "")
      .filter((label) => label.includes("All"));
    expect(reviewActions[0]).toContain("Reject All");
    expect(reviewActions[1]).toContain("Accept All");
    expect(
      container.querySelector('[aria-label="Accept this change"]'),
    ).toBeNull();
    expect(
      container.querySelector('[aria-label="Reject this change"]'),
    ).toBeNull();
  });
  it("adds the starting-version action without replacing the existing toolbar", () => {
    const starting = vi.fn();
    const current = vi.fn();
    const agent = vi.fn();
    act(() =>
      root.render(
        <ProposedChangesPanel
          change={{
            id: "conflict",
            filePath: "main.tex",
            absolutePath: "/tmp/main.tex",
            oldContent: "current",
            newContent: "agent",
            toolName: "Agent",
            timestamp: 1,
          }}
          threeWay
          onUseStarting={starting}
          onUndo={current}
          onKeep={agent}
        />,
      ),
    );
    const panel = container.querySelector("[data-proposed-changes-panel]")!;
    expect(panel.className).toContain("h-12");
    const buttons = Array.from(panel.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Use Ancestors",
      "Reject All⌘N",
      "Accept All⌘Y",
    ]);
    act(() => buttons.forEach((button) => button.click()));
    expect(starting).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
    expect(agent).toHaveBeenCalledOnce();
  });
});
