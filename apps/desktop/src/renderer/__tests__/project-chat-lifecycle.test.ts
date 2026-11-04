import { usePausedReviewStore } from "@/stores/paused-review-store";
import { saveProjectInlineComments } from "@/components/workspace/editor/inline-comment-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import {
  prepareProjectExit,
  restoreProjectChats,
  saveProjectChats,
} from "@/lib/project-chat-lifecycle";

const checkpoints = new Map<string, unknown>();
function checkpointCommand(cmd: string, args?: Record<string, unknown>) {
  if (cmd === "desktop:chat:checkpoint-save")
    checkpoints.set(String(args?.projectRoot), structuredClone(args?.snapshot));
  if (cmd === "desktop:chat:checkpoint-load")
    return checkpoints.get(String(args?.projectRoot)) ?? null;
}

beforeEach(() => {
  checkpoints.clear();
  usePausedReviewStore.setState({ pending: {}, backups: {}, busy: false });
  vi.clearAllMocks();
  localStorage.clear();
  useAgentChatStore.getState().restoreProjectTabs("/one");
  useDocumentStore.setState({
    projectRoot: "/one",
    files: [],
    agentWorkspaceRoot: null,
    saveAllFiles: vi.fn(async () => {}),
    restoreSourceWorkspace: vi.fn(async () => {}),
    agentWorkspaceSessionId: null,
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useProposedChangesStore.setState({ workspaceReview: null });
  vi.mocked(invoke).mockImplementation(async (cmd, args) =>
    cmd === "save_shared_session"
      ? { shared_session_id: "shared" }
      : cmd === "list_shared_sessions"
        ? []
        : checkpointCommand(cmd, args),
  );
});

function runningTabs() {
  const base = useAgentChatStore.getState().tabs[0];
  const tabs = (["claude", "codex"] as const).map((provider) => ({
    ...base,
    id: provider,
    provider,
    isStreaming: true,
    turnPhase: "running" as const,
    sessionId: `${provider}-native`,
    providerSessionIds: { [provider]: `${provider}-native` },
    title: provider,
    messages: [
      {
        type: "user" as const,
        message: { content: [{ type: "text" as const, text: "Keep working" }] },
      },
    ],
  }));
  useAgentChatStore.setState({ tabs, activeTabId: "codex", isStreaming: true });
  return tabs;
}

describe("project chat lifecycle", () => {
  it("does not persist or restore live provider status", async () => {
    runningTabs();
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        providerStatus: "retrying",
      })),
    }));
    await saveProjectChats();
    expect(JSON.stringify(checkpoints.get("/one"))).not.toContain(
      "providerStatus",
    );
    await restoreProjectChats("/one");
    expect(
      useAgentChatStore
        .getState()
        .tabs.every((tab) => tab.providerStatus == null),
    ).toBe(true);
  });
  it("checkpoints active round time without counting time while the app is closed", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10000);
    try {
      runningTabs();
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          roundTiming: {
            elapsedMs: 2000,
            runningSince: 5000,
            waitingFor: [],
            startIndex: 0,
          },
        })),
      }));
      await saveProjectChats();
      expect(
        useAgentChatStore.getState().tabs[0].roundTiming?.runningSince,
      ).toBe(5000);
      now.mockReturnValue(1000000);
      await restoreProjectChats("/one");
      for (const tab of useAgentChatStore.getState().tabs) {
        expect(tab.roundTiming).toMatchObject({
          elapsedMs: 7000,
          runningSince: null,
        });
        expect(tab.pauseState).toBe("paused");
      }
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    "edit",
    "resolve",
    "delete",
  ])("waits for slow comment-only %s for both origins with clean source", async (action) => {
    let release!: () => void;
    const previous = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "update_project_comment")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      else return previous(cmd, args);
    });
    const human = { id: "human", from: 0, to: 1, line: 1, text: "Before" };
    const agent = {
      ...human,
      id: "agent",
      origin: { provider: "codex" as const, sessionId: "test" },
    };
    const comments = [human, agent];
    const saving = saveProjectInlineComments(
      "/one",
      { "main.tex": comments },
      {
        "main.tex":
          action === "delete"
            ? []
            : comments.map((comment) =>
                action === "edit"
                  ? { ...comment, text: "After" }
                  : { ...comment, resolved: true },
              ),
      },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    let left = false;
    const exit = prepareProjectExit().then(() => {
      left = true;
    });
    await vi.waitFor(() =>
      expect(useDocumentStore.getState().saveAllFiles).toHaveBeenCalled(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(left).toBe(false);
    const firstRelease = release;
    firstRelease();
    await vi.waitFor(() => expect(release).not.toBe(firstRelease));
    expect(left).toBe(false);
    release();
    await saving;
    await exit;
    expect(left).toBe(true);
  });
  it("retains an already failed comment save and lets departure retry without losing source saving", async () => {
    const previous = vi.mocked(invoke).getMockImplementation()!;
    let fail = true;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "update_project_comment" && fail)
        throw new Error("Disk full");
      return previous(cmd, args);
    });
    const comment = { id: "retry", from: 0, to: 1, line: 1, text: "Keep me" };
    await expect(
      saveProjectInlineComments("/one", {}, { "main.tex": [comment] }),
    ).rejects.toThrow("Disk full");
    await expect(prepareProjectExit()).rejects.toThrow(
      "Comment changes could not be saved",
    );
    expect(useDocumentStore.getState().saveAllFiles).toHaveBeenCalled();
    expect(useDocumentStore.getState().projectRoot).toBe("/one");
    expect(useAgentChatStore.getState().isLeavingProject).toBe(false);
    fail = false;
    await prepareProjectExit();
  });

  it("migrates the browser checkpoint only after a successful native save", async () => {
    const tabs = runningTabs();
    const key = "catalex-project-chats:/one";
    const legacy = JSON.stringify({ version: 1, tabs, activeTabId: "codex" });
    localStorage.setItem(key, legacy);
    const previous = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd === "desktop:chat:checkpoint-save") throw new Error("Disk full");
      return previous(cmd, args);
    });
    await expect(restoreProjectChats("/one")).rejects.toThrow("Disk full");
    expect(localStorage.getItem(key)).toBe(legacy);
    vi.mocked(invoke).mockImplementation(previous);
    await restoreProjectChats("/one");
    expect(localStorage.getItem(key)).toBeNull();
    expect(checkpoints.get("/one")).toMatchObject({ tabs });
  });

  it("pauses every provider and waits for completion before saving", async () => {
    runningTabs();
    let saved = false;
    const leaving = prepareProjectExit().then(() => {
      saved = true;
    });
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("cancel_codex_execution", {
        tabId: "codex",
      }),
    );
    expect(invoke).toHaveBeenCalledWith("cancel_claude_execution", {
      tabId: "claude",
    });
    expect(saved).toBe(false);
    expect(useDocumentStore.getState().saveAllFiles).not.toHaveBeenCalled();
    for (const tab of useAgentChatStore.getState().tabs)
      useAgentChatStore.getState()._setStreaming(tab.id, false);
    await leaving;
    useAgentChatStore.getState().restoreProjectTabs(null);
    await restoreProjectChats("/one");
    expect(
      useAgentChatStore.getState().tabs.map((tab) => tab.pauseState),
    ).toEqual(["paused", "paused"]);
    expect(useAgentChatStore.getState().activeTabId).toBe("codex");
    expect(useAgentChatStore.getState().tabs[1].providerSessionIds.codex).toBe(
      "codex-native",
    );
  });

  it.each([
    false,
    true,
  ])("does not restore an explicit Stop as paused (terminal event saved=%s)", async (completed) => {
    runningTabs();
    // The other chat is already idle; only the selected chat receives Stop.
    useAgentChatStore.getState()._setStreaming("claude", false);
    await useAgentChatStore.getState().cancelExecution();
    if (completed) useAgentChatStore.getState()._setStreaming("codex", false);
    await saveProjectChats();
    useAgentChatStore.getState().restoreProjectTabs(null);
    await restoreProjectChats("/one");
    const state = useAgentChatStore.getState();
    expect(state.tabs.find((tab) => tab.id === "codex")).toMatchObject({
      isStreaming: false,
      pauseState: null,
      cancelledByUser: false,
      archived: false,
      messages: expect.any(Array),
    });
    expect(state.activeTabId).not.toBe("codex");
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.title).toBe(
      "New Chat",
    );
  });

  it("preserves chats and typed drafts per project across a fresh store", async () => {
    const [first] = runningTabs();
    useAgentChatStore
      .getState()
      .saveDraft(first.id, { input: "Unsaved follow-up", pinnedContexts: [] });
    await saveProjectChats();
    await restoreProjectChats("/two");
    expect(useAgentChatStore.getState().tabs).toHaveLength(1);
    expect(useAgentChatStore.getState().messages).toEqual([]);
    await saveProjectChats();
    await restoreProjectChats("/one");
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe(
      "Unsaved follow-up",
    );
    expect(useAgentChatStore.getState().tabs[0].runtimeSessionKey).not.toBe(
      first.runtimeSessionKey,
    );
    expect(
      useAgentChatStore
        .getState()
        .tabs.every((tab) => !tab.isStreaming && tab.pauseState === "paused"),
    ).toBe(true);
    expect(
      useAgentChatStore.getState().messages[0].message?.content?.[0]?.text,
    ).toBe("Keep working");
  });

  it("keeps a pre-launch request but does not retry an already dispatched prompt", async () => {
    const tabs = runningTabs().map((tab, index) => ({
      ...tab,
      turnPhase: index === 0 ? ("preparing" as const) : ("starting" as const),
      pausedRequest: { prompt: "original" },
    }));
    useAgentChatStore.setState({ tabs });
    await saveProjectChats();
    await restoreProjectChats("/one");
    const restored = useAgentChatStore.getState().tabs;
    expect(restored[0].pausedRequest?.prompt).toBe("original");
    expect(restored[1].pausedRequest).toBeNull();
    expect(restored.every((tab) => tab.turnPhase === null)).toBe(true);
  });

  it("opens unarchived history and focuses an empty chat after an idle exit", async () => {
    const original = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [
        {
          ...original,
          sharedSessionId: "existing",
          title: "Existing",
          draft: { input: "keep draft", pinnedContexts: [] },
        },
      ],
    });
    await saveProjectChats();
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd.startsWith("desktop:chat:checkpoint-"))
        return checkpointCommand(cmd, args);
      if (cmd === "list_shared_sessions")
        return [
          { shared_session_id: "existing", archived: false },
          { shared_session_id: "history", archived: false },
          { shared_session_id: "archived", archived: true },
        ];
      if (cmd === "load_shared_session")
        return {
          shared_session_id: args?.sharedSessionId,
          title: "Older chat",
          last_provider: "codex",
          messages: [],
          provider_session_ids: { codex: "native-history" },
        };
    });
    await restoreProjectChats("/one");
    const state = useAgentChatStore.getState();
    expect(state.tabs).toHaveLength(3);
    expect(
      state.tabs.find((tab) => tab.sharedSessionId === "existing")?.draft.input,
    ).toBe("keep draft");
    expect(
      state.tabs.find((tab) => tab.sharedSessionId === "history")?.sessionId,
    ).toBe("native-history");
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.title).toBe(
      "New Chat",
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "load_shared_session",
      expect.objectContaining({ sharedSessionId: "archived" }),
    );
  });

  it("selects a paused chat even when the previously active chat was idle", async () => {
    runningTabs();
    const empty = useAgentChatStore.getState().createTab();
    await saveProjectChats();
    await restoreProjectChats("/one");
    const state = useAgentChatStore.getState();
    expect(state.activeTabId).not.toBe(empty);
    expect(
      state.tabs.find((tab) => tab.id === state.activeTabId)?.pauseState,
    ).toBe("paused");
    expect(state.tabs).toHaveLength(2);
  });

  it.each([
    ["b", "b", "c"],
    ["d", "d", "c"],
    ["c", "b", "b"],
  ])("archiving %s with focus on %s selects %s", (archivedId, activeId, expected) => {
    const base = useAgentChatStore.getState().tabs[0];
    const tabs = ["a", "b", "hidden", "c", "d"].map((id) => ({
      ...base,
      id,
      sharedSessionId: id,
      archived: id === "hidden",
    }));
    useAgentChatStore.setState({ tabs, activeTabId: activeId });
    useAgentChatStore.getState().updateSessionArchive(archivedId, true);
    expect(useAgentChatStore.getState().activeTabId).toBe(expected);
  });

  it("archives a saved tab without losing its local draft and selects another chat", async () => {
    const original = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [
        {
          ...original,
          sharedSessionId: "shared",
          draft: { input: "keep", pinnedContexts: [] },
        },
      ],
    });
    await useAgentChatStore.getState().archiveTab(original.id);
    const state = useAgentChatStore.getState();
    expect(state.tabs.find((tab) => tab.id === original.id)).toMatchObject({
      archived: true,
      draft: { input: "keep" },
    });
    expect(state.activeTabId).not.toBe(original.id);
    expect(invoke).toHaveBeenCalledWith("set_shared_session_archived", {
      projectPath: "/one",
      sharedSessionId: "shared",
      archived: true,
    });
    state.updateSessionArchive("shared", false);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === original.id)
        ?.archived,
    ).toBe(false);
  });

  it.each([
    "streaming",
    "busy",
    "runtime",
    "project",
    "queue",
  ])("does not archive when %s changes while saving", async (change) => {
    const base = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [{ ...base, sharedSessionId: "shared" }],
    });
    let finishSave!: (value: unknown) => void;
    const saved = new Promise((resolve) => {
      finishSave = resolve;
    });
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((cmd, args) =>
      cmd === "save_shared_session" ? (saved as any) : original(cmd, args),
    );
    const archiving = useAgentChatStore.getState().archiveTab(base.id);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "save_shared_session",
        expect.anything(),
      ),
    );
    if (change === "busy") usePausedReviewStore.setState({ busy: true });
    if (change === "project")
      useDocumentStore.setState({ projectRoot: "/other" });
    if (change === "queue")
      useAgentReviewQueueStore.setState({
        entries: [{ session: { tabId: base.id }, phase: "queued" } as any],
      });
    if (change === "streaming" || change === "runtime") {
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          ...(change === "streaming"
            ? { isStreaming: true }
            : { runtimeSessionKey: "replacement" }),
        })),
      }));
    }
    finishSave({ shared_session_id: "shared" });
    await archiving;
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([cmd]) => cmd === "set_shared_session_archived"),
    ).toBe(false);
    expect(useAgentChatStore.getState().tabs[0].archived).toBeFalsy();
  });

  it("archives a paused chat without restoring its discarded workspace", async () => {
    const base = useAgentChatStore.getState().tabs[0];
    const paused = {
      ...base,
      sharedSessionId: "shared",
      pauseState: "paused" as const,
      agentWorkspace: {
        sessionId: "draft",
        tabId: base.id,
        projectRoot: "/one",
        candidateRoot: "/candidate",
      } as any,
      draft: { input: "later", pinnedContexts: [] },
    };
    useAgentChatStore.setState({ tabs: [paused] });
    await useAgentChatStore.getState().archiveTab(base.id);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === base.id),
    ).toMatchObject({
      ...paused,
      archived: true,
      agentWorkspace: null,
      pauseState: null,
      pausedRequest: null,
      retryRequest: null,
      pendingQuestion: null,
    });
    useAgentChatStore.getState().updateSessionArchive("shared", false);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === base.id),
    ).toMatchObject({
      ...paused,
      archived: false,
      agentWorkspace: null,
      pauseState: null,
      pausedRequest: null,
      retryRequest: null,
      pendingQuestion: null,
    });
  });

  it("archives a paused refinement and discards its draft and resume state", async () => {
    const base = useAgentChatStore.getState().tabs[0];
    const session = {
      sessionId: "draft",
      tabId: base.id,
      projectRoot: "/one",
      candidateRoot: "/candidate",
      status: "active",
    } as any;
    const messages = [
      {
        type: "assistant" as const,
        message: {
          content: [{ type: "text" as const, text: "Partial refinement" }],
        },
      },
    ];
    useAgentChatStore.setState({
      tabs: [
        {
          ...base,
          messages,
          sharedSessionId: "shared",
          pauseState: "paused",
          pendingQuestion: {
            requestId: "q",
            projectRoot: "/one",
            question: "Continue?",
            options: [],
          },
          pausedRequest: { prompt: "Resume this" },
          agentWorkspace: session,
          roundTiming: {
            elapsedMs: 12000,
            runningSince: null,
            startIndex: 0,
            waitingFor: [],
          },
        },
      ],
    });
    useAgentReviewQueueStore.setState({
      entries: [{ session, phase: "revising", conflicts: [] }],
    });
    usePausedReviewStore.setState({
      backups: { [base.id]: [{ ...session, sessionId: "backup" }] },
      pending: {
        [base.id]: {
          session,
          inspection: { changed: true, revision: "v1", changes: [] },
          prompt: "Resume",
        },
      },
    });
    await useAgentChatStore.getState().archiveTab(base.id);
    const archived = useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === base.id)!;
    expect(archived).toMatchObject({
      archived: true,
      agentWorkspace: null,
      roundTiming: { elapsedMs: 12000, finished: true },
    });
    expect(archived.messages[0].roundDurationMs).toBe(12000);
    expect(archived.pendingQuestion).toBeNull();
    expect(archived.pausedRequest).toBeNull();
    expect(usePausedReviewStore.getState().pending[base.id]).toBeUndefined();
    expect(usePausedReviewStore.getState().backups[base.id]).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("discard_agent_workspace", {
      projectRoot: "/one",
      sessionId: "backup",
    });
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(commands.indexOf("dispose_claude_session")).toBeLessThan(
      commands.indexOf("discard_agent_workspace"),
    );
    expect(commands.indexOf("dispose_codex_session")).toBeLessThan(
      commands.indexOf("discard_agent_workspace"),
    );
    expect(commands.lastIndexOf("discard_agent_workspace")).toBeLessThan(
      commands.indexOf("set_shared_session_archived"),
    );
    const saved = checkpoints.get("/one") as {
      tabs: Array<{
        id: string;
        pauseState: unknown;
        agentWorkspace: unknown;
        pendingQuestion: unknown;
      }>;
    };
    expect(saved.tabs.find((tab) => tab.id === base.id)).toMatchObject({
      pauseState: null,
      agentWorkspace: null,
      pendingQuestion: null,
    });

    expect(invoke).toHaveBeenCalledWith("discard_agent_workspace", {
      projectRoot: "/one",
      sessionId: "draft",
    });
    useAgentChatStore.getState().updateSessionArchive("shared", false);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === base.id),
    ).toMatchObject({
      archived: false,
      pauseState: null,
      agentWorkspace: null,
    });
  });

  it("blocks archiving while a pause is still in flight", async () => {
    const base = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [{ ...base, sharedSessionId: "shared", pauseState: "pausing" }],
    });
    await useAgentChatStore.getState().archiveTab(base.id);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_shared_session_archived",
      expect.anything(),
    );
  });

  it.each([
    "checking",
    "applying",
    "review",
    "queued",
    "question",
    "resume-dialog",
  ])("does not discard a paused workspace while %s is in progress", async (phase) => {
    const base = useAgentChatStore.getState().tabs[0];
    const session = {
      sessionId: "draft",
      tabId: base.id,
      projectRoot: "/one",
    } as any;
    useAgentChatStore.setState({
      tabs: [
        {
          ...base,
          sharedSessionId: "shared",
          pauseState: "paused",
          agentWorkspace: session,
        },
      ],
    });
    if (phase === "resume-dialog")
      usePausedReviewStore.setState({ busy: true });
    else
      useAgentReviewQueueStore.setState({
        entries: [
          {
            session,
            phase: phase as
              | "checking"
              | "applying"
              | "review"
              | "queued"
              | "question",
            conflicts: [],
          },
        ],
      });
    await useAgentChatStore.getState().archiveTab(base.id);
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "set_shared_session_archived",
      expect.anything(),
    );
  });

  it("keeps the current draft intact if deleting a backup fails", async () => {
    const base = useAgentChatStore.getState().tabs[0];
    const session = {
      sessionId: "draft",
      tabId: base.id,
      projectRoot: "/one",
    } as any;
    useAgentChatStore.setState({
      tabs: [
        {
          ...base,
          sharedSessionId: "shared",
          pauseState: "paused",
          agentWorkspace: session,
        },
      ],
    });
    usePausedReviewStore.setState({
      backups: { [base.id]: [{ ...session, sessionId: "backup" }] },
    });
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "discard_agent_workspace" && args?.sessionId === "backup")
        throw new Error("Backup deletion failed");
      return original(command, args);
    });
    await expect(
      useAgentChatStore.getState().archiveTab(base.id),
    ).rejects.toThrow("Backup deletion failed");
    expect(invoke).not.toHaveBeenCalledWith("discard_agent_workspace", {
      projectRoot: "/one",
      sessionId: "draft",
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      agentWorkspace: session,
      pauseState: "paused",
      isSettling: false,
    });
    vi.mocked(invoke).mockImplementation(original);
    await useAgentChatStore.getState().archiveTab(base.id);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === base.id),
    ).toMatchObject({ archived: true, agentWorkspace: null });
  });

  it("keeps a paused draft recoverable if deletion fails and supports retry", async () => {
    const base = useAgentChatStore.getState().tabs[0];
    const session = {
      sessionId: "draft",
      tabId: base.id,
      projectRoot: "/one",
    } as any;
    useAgentChatStore.setState({
      tabs: [
        {
          ...base,
          sharedSessionId: "shared",
          pauseState: "paused",
          agentWorkspace: session,
        },
      ],
    });
    useAgentReviewQueueStore.setState({
      entries: [{ session, phase: "revising", conflicts: [] }],
    });
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "discard_agent_workspace")
        throw new Error("Disk unavailable");
      return original(command, args);
    });
    await expect(
      useAgentChatStore.getState().archiveTab(base.id),
    ).rejects.toThrow("Disk unavailable");
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      pauseState: "paused",
      agentWorkspace: session,
      isSettling: false,
    });
    expect(useAgentReviewQueueStore.getState().entries).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_shared_session_archived",
      expect.anything(),
    );
    vi.mocked(invoke).mockImplementation(original);
    await useAgentChatStore.getState().archiveTab(base.id);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === base.id),
    ).toMatchObject({ archived: true, agentWorkspace: null, pauseState: null });
  });

  it("keeps the tab visible when saving before archive fails", async () => {
    const tab = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({
      tabs: [{ ...tab, sharedSessionId: "shared" }],
    });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk failure"));
    await expect(
      useAgentChatStore.getState().archiveTab(tab.id),
    ).rejects.toThrow("disk failure");
    expect(useAgentChatStore.getState().tabs[0].archived).not.toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_shared_session_archived",
      expect.anything(),
    );
  });

  it("does not archive interrupted or running work", async () => {
    const tabs = runningTabs();
    await useAgentChatStore.getState().archiveTab(tabs[0].id);
    expect(invoke).not.toHaveBeenCalledWith(
      "set_shared_session_archived",
      expect.anything(),
    );
    expect(useAgentChatStore.getState().tabs).toHaveLength(2);
  });

  it("retains the workspace when a provider rejects pause", async () => {
    runningTabs();
    vi.mocked(invoke).mockRejectedValue(new Error("interrupt failed"));
    await expect(prepareProjectExit()).rejects.toThrow("Could not pause");
    expect(useAgentChatStore.getState().isLeavingProject).toBe(false);
    expect(useDocumentStore.getState().projectRoot).toBe("/one");
    expect(useAgentChatStore.getState().tabs).toHaveLength(2);
  });

  it("close anyway skips only comments and still blocks on manuscript save failure", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "update_project_comment")
        throw new Error("Comments unavailable");
    });
    await expect(
      saveProjectInlineComments(
        "/one",
        {},
        {
          "main.tex": [
            { id: "discard", from: 0, to: 1, line: 1, text: "Unsaved" },
          ],
        },
      ),
    ).rejects.toThrow("Comments unavailable");
    const save = vi.mocked(useDocumentStore.getState().saveAllFiles);
    save.mockRejectedValueOnce(new Error("Source unavailable"));
    await expect(
      prepareProjectExit({ skipCommentWrites: true }),
    ).rejects.toThrow("Source unavailable");
    expect(useAgentChatStore.getState().isLeavingProject).toBe(false);
    vi.mocked(invoke).mockClear();
    await prepareProjectExit({ skipCommentWrites: true });
    expect(save).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "update_project_comment",
      expect.anything(),
    );
  });

  it("blocks departure on a storage error", async () => {
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw new Error("quota");
    });
    await expect(prepareProjectExit()).rejects.toThrow("quota");
    expect(useAgentChatStore.getState().isLeavingProject).toBe(false);
  });

  it("captures review edits without saving them over source files", async () => {
    const capture = vi.spyOn(
      useAgentReviewQueueStore.getState(),
      "captureEdits",
    );
    useDocumentStore.setState({ agentWorkspaceRoot: "/draft" });
    await prepareProjectExit();
    expect(capture).toHaveBeenCalled();
    expect(useDocumentStore.getState().saveAllFiles).not.toHaveBeenCalled();
    capture.mockRestore();
  });

  it("waits for reconciliation after streaming ends", async () => {
    const tab = useAgentChatStore.getState().tabs[0];
    useAgentChatStore.setState({ tabs: [{ ...tab, isSettling: true }] });
    let finished = false;
    const leaving = prepareProjectExit().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(finished).toBe(false);
    useAgentChatStore.setState({ tabs: [{ ...tab, isSettling: false }] });
    await leaving;
    expect(finished).toBe(true);
  });
});

it("releases inactive full and paged histories only after the save succeeds", async () => {
  const base = useAgentChatStore.getState().tabs[0];
  const message = { type: "user" as const, message: { content: [] } };
  const full = { ...base, id: "idle-full", messages: [message] };
  const paged = {
    ...base,
    id: "idle-page",
    messages: [message],
    history: { total: 1000, start: 999 },
  };
  useAgentChatStore.setState({
    tabs: [base, full, paged],
    activeTabId: base.id,
  });
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "desktop:chat:checkpoint-save")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  });
  const saving = saveProjectChats();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(useAgentChatStore.getState().tabs[1].messages).toHaveLength(1);
  expect(useAgentChatStore.getState().tabs[2].messages).toHaveLength(1);
  release();
  await saving;
  const tabs = useAgentChatStore.getState().tabs;
  expect(tabs[1]).toMatchObject({
    messages: [],
    history: { total: 1, start: 1 },
  });
  expect(tabs[2]).toMatchObject({
    messages: [],
    history: { total: 1000, start: 1000 },
  });
});

it("keeps open pop-out history loaded and releases it after the window closes", async () => {
  runningTabs();
  useAgentChatStore.setState((state) => ({
    isStreaming: false,
    tabs: state.tabs.map((tab) => ({
      ...tab,
      isStreaming: false,
      turnPhase: null,
    })),
  }));
  const child = { closed: false };
  const original = window.__catalexPanelSessions;
  window.__catalexPanelSessions = new Map([
    [
      "test",
      {
        kind: "chat",
        chatId: "claude",
        window: child,
      } as unknown as import("@/lib/panel-window-runtime").PanelWindowSession,
    ],
  ]);
  try {
    await saveProjectChats();
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "claude")
        ?.messages,
    ).toHaveLength(1);
    child.closed = true;
    await saveProjectChats();
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "claude")
        ?.messages,
    ).toEqual([]);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === "codex")
        ?.messages,
    ).toHaveLength(1);
  } finally {
    window.__catalexPanelSessions = original;
  }
});
