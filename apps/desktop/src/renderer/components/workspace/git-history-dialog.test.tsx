import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { GitHistoryDialog } from "./git-history-dialog";

const state = vi.hoisted(() => ({
  isGitOperationRunning: false,
  runGitOperation: vi.fn(
    async (
      _root: string,
      _options: object,
      operation: () => Promise<unknown>,
    ) => operation(),
  ),
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: Object.assign(
    (selector: (value: typeof state) => unknown) => selector(state),
    { getState: () => state },
  ),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Git history dialog", () => {
  let root: Root;
  let host: HTMLDivElement;
  const branchChanged = vi.fn(async () => {});
  const render = async (blocked = false) => {
    await act(async () => {
      root.render(
        <GitHistoryDialog
          projectPath="/project"
          branch="main"
          onClose={() => {}}
          onBranchChanged={branchChanged}
          branchSwitchDisabled={blocked}
        />,
      );
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    state.isGitOperationRunning = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "git_panel_history")
        return [
          {
            hash: "123abcd",
            subject: "Manuscript revision",
            author: "Writer",
            refs: ["HEAD -> main"],
            is_head: true,
          },
        ];
      if (command === "git_panel_branches")
        return [
          { name: "main", is_current: true },
          { name: "draft", is_current: false },
        ];
      return { success: true, message: "Switched branch" };
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
  it("loads readable history while branch changes are blocked by review", async () => {
    await render(true);
    expect(document.body.textContent).toContain("Manuscript revision");
    expect(
      document.querySelector('[role="combobox"]')?.hasAttribute("disabled"),
    ).toBe(true);
    expect(invoke).toHaveBeenCalledWith("git_panel_history", {
      projectRoot: "/project",
      limit: 100,
    });
    expect(state.runGitOperation).not.toHaveBeenCalled();
  });
  it("switches branches through the document reconciliation workflow", async () => {
    await render();
    await act(async () => {
      document
        .querySelector('[role="combobox"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    await act(async () => {
      const option = Array.from(
        document.querySelectorAll('[role="option"]'),
      ).find((item) => item.textContent === "draft") as HTMLElement;
      option.click();
    });
    expect(state.runGitOperation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("git_panel_checkout_branch", {
      projectRoot: "/project",
      branch: "draft",
    });
    expect(branchChanged).toHaveBeenCalledOnce();
  });
  it("shows failed history requests and allows retry", async () => {
    // Initial failures must remain recoverable without closing the dialog.
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("Repository unavailable"),
    );
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Repository unavailable",
    );
    await act(async () => {
      (
        document.querySelector(
          '[aria-label="Refresh Git history"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Manuscript revision");
  });
  it("retains the list and scroll position during refresh and on refresh failure", async () => {
    await render();
    const list = document.querySelector("ol")!;
    const viewport = list.parentElement!;
    viewport.scrollTop = 80;
    let rejectRefresh!: (error: Error) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    await act(async () => {
      (
        document.querySelector(
          '[aria-label="Refresh Git history"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(document.querySelector("ol")).toBe(list);
    expect(viewport.scrollTop).toBe(80);
    await act(async () => rejectRefresh(new Error("Refresh unavailable")));
    expect(document.querySelector("ol")).toBe(list);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Refresh unavailable",
    );
  });
  it("keeps branch switching disabled during a Git operation", async () => {
    state.isGitOperationRunning = true;
    await render();
    expect(
      document.querySelector('[role="combobox"]')?.hasAttribute("disabled"),
    ).toBe(true);
    expect(document.body.textContent).toContain("Manuscript revision");
  });
});
