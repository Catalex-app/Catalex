import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { usePausedReviewStore } from "@/stores/paused-review-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import type {
  AgentWorkspaceSession,
  AgentWorkspaceChange,
} from "@/lib/agent-workspace";
const session: AgentWorkspaceSession = {
  version: 2,
  sessionId: "old",
  projectRoot: "/project",
  tabId: "a",
  mode: "ask",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  sourceCommit: "fixture-source",
  baselineCommit: "fixture-baseline",
  candidateRoot: "/old/draft",
  warnings: [],
};
const change = {
  id: "edit",
  filePath: "main.tex",
  kind: "modified",
  oldContent: "old",
  newContent: "agent work",
} as AgentWorkspaceChange;
let inspection = { changed: true, revision: "v1", changes: [change] };
beforeEach(() => {
  vi.clearAllMocks();
  inspection = { changed: true, revision: "v1", changes: [change] };
  const tab = useAgentChatStore.getState().tabs[0];
  useAgentChatStore.setState({
    activeTabId: "a",
    tabs: [
      {
        ...tab,
        id: "a",
        agentWorkspace: session,
        pauseState: "paused",
        isStreaming: false,
        isSettling: false,
      },
    ],
  });
  usePausedReviewStore.setState({ pending: {}, backups: {}, busy: false });
  useDocumentStore.setState({
    projectRoot: "/project",
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    sourceViewSnapshot: null,
    files: [],
    saveAllFiles: vi.fn(async () => {}),
    restoreSourceWorkspace: vi.fn(async () => {}),
  });
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "inspect_paused_workspace"
      ? inspection
      : command === "reconcile_agent_workspace"
        ? { session: { ...session, status: "cancelled" }, changes: [change] }
        : undefined,
  );
});
afterEach(() => vi.restoreAllMocks());
describe("paused review choices", () => {
  it("asks before resuming and leaves the sandbox active", async () => {
    expect(await usePausedReviewStore.getState().check("a", "continue")).toBe(
      true,
    );
    expect(useAgentChatStore.getState().tabs[0].agentWorkspace).toEqual(
      session,
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "reconcile_agent_workspace",
      expect.anything(),
    );
  });
  it("does not resume a draft while archive cleanup owns the chat", async () => {
    await usePausedReviewStore.getState().check("a", "continue");
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, isSettling: true })),
    }));
    await expect(
      usePausedReviewStore.getState().answer("a", "Update the draft"),
    ).rejects.toThrow("no longer active");
    expect(invoke).not.toHaveBeenCalledWith(
      "set_agent_workspace_backup",
      expect.anything(),
    );
  });
  it("includes unsaved source buffers in the comparison", async () => {
    useDocumentStore.setState({
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "unsaved user text",
          isDirty: true,
        },
      ],
    });
    await usePausedReviewStore.getState().check("a", "continue");
    expect(invoke).toHaveBeenCalledWith(
      "inspect_paused_workspace",
      expect.objectContaining({
        dirtyBuffers: [
          { relativePath: "main.tex", content: "unsaved user text" },
        ],
      }),
    );
  });
  it("staying paused performs no additional operations", async () => {
    await usePausedReviewStore.getState().check("a", "continue");
    vi.mocked(invoke).mockClear();
    await usePausedReviewStore.getState().answer("a", "Stay paused");
    expect(invoke).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().tabs[0].pauseState).toBe("paused");
  });
  it("refreshes the question if source or draft changes after it opens", async () => {
    await usePausedReviewStore.getState().check("a", "continue");
    inspection = { ...inspection, revision: "v2" };
    await expect(
      usePausedReviewStore.getState().answer("a", "Update the draft"),
    ).rejects.toThrow("changed again");
    expect(usePausedReviewStore.getState().pending.a?.inspection.revision).toBe(
      "v2",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "set_agent_workspace_backup",
      expect.anything(),
    );
  });
  it("reviews the saved draft through the existing queue without running an agent", async () => {
    const enqueue = vi
      .spyOn(useAgentReviewQueueStore.getState(), "enqueue")
      .mockResolvedValue();
    const send = vi
      .spyOn(useAgentChatStore.getState(), "sendPrompt")
      .mockResolvedValue();
    await usePausedReviewStore.getState().check("a", "continue");
    await usePausedReviewStore
      .getState()
      .answer("a", "Review the saved draft first");
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "old" }),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("starts an updated draft retaining the backup", async () => {
    const send = vi
      .spyOn(useAgentChatStore.getState(), "sendPrompt")
      .mockImplementation(async () =>
        useAgentChatStore
          .getState()
          ._setAgentWorkspace("a", { ...session, sessionId: "new" }),
      );
    await usePausedReviewStore.getState().check("a", "continue", undefined);
    await usePausedReviewStore.getState().answer("a", "Update the draft");
    expect(send).toHaveBeenCalledWith(
      expect.stringContaining("agent work"),
      undefined,
    );
    expect(usePausedReviewStore.getState().backups.a[0].sessionId).toBe("old");
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
  });
  it("restores the old draft if starting the replacement fails", async () => {
    vi.spyOn(useAgentChatStore.getState(), "sendPrompt").mockResolvedValue();
    await usePausedReviewStore.getState().check("a", "continue");
    await expect(
      usePausedReviewStore.getState().answer("a", "Update the draft"),
    ).rejects.toThrow();
    expect(useAgentChatStore.getState().tabs[0].agentWorkspace?.sessionId).toBe(
      "old",
    );
    expect(invoke).toHaveBeenCalledWith(
      "set_agent_workspace_backup",
      expect.objectContaining({ backup: false }),
    );
  });
  it("offers fresh continuation when there are no unfinished edits", async () => {
    inspection = { ...inspection, changes: [] };
    vi.spyOn(useAgentChatStore.getState(), "sendPrompt").mockImplementation(
      async () =>
        useAgentChatStore
          .getState()
          ._setAgentWorkspace("a", { ...session, sessionId: "new" }),
    );
    await usePausedReviewStore.getState().check("a", "continue");
    await usePausedReviewStore
      .getState()
      .answer("a", "Continue from the current document");
    expect(useAgentChatStore.getState().tabs[0].agentWorkspace?.sessionId).toBe(
      "new",
    );
  });
});
