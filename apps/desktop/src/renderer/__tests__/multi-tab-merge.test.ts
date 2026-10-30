import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useSettingsStore } from "@/stores/settings-store";
import { readTexFileContent } from "@/lib/project-files";
import {
  type AgentWorkspaceSession,
  recoverLatestAgentWorkspace,
} from "@/lib/agent-workspace";

const mockWorkspaceSession: AgentWorkspaceSession = {
  version: 2,
  sessionId: "workspace-session",
  projectRoot: "/project",
  tabId: "tab-default",
  mode: "ask",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  sourceCommit: "fixture-source",
  baselineCommit: "fixture-baseline",
  candidateRoot: "/workspace/candidate",
  warnings: [],
};

// ─── Mocks ───

vi.mock("@/stores/document-store", () => ({
  resolveTexRoot: vi.fn((activeFileId: string | null, files: any[]) => {
    if (activeFileId) return activeFileId;
    return files.find((file) => file.type === "tex")?.id ?? "";
  }),
  useDocumentStore: {
    getState: vi.fn(() => ({
      projectRoot: "/project",
      files: [],
      activeFileId: null,
      selectionRange: null,
      reloadFile: vi.fn(),
      refreshFiles: vi.fn(() => Promise.resolve()),
      saveAllFiles: vi.fn(() => Promise.resolve()),
      activateAgentWorkspace: vi.fn(() => Promise.resolve()),
      setAgentWorkspaceReadOnly: vi.fn(),
      restoreSourceWorkspace: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      createSnapshot: vi.fn(() => Promise.resolve()),
    })),
  },
}));

vi.mock("@/lib/project-files", () => ({
  writeTexFileContent: vi.fn(() => Promise.resolve()),
  readTexFileContent: vi.fn(() => Promise.resolve("")),
}));

function resetStores() {
  useAgentReviewQueueStore.setState({ entries: [] });
  useClaudeSetupStore.setState({
    models: [],
    modelsStatus: "idle",
    modelsError: null,
  });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "inspect_paused_workspace")
      return { changed: false, revision: "unchanged", changes: [] };
    if (command !== "prepare_agent_workspace") return undefined;
    const workspaceArgs = args as
      | { tabId?: string; mode?: "ask" | "edit" }
      | undefined;
    return {
      ...mockWorkspaceSession,
      tabId: workspaceArgs?.tabId ?? "tab-default",
      mode: workspaceArgs?.mode === "edit" ? "edit" : "ask",
    } as any;
  });
  vi.mocked(readTexFileContent).mockReset();
  vi.mocked(readTexFileContent).mockResolvedValue("");
  vi.mocked(useDocumentStore.getState).mockReturnValue({
    projectRoot: "/project",
    files: [],
    activeFileId: null,
    selectionRange: null,
    reloadFile: vi.fn(),
    refreshFiles: vi.fn(() => Promise.resolve()),
    saveAllFiles: vi.fn(() => Promise.resolve()),
    activateAgentWorkspace: vi.fn(() => Promise.resolve()),
    setAgentWorkspaceReadOnly: vi.fn(),
    restoreSourceWorkspace: vi.fn(() => Promise.resolve()),
  } as any);
  useAgentChatStore.setState({
    selectedProvider: "claude",
    messages: [],
    sessionId: null,
    isStreaming: false,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    selectedClaudeModel: "opus",
    selectedClaudeExecutionMode: "default",
    selectedCodexModel: "gpt-5.4",
    selectedCodexReasoningEffort: "medium",
    selectedCodexExecutionMode: "default",
    selectedPiModel: JSON.stringify(["fixture", "pi-model"]),
    selectedPiReasoningEffort: "medium",
    effortLevel: "medium",
    drawerOpenRequested: false,
    tabs: [
      {
        id: "tab-default",
        runtimeSessionKey: "runtime-session-test",
        title: "New Chat",
        provider: "claude",
        sessionId: null,
        sharedSessionId: null,
        providerSessionIds: {},
        providerSyncCursors: {},
        pendingCrossProviderTranscript: null,
        messages: [],
        isStreaming: false,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        draft: { input: "", pinnedContexts: [] },
        pendingResumeChoice: null,
        pendingFileBaseline: null,
        pendingClaudeExecutionMode: null,
      },
    ],
    activeTabId: "tab-default",
  });
  useSettingsStore.setState({
    enabledProviders: { claude: true, codex: true, pi: true },
    piBinaryPath: "/fixture/bin/pi",
    piConfigDirectory: "/fixture/agent",
    globalAgentPrompt: "",
  });
  usePiSetupStore.setState({
    models: [
      {
        id: "pi-model",
        provider: "fixture",
        name: "Pi model",
        reasoning: true,
        thinkingLevelMap: { medium: null },
      },
    ],
    modelsStatus: "ready",
  });
  useProposedChangesStore.setState({
    changes: [],
    activeProjectRoot: null,
    changesByProject: {},
    workspaceReview: null,
    workspaceReviewsByProject: {},
  });
}

// ─── Tests ───

describe("Multi-tab merge triggers", () => {
  beforeEach(resetStores);

  it.each([
    true,
    false,
  ])("only blocks compaction for an unanswered question (answered=%s)", async (answered) => {
    useAgentChatStore.setState((state) => ({
      chatProjectRoot: "/project",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        sessionId: "native-session",
        providerSessionIds: { claude: "native-session" },
        pendingQuestion: {
          requestId: "comment-choice",
          projectRoot: "/project",
          question: "Update comments?",
          options: [],
        },
        messages: answered
          ? [
              {
                type: "user",
                uuid: "question-answer-comment-choice",
                subtype: "question_answer",
                message: { content: [{ type: "text", text: "Update" }] },
              },
            ]
          : [],
      })),
    }));
    const accepted = vi.fn();
    await useAgentChatStore
      .getState()
      .sendPrompt("/compact Continue editing", [], false, accepted);
    if (!answered) {
      expect(accepted).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(useAgentChatStore.getState().tabs[0].error).toBe(
        "Answer the pending question before compacting.",
      );
      return;
    }
    expect(accepted).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "compact_claude_session",
      expect.objectContaining({ sessionId: "native-session" }),
    );
    useAgentChatStore.getState()._finishCompaction("tab-default", true);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "resume_claude_code",
        expect.objectContaining({
          prompt: expect.stringContaining("Continue editing"),
        }),
      ),
    );
    expect(useAgentChatStore.getState().tabs[0].queuedPrompts).toEqual([]);
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("compacts %s natively and waits before dispatching its follow-up", async (provider) => {
    const store = useAgentChatStore.getState();
    useAgentChatStore.setState((state) => ({
      chatProjectRoot: "/project",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        sessionId: "native-session",
        providerSessionIds: { [provider]: "native-session" },
        providerSyncCursors: { [provider]: 7 },
      })),
    }));
    const accepted = vi.fn();
    await store.sendPrompt("/compact Fix the tests", [], false, accepted);
    expect(accepted).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      `compact_${provider}_session`,
      expect.objectContaining({ sessionId: "native-session" }),
    );
    if (provider === "pi") {
      expect(invoke).toHaveBeenCalledWith(
        "compact_pi_session",
        expect.objectContaining({
          piConfig: {
            binaryPath: "/fixture/bin/pi",
            configDirectory: "/fixture/agent",
          },
          model: JSON.stringify(["fixture", "pi-model"]),
          reasoningEffort: "high",
        }),
      );
    }
    const pending = useAgentChatStore.getState().tabs[0];
    expect(pending.compacting).toBe(true);
    expect(pending.queuedPrompts?.[0]).toMatchObject({
      prompt: "Fix the tests",
      provider,
    });
    expect(pending.messages).toEqual([]);
    expect(pending.providerSyncCursors).toEqual({ [provider]: 7 });
    const drain = vi
      .spyOn(useAgentChatStore.getState(), "_runNextQueuedPrompt")
      .mockResolvedValue();
    store._finishCompaction("tab-default", true);
    expect(drain).toHaveBeenCalledWith("tab-default");
    expect(useAgentChatStore.getState().tabs[0].providerSyncCursors).toEqual({
      [provider]: 7,
    });
    drain.mockRestore();
  });

  it.each([
    "claude",
    "pi",
  ] as const)("dispatches the queued text as a normal resumed %s prompt after compaction", async (provider) => {
    useAgentChatStore.setState((state) => ({
      chatProjectRoot: "/project",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        sessionId: "native-session",
        providerSessionIds: { [provider]: "native-session" },
      })),
    }));
    await useAgentChatStore.getState().sendPrompt("/compact Fix the tests");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === `resume_${provider}_code`),
    ).toBe(false);
    useAgentChatStore.getState()._finishCompaction("tab-default", true);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        `resume_${provider}_code`,
        expect.objectContaining({
          sessionId: "native-session",
          prompt: expect.stringContaining("Fix the tests"),
        }),
      ),
    );
    expect(useAgentChatStore.getState().tabs[0].queuedPrompts).toEqual([]);
  });

  it("preserves and pauses a follow-up when compaction fails", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, sessionId: "native-session" })),
    }));
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("fixture compact failure"),
    );
    await useAgentChatStore.getState().sendPrompt("/compact Continue later");
    const tab = useAgentChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    expect(tab.promptQueuePaused).toBe(true);
    expect(tab.error).toContain("fixture compact failure");
    expect(tab.queuedPrompts?.[0].prompt).toBe("Continue later");
  });

  it("keeps a canceled compaction follow-up paused and bound to its provider", async () => {
    useAgentChatStore.setState((state) => ({
      chatProjectRoot: "/project",
      tabs: state.tabs.map((tab) => ({ ...tab, sessionId: "native-session" })),
    }));
    await useAgentChatStore.getState().sendPrompt("/compact Next request");
    await useAgentChatStore.getState().cancelExecution();
    useAgentChatStore.getState()._finishCompaction("tab-default", true);
    expect(useAgentChatStore.getState().tabs[0].promptQueuePaused).toBe(true);
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "codex",
        error: null,
        promptQueuePaused: false,
      })),
    }));
    vi.mocked(invoke).mockClear();
    await useAgentChatStore.getState()._runNextQueuedPrompt("tab-default");
    expect(invoke).not.toHaveBeenCalled();
    expect(
      useAgentChatStore.getState().tabs[0].queuedPrompts?.[0].provider,
    ).toBe("claude");
  });

  it.each([
    "Please /compact this",
    "/compaction",
  ])("does not interpret %s as a native command", async (prompt) => {
    await useAgentChatStore.getState().sendPrompt(prompt);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command.startsWith("compact_")),
    ).toBe(false);
  });

  it("requires an existing native session and does not consume the draft", async () => {
    const accepted = vi.fn();
    await useAgentChatStore
      .getState()
      .sendPrompt("/compact", [], false, accepted);
    expect(accepted).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().tabs[0].error).toContain(
      "conversation before compacting",
    );
  });

  it.each([
    true,
    false,
  ])("preserves a local error stop (answer present=%s) without a completion event", (hasAnswer) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(9000);
    try {
      const id = useAgentChatStore.getState().activeTabId;
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          isStreaming: true,
          roundTiming: {
            elapsedMs: 2000,
            runningSince: 4000,
            startIndex: 0,
            waitingFor: [],
          },
          messages: hasAnswer
            ? [
                {
                  type: "assistant" as const,
                  message: {
                    content: [
                      { type: "text" as const, text: "Partial answer" },
                    ],
                  },
                },
              ]
            : [],
        })),
      }));
      const store = useAgentChatStore.getState();
      store._setError(id, "Execution failed");
      store._setStreaming(id, false);
      const stopped = useAgentChatStore.getState().tabs[0];
      expect(stopped.roundTiming).toMatchObject({
        elapsedMs: 7000,
        runningSince: null,
        finished: true,
      });
      expect(stopped.messages[0]).toMatchObject({
        roundDurationMs: 7000,
        roundCompletedAt: 9000,
      });
      clock.mockReturnValue(20000);
      store._finishRoundTiming(id);
      expect(useAgentChatStore.getState().tabs[0].messages).toBe(
        stopped.messages,
      );
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "claude",
    "codex",
  ] as const)("saves each stopped %s round and starts a fresh timer on Continue", async (provider) => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      await useAgentChatStore.getState().sendPrompt("Review this");
      const store = useAgentChatStore.getState();
      const id = store.activeTabId;
      const timing = () =>
        useAgentChatStore.getState().tabs.find((tab) => tab.id === id)!
          .roundTiming!;
      expect(timing().runningSince).toBe(1000);
      expect(store.messages[0].sentAt).toBe(1000);
      now = 6000;
      await store.pauseExecution();
      expect(timing().runningSince).toBe(1000); // Pausing is still work until acknowledged.
      now = 8000;
      store._finishRoundTiming(id);
      store._setStreaming(id, false);
      expect(timing().elapsedMs).toBe(7000);
      expect(
        useAgentChatStore.getState().messages.slice(-1)[0]?.roundDurationMs,
      ).toBe(7000);
      now = 68000;
      await useAgentChatStore.getState().continueExecution();
      expect(timing()).toMatchObject({ elapsedMs: 0, runningSince: 68000 });
      now = 71000;
      store._setRoundWaiting(id, "question", true);
      store._setRoundWaiting(id, "permission", true);
      expect(timing()).toMatchObject({ elapsedMs: 3000, runningSince: null });
      now = 171000;
      store._setRoundWaiting(id, "question", false);
      expect(timing().runningSince).toBeNull();
      store._setRoundWaiting(id, "permission", false);
      expect(timing().runningSince).toBe(171000);
      now = 175000;
      store._appendMessage(id, {
        type: "assistant",
        message: { content: [{ type: "text", text: "Done" }] },
      });
      store._finishRoundTiming(id);
      store._setStreaming(id, false);
      expect(timing()).toMatchObject({
        elapsedMs: 7000,
        runningSince: null,
        finished: true,
      });
      expect(
        useAgentChatStore.getState().messages.slice(-1)[0]?.roundDurationMs,
      ).toBe(7000);
      now = 190000;
      store._finishRoundTiming(id); // Late/duplicate completion cannot change the recorded time.
      expect(timing().elapsedMs).toBe(7000);
      expect(
        useAgentChatStore.getState().messages.slice(-1)[0]?.roundCompletedAt,
      ).toBe(175000);
      store._setAgentWorkspace(id, null);
      const nextProvider = provider === "claude" ? "codex" : "claude";
      store.setProvider(nextProvider);
      expect(useAgentChatStore.getState().selectedProvider).toBe(nextProvider);
      await useAgentChatStore.getState().sendPrompt("A new task");
      expect(timing()).toMatchObject({ elapsedMs: 0, runningSince: 190000 });
      expect(
        useAgentChatStore.getState().messages.slice(-2)[0]?.roundDurationMs,
      ).toBe(7000);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    "codex",
    "claude",
  ] as const)("continues a restored %s question using a new turn, not an expired MCP request", async (provider) => {
    const pendingQuestion = {
      requestId: "old-request",
      projectRoot: "/project",
      question: "How should I handle the changed paragraph?",
      options: [{ label: "Update" }, { label: "Discard" }],
    };
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        pendingQuestion,
        sessionId: "existing-thread",
        providerSessionIds: { [provider]: "existing-thread" },
      })),
    }));
    await useAgentChatStore
      .getState()
      ._answerRestoredQuestion("tab-default", "old-request", "Update");
    expect(invoke).toHaveBeenCalledWith(
      `resume_${provider}_code`,
      expect.objectContaining({
        sessionId: "existing-thread",
        prompt: expect.stringContaining("My answer: Update"),
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "answer_agent_question",
      expect.anything(),
    );
    expect(useAgentChatStore.getState().tabs[0].pendingQuestion).toBeNull();
    expect(
      useAgentChatStore.getState().messages[0].message?.content?.[0].text,
    ).toContain(pendingQuestion.question);
  });

  it("keeps a restored question answerable when starting its continuation is blocked", async () => {
    const pendingQuestion = {
      requestId: "old-request",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard" }],
    };
    useAgentChatStore.setState((state) => ({
      tabs: [
        {
          ...state.tabs[0],
          pendingQuestion,
          agentWorkspace: { ...mockWorkspaceSession, status: "review" },
        },
        { ...state.tabs[0], id: "busy", isStreaming: true },
      ],
    }));
    await expect(
      useAgentChatStore
        .getState()
        ._answerRestoredQuestion("tab-default", "old-request", "Update"),
    ).rejects.toThrow();
    expect(useAgentChatStore.getState().tabs[0].pendingQuestion).toEqual(
      pendingQuestion,
    );
    expect(useAgentChatStore.getState().messages).toEqual([]);
  });

  describe("proposed-changes-store is tab-independent (file-scoped)", () => {
    it("changes from tab A are visible when viewing tab B", () => {
      const chat = useAgentChatStore.getState();

      // Create two tabs
      const tabB = chat.createTab();

      // Simulate: tab A's stream triggers a file change
      useProposedChangesStore.getState().addChange({
        id: "tool-from-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original content",
        newContent: "edited by tab A",
        toolName: "Edit",
      });

      // Switch to tab B
      chat.setActiveTab(tabB);

      // Proposed change should still be visible — it's file-scoped, not tab-scoped
      const change = useProposedChangesStore
        .getState()
        .getChangeForFile("main.tex");
      expect(change).toBeDefined();
      expect(change!.id).toBe("tool-from-tab-a");
      expect(change!.newContent).toBe("edited by tab A");
    });

    it("resolving a change from tab B works even though tab A triggered it", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Tab A triggered a change
      useProposedChangesStore.getState().addChange({
        id: "tool-from-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "edited",
        toolName: "Edit",
      });

      // User views tab B and resolves the change
      chat.setActiveTab(tabB);
      useProposedChangesStore.getState().resolveChange("tool-from-tab-a");

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
    });
  });

  describe("concurrent file edits from different tabs merge correctly", () => {
    it("second edit to same file preserves original baseline from first tab", () => {
      // Tab A edits main.tex: original -> v1
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-a-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "original",
        newContent: "v1-from-tab-a",
        toolName: "Edit",
      });

      // Tab B later also edits main.tex: v1 -> v2
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-b-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "v1-from-tab-a",
        newContent: "v2-from-tab-b",
        toolName: "Edit",
      });

      const { changes } = useProposedChangesStore.getState();
      // Should be merged into a single entry
      expect(changes).toHaveLength(1);
      // Baseline must be "original" (the true pre-edit state)
      expect(changes[0].oldContent).toBe("original");
      expect(changes[0].newContent).toBe("v2-from-tab-b");
      expect(changes[0].id).toBe("tool-tab-b-1");
    });

    it("edits to different files from different tabs stay independent", () => {
      useProposedChangesStore.getState().addChange({
        id: "tool-tab-a",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "main-original",
        newContent: "main-edited",
        toolName: "Edit",
      });

      useProposedChangesStore.getState().addChange({
        id: "tool-tab-b",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "bib-original",
        newContent: "bib-edited",
        toolName: "Write",
      });

      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(2);

      const mainChange = changes.find((c) => c.filePath === "main.tex");
      const bibChange = changes.find((c) => c.filePath === "refs.bib");
      expect(mainChange!.oldContent).toBe("main-original");
      expect(bibChange!.oldContent).toBe("bib-original");
    });

    it("three sequential edits to the same file all preserve the original baseline", () => {
      const store = useProposedChangesStore.getState();

      store.addChange({
        id: "edit-1",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "baseline",
        newContent: "v1",
        toolName: "Edit",
      });
      store.addChange({
        id: "edit-2",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "v1",
        newContent: "v2",
        toolName: "Edit",
      });
      store.addChange({
        id: "edit-3",
        filePath: "doc.tex",
        absolutePath: "/project/doc.tex",
        oldContent: "v2",
        newContent: "v3",
        toolName: "MultiEdit",
      });

      const { changes } = useProposedChangesStore.getState();
      expect(changes).toHaveLength(1);
      expect(changes[0].oldContent).toBe("baseline");
      expect(changes[0].newContent).toBe("v3");
      expect(changes[0].id).toBe("edit-3");
      expect(changes[0].toolName).toBe("MultiEdit");
    });
  });

  describe("per-tab independent streaming", () => {
    it("tab A streaming does not block tab B from streaming", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Tab A starts streaming
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === "tab-default" ? { ...t, isStreaming: true } : t,
        ),
        isStreaming: s.activeTabId === "tab-default",
      }));

      // Tab B can also be streaming independently
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabB ? { ...t, isStreaming: true } : t,
        ),
        isStreaming: s.activeTabId === tabB,
      }));

      const state = useAgentChatStore.getState();
      const tabAState = state.tabs.find((t) => t.id === "tab-default")!;
      const tabBState = state.tabs.find((t) => t.id === tabB)!;
      expect(tabAState.isStreaming).toBe(true);
      expect(tabBState.isStreaming).toBe(true);
    });

    it("_appendMessage routes to the specified tab, not the active tab", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Mark tab A as streaming
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === "tab-default" ? { ...t, isStreaming: true } : t,
        ),
      }));

      // User is viewing tab B (active), but message is for tab A
      chat.setActiveTab(tabB);

      useAgentChatStore.getState()._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello from stream" }] },
      });

      const state = useAgentChatStore.getState();
      const tabAState = state.tabs.find((t) => t.id === "tab-default")!;
      const tabBState = state.tabs.find((t) => t.id === tabB)!;

      expect(tabAState.messages).toHaveLength(1);
      expect(tabAState.messages[0].message?.content?.[0].text).toBe(
        "Hello from stream",
      );
      expect(tabBState.messages).toHaveLength(0);

      // Top-level projected messages should reflect the active tab (tab B) — empty
      expect(state.messages).toHaveLength(0);
    });

    it("_setSessionId routes to the specified tab", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Viewing tab B, set session on tab A
      chat.setActiveTab(tabB);
      chat._setSessionId("tab-default", "session-123");

      const state = useAgentChatStore.getState();
      const tabA = state.tabs.find((t) => t.id === "tab-default")!;
      expect(tabA.sessionId).toBe("session-123");
      // Active tab (tab B) projected sessionId should not change
      expect(state.sessionId).toBeNull();
    });

    it("_setStreaming(tabId, false) only affects that specific tab", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Both tabs streaming
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((t) => ({ ...t, isStreaming: true })),
        isStreaming: true,
      }));

      // Tab A finishes
      chat._setStreaming("tab-default", false);

      const state = useAgentChatStore.getState();
      expect(state.tabs.find((t) => t.id === "tab-default")!.isStreaming).toBe(
        false,
      );
      expect(state.tabs.find((t) => t.id === tabB)!.isStreaming).toBe(true);
    });

    it("_setError routes to the specified tab, not active tab", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Viewing tab B, error on tab A
      chat.setActiveTab(tabB);
      chat._setError("tab-default", "Rate limited");

      const state = useAgentChatStore.getState();
      const tabA = state.tabs.find((t) => t.id === "tab-default")!;
      expect(tabA.error).toBe("Rate limited");
      // Active tab (tab B) projected error should be null
      expect(state.error).toBeNull();
    });

    it("concurrent messages to different tabs are independent", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      // Simulate concurrent streaming on both tabs
      chat._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab A message 1" }] },
      });
      chat._appendMessage(tabB, {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab B message 1" }] },
      });
      chat._appendMessage("tab-default", {
        type: "assistant",
        message: { content: [{ type: "text", text: "Tab A message 2" }] },
      });

      const state = useAgentChatStore.getState();
      const tabAMsgs = state.tabs.find((t) => t.id === "tab-default")!.messages;
      const tabBMsgs = state.tabs.find((t) => t.id === tabB)!.messages;

      expect(tabAMsgs).toHaveLength(2);
      expect(tabBMsgs).toHaveLength(1);
      expect(tabAMsgs[0].message?.content?.[0].text).toBe("Tab A message 1");
      expect(tabAMsgs[1].message?.content?.[0].text).toBe("Tab A message 2");
      expect(tabBMsgs[0].message?.content?.[0].text).toBe("Tab B message 1");
    });
  });

  describe("prompt acceptance", () => {
    it("does not consume a blocked draft prompt or add a red error", async () => {
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          agentWorkspace: {
            ...mockWorkspaceSession,
            status: "review" as const,
          },
        })),
      }));
      const accepted = vi.fn();
      const before = useAgentChatStore.getState().messages;
      await useAgentChatStore
        .getState()
        .sendPrompt("Preserve this", undefined, false, accepted);
      expect(accepted).not.toHaveBeenCalled();
      expect(useAgentChatStore.getState().messages).toBe(before);
      expect(useAgentChatStore.getState().error).toBeNull();
    });
  });

  describe("Codex app-server thread routing", () => {
    it("passes the resolved root and active compiler choice to Codex", async () => {
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        files: [
          {
            id: "main.tex",
            name: "main.tex",
            type: "tex",
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            content: "% !TEX program = lualatex\n\\documentclass{article}",
            isDirty: false,
          },
        ],
        activeFileId: "main.tex",
        selectionRange: null,
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles: vi.fn(() => Promise.resolve()),
      } as any);
      useSettingsStore.setState({
        compilerBackend: "latexmk",
        compilerEngine: "auto",
        compilerChoicesByRoot: {},
      });
      useAgentChatStore.setState((state) => ({
        selectedProvider: "codex",
        tabs: state.tabs.map((tab) => ({ ...tab, provider: "codex" })),
      }));

      const accepted = vi.fn();
      await useAgentChatStore
        .getState()
        .sendPrompt("Edit the draft", undefined, false, accepted);
      expect(accepted).toHaveBeenCalledTimes(1);

      expect(invoke).toHaveBeenCalledWith(
        "execute_codex_code",
        expect.objectContaining({
          sourceProjectPath: "/project",
          runtimeSessionKey:
            useAgentChatStore.getState().tabs[0].runtimeSessionKey,
          compileContext: {
            rootId: "main.tex",
            targetPath: "main.tex",
            backend: "latexmk",
            engine: "lualatex",
            autoEngine: undefined,
          },
        }),
      );
    });

    it.each([
      {
        custom: false,
        model: "claude-fable-5[1m]",
        levels: ["low", "medium", "high", "xhigh", "max"] as const,
        selectedEffort: "max" as const,
        sentEffort: "max",
      },
      {
        custom: false,
        model: "haiku",
        levels: [] as const,
        selectedEffort: "medium" as const,
        sentEffort: undefined,
      },
      {
        custom: true,
        model: "claude-opus-custom",
        levels: [] as const,
        selectedEffort: "max" as const,
        sentEffort: undefined,
      },
      {
        custom: true,
        model: "claude-sonnet-custom",
        levels: ["high"] as const,
        selectedEffort: "max" as const,
        sentEffort: "high",
      },
    ])("sends $model with its supported effort and verification context", async ({
      custom,
      model,
      levels,
      selectedEffort,
      sentEffort,
    }) => {
      useAgentChatStore.setState({
        selectedClaudeModel: model,
        effortLevel: selectedEffort,
      });
      useClaudeSetupStore.setState({
        models: [
          {
            value: model,
            displayName: model,
            description: "Model",
            supportedEffortLevels: [...levels],
          },
        ],
      });
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        files: [
          {
            id: "paper.tex",
            name: "paper.tex",
            type: "tex",
            relativePath: "paper.tex",
            absolutePath: "/project/paper.tex",
            content: "% !TEX program = xelatex\n\\documentclass{article}",
            isDirty: false,
          },
        ],
        activeFileId: "paper.tex",
        selectionRange: null,
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles: vi.fn(() => Promise.resolve()),
      } as any);
      useSettingsStore.setState({
        compilerBackend: "latexmk",
        compilerEngine: "auto",
        compilerChoicesByRoot: {},
      });

      if (custom) {
        useClaudeSetupStore.setState({ models: [] });
        useSettingsStore.setState({
          customModels: [
            { provider: "claude", id: model, effort: sentEffort ?? "default" },
          ],
        });
      }
      await useAgentChatStore
        .getState()
        .sendPrompt("Edit the draft with Claude");

      expect(invoke).toHaveBeenCalledWith(
        "execute_claude_code",
        expect.objectContaining({
          model,
          effortLevel: sentEffort,
          projectPath: "/workspace/candidate",
          sourceProjectPath: "/project",
          compileContext: {
            rootId: "paper.tex",
            targetPath: "paper.tex",
            backend: "latexmk",
            engine: "xelatex",
            autoEngine: undefined,
          },
        }),
      );
    });

    it("prepares an isolated workspace in default Codex mode", async () => {
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === "save_shared_session") {
          return { shared_session_id: "shared-session-default" } as any;
        }
        if (command === "prepare_agent_workspace") {
          const workspaceArgs = args as
            | {
                tabId?: string;
                sharedSessionId?: string;
                mode?: "ask" | "edit";
              }
            | undefined;
          return {
            ...mockWorkspaceSession,
            tabId: workspaceArgs?.tabId ?? "tab-default",
            sharedSessionId: workspaceArgs?.sharedSessionId,
            mode: workspaceArgs?.mode === "edit" ? "edit" : "ask",
          } as any;
        }
        return undefined;
      });
      const saveAllFiles = vi.fn(async () => {
        const document = useDocumentStore.getState();
        document.files = document.files.map((file) => ({
          ...file,
          isDirty: false,
        }));
      });
      const activateAgentWorkspace = vi.fn(() => Promise.resolve());
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        agentWorkspaceRoot: null,
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            content: "before",
            isDirty: true,
          },
        ],
        activeFileId: null,
        selectionRange: null,
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles,
        activateAgentWorkspace,
      } as any);
      useAgentChatStore.setState((s) => ({
        selectedProvider: "codex",
        selectedCodexExecutionMode: "default",
        tabs: s.tabs.map((tab) =>
          tab.id === "tab-default" ? { ...tab, provider: "codex" } : tab,
        ),
      }));

      await useAgentChatStore.getState().sendPrompt("Edit the draft");

      const tab = useAgentChatStore
        .getState()
        .tabs.find((t) => t.id === "tab-default")!;
      expect(tab.pendingFileBaseline).toBeNull();
      expect(tab.agentWorkspace).toEqual(
        expect.objectContaining({
          sessionId: "workspace-session",
          candidateRoot: "/workspace/candidate",
          mode: "ask",
        }),
      );
      expect(invoke).toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.objectContaining({
          mode: "ask",
          projectRoot: "/project",
          sharedSessionId: "shared-session-default",
          dirtyBuffers: [],
        }),
      );
      expect(saveAllFiles).toHaveBeenCalledExactlyOnceWith({
        requireClean: true,
      });
      expect(activateAgentWorkspace).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith(
        "execute_codex_code",
        expect.objectContaining({
          tabId: "tab-default",
          projectPath: "/workspace/candidate",
          prompt: expect.stringContaining("Edit the draft"),
        }),
      );
    });

    it.each([
      "codex",
      "claude",
    ] as const)("waits for saving before preparing or starting %s", async (provider) => {
      let finishSave!: () => void;
      const document = useDocumentStore.getState();
      const save = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      document.saveAllFiles = save;
      useAgentChatStore.setState((s) => ({
        selectedProvider: provider,
        tabs: s.tabs.map((tab) => ({ ...tab, provider })),
      }));
      const sending = useAgentChatStore.getState().sendPrompt("Comment this");
      await vi.waitFor(() =>
        expect(save).toHaveBeenCalledWith({ requireClean: true }),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.anything(),
      );
      finishSave();
      await sending;
      expect(invoke).toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.objectContaining({ dirtyBuffers: [] }),
      );
      expect(invoke).toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.anything(),
      );
    });

    it.each([
      "codex",
      "claude",
    ] as const)("does not create a draft or start %s after a failed save", async (provider) => {
      useDocumentStore.getState().saveAllFiles = vi
        .fn()
        .mockRejectedValue(new Error("main.tex: Disk full"));
      useAgentChatStore.setState((s) => ({
        selectedProvider: provider,
        tabs: s.tabs.map((tab) => ({ ...tab, provider })),
      }));
      await useAgentChatStore.getState().sendPrompt("Comment this");
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.anything(),
      );
      expect(useAgentChatStore.getState().error).toContain("Disk full");
      expect(useAgentChatStore.getState().isStreaming).toBe(false);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("pauses %s during preparation and retries the original request once", async (provider) => {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      let finishSave!: () => void;
      useDocumentStore.getState().saveAllFiles = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      const sending = useAgentChatStore
        .getState()
        .sendPrompt("Review the selected paragraph", {
          label: "@main.tex:1:1-1:5",
          filePath: "main.tex",
          selectedText: "Hello",
        });
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      await useAgentChatStore.getState().pauseExecution();
      await useAgentChatStore.getState().pauseExecution();
      finishSave();
      await sending;
      const paused = useAgentChatStore.getState().tabs[0];
      expect(paused).toMatchObject({
        pauseState: "paused",
        isStreaming: false,
        agentWorkspace: { status: "active" },
      });
      expect(invoke).not.toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        `cancel_${provider}_execution`,
        expect.anything(),
      );
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        ...useDocumentStore.getState(),
        pdfSelectionContext: {
          label: "PDF p.1",
          filePath: "main.pdf",
          selectedText: "NEW_SELECTION_AFTER_PAUSE",
        },
      } as any);
      await useAgentChatStore.getState().continueExecution();
      expect(
        useAgentChatStore
          .getState()
          .tabs[0].messages.filter((message) => message.type === "user"),
      ).toHaveLength(1);
      expect(useAgentChatStore.getState().tabs[0].messages[1]).toMatchObject({
        subtype: "round_stopped",
        roundDurationMs: expect.any(Number),
      });
      expect(invoke).toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.objectContaining({
          prompt: expect.stringContaining("Review the selected paragraph"),
          projectPath: paused.agentWorkspace?.candidateRoot,
        }),
      );
      const executionArgs = vi
        .mocked(invoke)
        .mock.calls.find(
          ([command]) => command === `execute_${provider}_code`,
        )?.[1] as { prompt: string };
      expect(executionArgs.prompt).toContain("Hello");
      expect(executionArgs.prompt).not.toContain("NEW_SELECTION_AFTER_PAUSE");
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([cmd]) => cmd === "prepare_agent_workspace"),
      ).toHaveLength(1);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("delivers a pause queued while %s is starting to the original tab", async (provider) => {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      const originalInvoke = vi.mocked(invoke).getMockImplementation()!;
      let started!: () => void;
      vi.mocked(invoke).mockImplementation((command, args) =>
        command === `execute_${provider}_code`
          ? new Promise<void>((resolve) => {
              started = resolve;
            })
          : originalInvoke(command, args),
      );
      const sending = useAgentChatStore.getState().sendPrompt("Review this");
      await vi.waitFor(() => expect(started).toBeDefined());
      await useAgentChatStore.getState().pauseExecution();
      expect(invoke).not.toHaveBeenCalledWith(
        `cancel_${provider}_execution`,
        expect.anything(),
      );
      const originalTabId = useAgentChatStore.getState().activeTabId;
      useAgentChatStore.getState().createTab();
      started();
      await sending;
      expect(invoke).toHaveBeenCalledWith(`cancel_${provider}_execution`, {
        tabId: originalTabId,
      });
      expect(
        useAgentChatStore
          .getState()
          .tabs.find((tab) => tab.id === originalTabId),
      ).toMatchObject({ pauseState: "pausing", isStreaming: true });
      expect(useAgentChatStore.getState().isStreaming).toBe(false);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("continues the paused %s session without replacing the draft or typed input", async (provider) => {
      const pinnedContext = {
        label: "@new.tex",
        filePath: "new.tex",
        selectedText: "NEW_PINNED_CONTEXT",
      };
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        ...useDocumentStore.getState(),
        pdfSelectionContext: {
          label: "PDF p.1",
          filePath: "main.pdf",
          selectedText: "NEW_LIVE_SELECTION",
        },
      } as any);
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider,
          sessionId: "native-session",
          providerSessionIds: { [provider]: "native-session" },
          agentWorkspace: mockWorkspaceSession,
          pauseState: "paused",
          draft: {
            input: "Keep my draft text",
            pinnedContexts: [pinnedContext],
          },
        })),
      }));
      await useAgentChatStore.getState().continueExecution();
      await useAgentChatStore.getState().continueExecution();
      expect(invoke).toHaveBeenCalledWith(
        `resume_${provider}_code`,
        expect.objectContaining({
          sessionId: "native-session",
          projectPath: mockWorkspaceSession.candidateRoot,
          prompt: expect.stringContaining("Continue"),
        }),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      const tab = useAgentChatStore.getState().tabs[0];
      expect(tab.messages).toHaveLength(1);
      expect(tab.draft.input).toBe("Keep my draft text");
      expect(tab.draft.pinnedContexts).toEqual([pinnedContext]);
      const resumeArgs = vi
        .mocked(invoke)
        .mock.calls.find(
          ([command]) => command === `resume_${provider}_code`,
        )?.[1] as { prompt: string };
      expect(resumeArgs.prompt).not.toContain("NEW_LIVE_SELECTION");
      expect(resumeArgs.prompt).not.toContain("NEW_PINNED_CONTEXT");
      expect(tab.pauseState).toBeNull();
    });

    it("allows retrying an interrupt that failed instead of leaving Pausing stuck", async () => {
      useAgentChatStore.setState((state) => ({
        isStreaming: true,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          isStreaming: true,
          turnPhase: "running",
        })),
      }));
      vi.mocked(invoke).mockRejectedValue(new Error("IPC unavailable"));
      await useAgentChatStore.getState().pauseExecution();
      expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
        isStreaming: true,
        pauseState: null,
        cancelledByUser: false,
        error: expect.stringContaining("Could not pause"),
      });
    });

    it.each([
      "claude",
      "codex",
    ] as const)("stops %s during saving without launching or becoming paused", async (provider) => {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      let finishSave!: () => void;
      useDocumentStore.getState().saveAllFiles = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      const sending = useAgentChatStore.getState().sendPrompt("Comment this");
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      await useAgentChatStore.getState().cancelExecution();
      finishSave();
      await sending;
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        `cancel_${provider}_execution`,
        expect.anything(),
      );
      expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
        isStreaming: false,
        isSettling: false,
        pauseState: null,
        pausedRequest: null,
        error: null,
      });
    });

    it("does not launch when the project changes during saving", async () => {
      let finishSave!: () => void;
      const document = useDocumentStore.getState();
      document.saveAllFiles = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      );
      const sending = useAgentChatStore.getState().sendPrompt("Comment this");
      await vi.waitFor(() => expect(finishSave).toBeDefined());
      document.projectRoot = "/other";
      finishSave();
      await sending;
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "execute_claude_code",
        expect.anything(),
      );
      expect(useAgentChatStore.getState().isStreaming).toBe(false);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("delivers Stop during %s startup to the original tab, even when the project closes", async (provider) => {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      const original = vi.mocked(invoke).getMockImplementation()!;
      let started!: () => void;
      vi.mocked(invoke).mockImplementation((cmd, args) =>
        cmd === `execute_${provider}_code`
          ? new Promise<void>((resolve) => {
              started = resolve;
            })
          : original(cmd, args),
      );
      const sending = useAgentChatStore.getState().sendPrompt("Review this");
      await vi.waitFor(() => expect(started).toBeDefined());
      const tabId = useAgentChatStore.getState().activeTabId;
      await useAgentChatStore.getState().cancelExecution();
      await useAgentChatStore.getState().cancelExecution();
      await useAgentChatStore.getState().pauseExecution(tabId);
      useAgentChatStore.getState().createTab();
      expect(invoke).not.toHaveBeenCalledWith(
        `cancel_${provider}_execution`,
        expect.anything(),
      );
      started();
      await sending;
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([cmd]) => cmd === `cancel_${provider}_execution`),
      ).toEqual([[`cancel_${provider}_execution`, { tabId }]]);
      expect(
        useAgentChatStore.getState().tabs.find((tab) => tab.id === tabId),
      ).toMatchObject({
        isStreaming: true,
        cancelledByUser: true,
        pauseState: null,
      });
      useAgentChatStore.getState()._setStreaming(tabId, false);
      expect(
        useAgentChatStore.getState().tabs.find((tab) => tab.id === tabId)
          ?.pauseState,
      ).toBeNull();
      expect(useAgentChatStore.getState().isStreaming).toBe(false);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("retains %s edits when stopped during workspace preparation", async (provider) => {
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({ ...tab, provider })),
      }));
      const original = vi.mocked(invoke).getMockImplementation()!;
      let prepared!: (workspace: AgentWorkspaceSession) => void;
      const stoppedWorkspace = {
        ...mockWorkspaceSession,
        status: "cancelled" as const,
      };
      vi.mocked(invoke).mockImplementation((cmd, args) => {
        if (cmd === "prepare_agent_workspace")
          return new Promise((resolve) => {
            prepared = resolve;
          });
        if (cmd === "reconcile_agent_workspace")
          return Promise.resolve({
            session: stoppedWorkspace,
            changes: [{ id: "retained" }],
          });
        return original(cmd, args);
      });
      const enqueue = vi
        .spyOn(useAgentReviewQueueStore.getState(), "enqueue")
        .mockResolvedValue();
      try {
        const sending = useAgentChatStore.getState().sendPrompt("Review this");
        await vi.waitFor(() => expect(prepared).toBeDefined());
        await useAgentChatStore.getState().cancelExecution();
        prepared(mockWorkspaceSession);
        await sending;
        expect(enqueue).toHaveBeenCalledExactlyOnceWith(stoppedWorkspace);
        expect(invoke).not.toHaveBeenCalledWith(
          `execute_${provider}_code`,
          expect.anything(),
        );
        expect(invoke).not.toHaveBeenCalledWith(
          "discard_agent_workspace",
          expect.anything(),
        );
        expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
          isStreaming: false,
          isSettling: false,
          pauseState: null,
          agentWorkspace: stoppedWorkspace,
          error: null,
        });
      } finally {
        enqueue.mockRestore();
      }
    });

    it("allows retrying Stop after a failed provider interrupt", async () => {
      useAgentChatStore.setState((state) => ({
        isStreaming: true,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          isStreaming: true,
          turnPhase: "running",
        })),
      }));
      vi.mocked(invoke).mockRejectedValueOnce(new Error("IPC unavailable"));
      await useAgentChatStore.getState().cancelExecution();
      expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
        isStreaming: true,
        pauseState: null,
        cancelledByUser: false,
        error: expect.stringContaining("Could not stop"),
      });
      await useAgentChatStore.getState().cancelExecution();
      expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
        cancelledByUser: true,
        error: null,
      });
    });

    it.each([
      true,
      false,
    ])("rechecks actual source content after draft preparation (changed=%s)", async (changed) => {
      const document = useDocumentStore.getState();
      document.files = [
        {
          id: "main.tex",
          absolutePath: "/project/main.tex",
          relativePath: "main.tex",
          content: "Saved text",
          isDirty: false,
        },
      ] as any;
      const files = document.files;
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "prepare_agent_workspace") {
          // A watcher refresh alone must not invalidate the saved source.
          vi.mocked(useDocumentStore.getState).mockReturnValue({
            ...document,
            contentGeneration: 100,
            files: files.map((file) => ({
              ...file,
              content: changed ? "New edit" : file.content,
              isDirty: changed,
            })),
          });
          return mockWorkspaceSession as any;
        }
        return undefined;
      });
      await useAgentChatStore.getState().sendPrompt("Comment this");
      if (changed) {
        expect(invoke).toHaveBeenCalledWith(
          "discard_agent_workspace",
          expect.objectContaining({ sessionId: "workspace-session" }),
        );
        expect(invoke).not.toHaveBeenCalledWith(
          "execute_claude_code",
          expect.anything(),
        );
        expect(useAgentChatStore.getState().error).toContain("source changed");
      } else
        expect(invoke).toHaveBeenCalledWith(
          "execute_claude_code",
          expect.anything(),
        );
    });

    it("keeps an active isolated draft when continuing without saving draft edits into source", async () => {
      const document = useDocumentStore.getState();
      document.saveAllFiles = vi
        .fn()
        .mockRejectedValue(new Error("Must not save draft"));
      useAgentChatStore.setState((s) => ({
        tabs: s.tabs.map((tab) => ({
          ...tab,
          agentWorkspace: mockWorkspaceSession,
        })),
      }));
      await useAgentChatStore.getState().sendPrompt("Continue this draft");
      expect(document.saveAllFiles).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).toHaveBeenCalledWith(
        "execute_claude_code",
        expect.objectContaining({ projectPath: "/workspace/candidate" }),
      );
    });

    it("runs Codex edit mode without a proposed-change baseline", async () => {
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        files: [
          {
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            content: "before",
            isDirty: false,
          },
        ],
        activeFileId: null,
        selectionRange: null,
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles: vi.fn(() => Promise.resolve()),
      } as any);
      useAgentChatStore.setState((s) => ({
        selectedProvider: "codex",
        selectedCodexExecutionMode: "edit",
        tabs: s.tabs.map((tab) =>
          tab.id === "tab-default" ? { ...tab, provider: "codex" } : tab,
        ),
      }));

      await useAgentChatStore.getState().sendPrompt("Edit the draft");

      const tab = useAgentChatStore
        .getState()
        .tabs.find((t) => t.id === "tab-default")!;
      expect(tab.pendingFileBaseline).toBeNull();
      expect(invoke).toHaveBeenCalledWith(
        "execute_codex_code",
        expect.objectContaining({
          tabId: "tab-default",
          prompt: expect.stringContaining("Edit the draft"),
        }),
      );
    });

    it("starts another isolated draft while the first agent remains running", async () => {
      const chat = useAgentChatStore.getState();
      const secondTabId = chat.createTab();
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-default"
            ? {
                ...tab,
                isStreaming: true,
                agentWorkspace: mockWorkspaceSession,
              }
            : tab,
        ),
      }));

      await useAgentChatStore.getState().sendPrompt("Start another edit");

      const secondTab = useAgentChatStore
        .getState()
        .tabs.find((tab) => tab.id === secondTabId);
      expect(secondTab?.error).toBeNull();
      expect(
        useAgentChatStore
          .getState()
          .tabs.find((tab) => tab.id === "tab-default"),
      ).toMatchObject({
        isStreaming: true,
        agentWorkspace: mockWorkspaceSession,
      });
      expect(invoke).toHaveBeenCalledWith(
        "prepare_agent_workspace",
        expect.anything(),
      );
      expect(invoke).toHaveBeenCalledWith(
        "execute_claude_code",
        expect.anything(),
      );
    });

    it("detaches every project draft and cancels active providers when the project closes", () => {
      const secondTabId = useAgentChatStore.getState().createTab();
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider: tab.id === secondTabId ? "codex" : "claude",
          isStreaming: tab.id === secondTabId,
          agentWorkspace: {
            ...mockWorkspaceSession,
            sessionId: `workspace-${tab.id}`,
            tabId: tab.id,
          },
        })),
        isStreaming: true,
      }));

      useAgentChatStore.getState()._detachProjectAgentWorkspaces("/project");

      expect(
        useAgentChatStore.getState().tabs.every((tab) => !tab.agentWorkspace),
      ).toBe(true);
      expect(invoke).toHaveBeenCalledWith("cancel_codex_execution", {
        tabId: secondTabId,
      });
    });

    it("recovers the explicitly associated chat into the review queue", async () => {
      const { useAgentReviewQueueStore } = await import(
        "@/stores/agent-review-queue-store"
      );
      useAgentReviewQueueStore.setState({ entries: [] });
      const originalTabId = useAgentChatStore.getState().activeTabId;
      const activateAgentWorkspace = vi.fn(() => Promise.resolve());
      const restoreRecoveredDirtyBuffers = vi.fn(() => Promise.resolve());
      const addAgentWorkspaceReviewFiles = vi.fn(() => Promise.resolve());
      const setAgentWorkspaceReadOnly = vi.fn();
      const setActiveFile = vi.fn();
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        saveAllFiles: vi.fn(() => Promise.resolve()),
        files: [{ relativePath: "main.tex" }],
        activeFileId: "main.tex",
        selectionRange: null,
        activateAgentWorkspace,
        restoreRecoveredDirtyBuffers,
        addAgentWorkspaceReviewFiles,
        setAgentWorkspaceReadOnly,
        setActiveFile,
      } as any);
      const recoveredWorkspace = {
        ...mockWorkspaceSession,
        tabId: "tab-from-previous-app",
        sharedSessionId: "shared-recovered",
        status: "review" as const,
      };
      const recoveredChange = {
        id: "recovered-change",
        kind: "modified" as const,
        filePath: "main.tex",
        oldFilePath: "main.tex",
        newFilePath: "main.tex",
        sourceAbsolutePath: "/project/main.tex",
        candidateAbsolutePath: "/workspace/candidate/main.tex",
        oldContent: "before",
        newContent: "after",
        binary: false,
        sourceChanged: false,
      };
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === "list_agent_workspaces") return [recoveredWorkspace];
        if (command === "reconcile_agent_workspace")
          return {
            session: { ...recoveredWorkspace, status: "failed" },
            changes: [recoveredChange],
          };
        if (command === "preview_agent_workspace") {
          return {
            session: recoveredWorkspace,
            changes: [recoveredChange],
            conflicts: [],
            sourceRevision: "revision",
            mergedContents: { "recovered-change": "after" },
            currentContents: { "recovered-change": "before" },
          } as any;
        }
        if (command === "list_shared_sessions") {
          return [
            {
              shared_session_id: "shared-recovered",
              last_modified: 2,
              archived: false,
            },
          ] as any;
        }
        if (command === "load_shared_session") {
          expect(args).toEqual(
            expect.objectContaining({
              projectPath: "/project",
              sharedSessionId: "shared-recovered",
            }),
          );
          return {
            shared_session_id: "shared-recovered",
            title: "Polish this paragraph",
            last_modified: 2,
            last_provider: "codex",
            last_claude_model: null,
            last_codex_model: "gpt-5.4",
            provider_session_ids: { codex: "thread-recovered" },
            provider_sync_cursors: { codex: 1 },
            messages: [
              {
                type: "user",
                message: {
                  content: [{ type: "text", text: "Polish this paragraph" }],
                },
              },
            ],
          } as any;
        }
        return undefined;
      });

      const recovered = await recoverLatestAgentWorkspace("/project");

      expect(recovered).toBe(true);
      const state = useAgentChatStore.getState();
      expect(state.activeTabId).toBe(originalTabId);
      const activeTab = state.tabs.find(
        (tab) => tab.sharedSessionId === "shared-recovered",
      )!;
      expect(activeTab.title).toBe("Polish this paragraph");
      expect(activeTab.messages).toEqual([
        expect.objectContaining({ type: "user" }),
      ]);
      expect(activeTab.error).toBeNull();
      expect(activeTab.agentWorkspace).toEqual(
        expect.objectContaining({
          sessionId: "workspace-session",
          sharedSessionId: "shared-recovered",
        }),
      );
      expect(state.drawerOpenRequested).toBe(true);
      expect(restoreRecoveredDirtyBuffers).not.toHaveBeenCalled();
      expect(useAgentReviewQueueStore.getState().entries).toEqual([
        expect.objectContaining({
          phase: "review",
          session: expect.objectContaining({
            sessionId: "workspace-session",
            tabId: activeTab.id,
          }),
        }),
      ]);
    });

    it("keeps the source view active while Claude is paused for a question", async () => {
      const setAgentWorkspaceReadOnly = vi.fn();
      const activateAgentWorkspace = vi.fn(() => Promise.resolve());
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        agentWorkspaceSessionId: null,
        agentWorkspaceRoot: null,
        files: [],
        activeFileId: null,
        selectionRange: null,
        activateAgentWorkspace,
        addAgentWorkspaceReviewFiles: vi.fn(() => Promise.resolve()),
        setAgentWorkspaceReadOnly,
      } as any);
      useAgentChatStore.getState().createTab();
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((tab) =>
          tab.id === "tab-default"
            ? {
                ...tab,
                isStreaming: false,
                agentWorkspace: mockWorkspaceSession,
              }
            : tab,
        ),
      }));

      useAgentChatStore.getState().setActiveTab("tab-default");

      await Promise.resolve();
      expect(activateAgentWorkspace).not.toHaveBeenCalled();
      expect(setAgentWorkspaceReadOnly).not.toHaveBeenCalled();
    });

    it("resumes Codex with the saved provider thread id", async () => {
      useAgentChatStore.setState((s) => ({
        selectedProvider: "codex",
        sessionId: "thread-from-tab",
        tabs: s.tabs.map((tab) =>
          tab.id === "tab-default"
            ? {
                ...tab,
                provider: "codex",
                sessionId: "thread-from-tab",
                providerSessionIds: {
                  codex: "thread-from-provider-map",
                },
              }
            : tab,
        ),
      }));

      await useAgentChatStore.getState().sendPrompt("Continue the draft");

      expect(invoke).toHaveBeenCalledWith(
        "resume_codex_code",
        expect.objectContaining({
          sourceProjectPath: "/project",
          runtimeSessionKey:
            useAgentChatStore.getState().tabs[0].runtimeSessionKey,
          sessionId: "thread-from-provider-map",
          tabId: "tab-default",
          prompt: expect.stringContaining("Continue the draft"),
        }),
      );
      expect(invoke).not.toHaveBeenCalledWith(
        "execute_codex_code",
        expect.anything(),
      );
    });

    it.each([
      "claude",
      "codex",
      "pi",
    ] as const)("includes the Global prompt only when a new %s session starts", async (provider) => {
      useAgentChatStore.getState().setProvider(provider);
      useSettingsStore.setState({
        globalAgentPrompt: "Keep theorem labels stable.",
        ...{ useGlobalAgentPrompt: false },
      });
      await useAgentChatStore.getState().sendPrompt("First ask");
      expect(invoke).toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.objectContaining({
          prompt:
            "[Agent instructions]\n\n[Global]\nKeep theorem labels stable.\n\n[User/context prompt]\n\nFirst ask",
        }),
      );
      expect(readTexFileContent).not.toHaveBeenCalled();

      useAgentChatStore
        .getState()
        ._setSessionId("tab-default", "native-session");
      useAgentChatStore.getState()._setStreaming("tab-default", false);
      useAgentChatStore.getState()._markProviderSynced("tab-default", provider);
      useSettingsStore.setState({ globalAgentPrompt: "Changed instructions." });
      vi.mocked(invoke).mockClear();
      await useAgentChatStore.getState().sendPrompt("Follow-up");
      expect(invoke).toHaveBeenCalledWith(
        `resume_${provider}_code`,
        expect.objectContaining({
          sessionId: "native-session",
          prompt: "Follow-up",
        }),
      );

      useAgentChatStore.getState()._setStreaming("tab-default", false);
      useAgentChatStore.getState()._markProviderSynced("tab-default", provider);
      vi.mocked(invoke).mockClear();
      await useAgentChatStore.getState().sendPrompt("Another follow-up");
      expect(invoke).toHaveBeenCalledWith(
        `resume_${provider}_code`,
        expect.objectContaining({
          sessionId: "native-session",
          prompt: "Another follow-up",
        }),
      );

      useAgentChatStore.getState()._setStreaming("tab-default", false);
      useAgentChatStore.getState().createTab();
      vi.mocked(invoke).mockClear();
      await useAgentChatStore
        .getState()
        .sendPrompt("New chat with updated Global");
      expect(invoke).toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.objectContaining({
          prompt: expect.stringContaining("[Global]\nChanged instructions."),
        }),
      );
    });

    it.each([
      "claude",
      "codex",
      "pi",
    ] as const)("leaves AGENTS.md and CLAUDE.md to %s even with legacy toggles enabled", async (provider) => {
      useAgentChatStore.getState().setProvider(provider);
      // Old settings must not restore the removed message injections.
      useSettingsStore.setState({
        globalAgentPrompt: "   ",
        ...{ useProjectAgentPrompt: true, useClaudeAgentPrompt: true },
      });
      vi.mocked(readTexFileContent).mockResolvedValue(
        "Legacy file instructions.",
      );
      await useAgentChatStore.getState().sendPrompt("Plain ask");
      expect(invoke).toHaveBeenCalledWith(
        `execute_${provider}_code`,
        expect.objectContaining({ prompt: "Plain ask" }),
      );
      expect(readTexFileContent).not.toHaveBeenCalled();
    });

    it("keeps Pi skill invocation ahead of initial Global instructions", async () => {
      useAgentChatStore.getState().setProvider("pi");
      useSettingsStore.setState({ globalAgentPrompt: "Review carefully." });
      await useAgentChatStore
        .getState()
        .sendPrompt("/skill:review-document Review this");
      expect(invoke).toHaveBeenCalledWith(
        "execute_pi_code",
        expect.objectContaining({
          prompt: expect.stringMatching(
            /^\/skill:review-document \[Agent instructions\]/,
          ),
        }),
      );
    });

    it.each([
      ["opusplan", "opus"],
      ["claude-fable-5[1m]", "claude-fable-5[1m]"],
      ["claude-sonnet-4-6", "claude-sonnet-4-6"],
    ])("resumes Claude model %s as %s", async (saved, expected) => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "load_shared_session") {
          return {
            shared_session_id: "shared-claude",
            title: "Saved Claude Session",
            last_modified: 1,
            last_provider: "claude",
            last_claude_model: saved,
            last_codex_model: null,
            provider_session_ids: {
              claude: "claude-session",
            },
            messages: [],
          };
        }
        return undefined;
      });

      await useAgentChatStore.getState().resumeSession("shared-claude", {
        useSessionLlm: true,
      });

      expect(useAgentChatStore.getState().selectedClaudeModel).toBe(expected);
    });

    it("hydrates a resumed shared session with its Codex thread id", async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "load_shared_session") {
          return {
            shared_session_id: "shared-1",
            title: "Saved Codex Session",
            last_modified: 1,
            last_provider: "codex",
            last_claude_model: null,
            last_codex_model: "gpt-5.4",
            provider_session_ids: {
              codex: "thread-from-history",
            },
            messages: [
              {
                type: "assistant",
                message: {
                  content: [{ type: "text", text: "Previous answer" }],
                },
              },
            ],
          };
        }
        return undefined;
      });
      useAgentChatStore.setState({ selectedProvider: "codex" });

      await useAgentChatStore.getState().resumeSession("shared-1", {
        useSessionLlm: true,
      });

      const state = useAgentChatStore.getState();
      const tab = state.tabs.find((item) => item.id === "tab-default")!;
      expect(tab.sessionId).toBe("thread-from-history");
      expect(tab.providerSessionIds.codex).toBe("thread-from-history");
      expect(tab.providerSyncCursors).toEqual({ codex: 1 });
      expect(state.sessionId).toBe("thread-from-history");
    });
  });

  describe("cross-provider history handoff", () => {
    it.each([
      false,
      true,
    ])("preserves full unseen history with an existing Codex session: %s", async (existingCodexSession) => {
      const claudeAnswer = `Initial Claude answer ${"αβγ\n".repeat(5000)} End Claude answer`;
      const codexAnswer = `Codex continuation ${"你好\n".repeat(5000)} End Codex answer`;
      const initialMessages = [
        {
          type: "user" as const,
          provider: "claude" as const,
          message: {
            content: [{ type: "text" as const, text: "Initial ask" }],
          },
        },
        {
          type: "assistant" as const,
          provider: "claude" as const,
          message: {
            content: [{ type: "text" as const, text: claudeAnswer }],
          },
        },
      ];
      useAgentChatStore.setState((state) => ({
        selectedProvider: "claude",
        sessionId: "claude-session",
        messages: initialMessages,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider: "claude",
          sessionId: "claude-session",
          sharedSessionId: "shared-session",
          providerSessionIds: {
            claude: "claude-session",
            codex: existingCodexSession ? "codex-thread" : undefined,
          },
          providerSyncCursors: { claude: 2, codex: 0 },
          messages: initialMessages,
        })),
      }));

      useAgentChatStore.getState().setProvider("codex");
      let tab = useAgentChatStore.getState().tabs[0];
      expect(tab.messages).toEqual(initialMessages);
      expect(tab.sessionId).toBe(existingCodexSession ? "codex-thread" : null);

      useAgentChatStore
        .getState()
        .setSelectedCodexFastMode(existingCodexSession);
      await useAgentChatStore.getState().sendPrompt("Continue with Codex");
      const codexCall = vi
        .mocked(invoke)
        .mock.calls.find(
          ([command]) =>
            command ===
            (existingCodexSession ? "resume_codex_code" : "execute_codex_code"),
        );
      expect(codexCall?.[1]).toEqual(
        expect.objectContaining({
          ...(existingCodexSession ? { sessionId: "codex-thread" } : {}),
          fastMode: existingCodexSession,
          prompt: expect.stringContaining(
            `User: Initial ask\n\nClaude: ${claudeAnswer}`,
          ),
        }),
      );

      useAgentChatStore.getState()._setSessionId("tab-default", "codex-thread");
      useAgentChatStore.getState()._appendMessage("tab-default", {
        type: "assistant",
        provider: "codex",
        message: {
          content: [{ type: "text", text: codexAnswer }],
        },
      });
      useAgentChatStore.getState()._setStreaming("tab-default", false);
      useAgentChatStore.getState()._markProviderSynced("tab-default", "codex");

      useAgentChatStore.getState().setProvider("claude");
      tab = useAgentChatStore.getState().tabs[0];
      expect(tab.sessionId).toBe("claude-session");
      expect(tab.providerSyncCursors.codex).toBe(4);

      await useAgentChatStore.getState().sendPrompt("Return to Claude");
      const claudeCall = vi
        .mocked(invoke)
        .mock.calls.find(([command]) => command === "resume_claude_code");
      const claudePrompt =
        (claudeCall?.[1] as { prompt?: string })?.prompt ?? "";
      expect(claudePrompt).toContain("User: Continue with Codex");
      expect(claudePrompt).toContain(`Codex: ${codexAnswer}`);
      expect(claudePrompt).not.toContain("Claude: Initial Claude answer");
      expect(claudeCall?.[1]).toEqual(
        expect.objectContaining({
          sessionId: "claude-session",
          runtimeSessionKey:
            useAgentChatStore.getState().tabs[0].runtimeSessionKey,
        }),
      );
      expect(claudeCall?.[1]).not.toHaveProperty("permissionMode");
      useAgentChatStore.getState()._appendMessage("tab-default", {
        type: "assistant",
        provider: "claude",
        message: { content: [{ type: "text", text: "Claude resumed answer" }] },
      });
      useAgentChatStore.getState()._setStreaming("tab-default", false);
      useAgentChatStore.getState()._markProviderSynced("tab-default", "claude");
      useAgentChatStore.getState().setProvider("codex");
      vi.mocked(invoke).mockClear();
      await useAgentChatStore.getState().sendPrompt("Back to Codex");
      const resumed = vi
        .mocked(invoke)
        .mock.calls.find(([command]) => command === "resume_codex_code");
      expect(resumed?.[1]).toEqual(
        expect.objectContaining({ sessionId: "codex-thread" }),
      );
      const resumedPrompt = (resumed?.[1] as { prompt: string }).prompt;
      expect(resumedPrompt).toContain("User: Return to Claude");
      expect(resumedPrompt).toContain("Claude: Claude resumed answer");
      expect(resumedPrompt).not.toContain(claudeAnswer);
      expect(resumedPrompt).not.toContain(codexAnswer);
    });

    it.each([
      "claude",
      "codex",
    ] as const)("keeps unseen history when %s rejects a large handoff", async (provider) => {
      const history = `Preserve the beginning ${"x".repeat(20_000)} and the end`;
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider,
          sessionId: "existing-session",
          providerSessionIds: { [provider]: "existing-session" },
          providerSyncCursors: { [provider]: 0 },
          messages: [
            {
              type: "assistant" as const,
              message: { content: [{ type: "text" as const, text: history }] },
            },
          ],
        })),
      }));
      const original = vi.mocked(invoke).getMockImplementation()!;
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === `resume_${provider}_code`)
          throw new Error("Provider context limit exceeded");
        return original(command, args);
      });
      await useAgentChatStore.getState().sendPrompt("Continue");
      const tab = useAgentChatStore.getState().tabs[0];
      expect(tab.error).toContain("Provider context limit exceeded");
      expect(tab.providerSyncCursors[provider]).toBe(0);
      expect(tab.providerSessionIds[provider]).toBe("existing-session");
      expect(tab.messages[0].message?.content?.[0].text).toBe(history);
      const calls = vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command]) => command === `resume_${provider}_code`,
        );
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual(
        expect.objectContaining({ prompt: expect.stringContaining(history) }),
      );
    });

    it("rotates the Claude runtime generation for a new app session", () => {
      const previousKey =
        useAgentChatStore.getState().tabs[0].runtimeSessionKey;

      useAgentChatStore.getState().newSession();

      const nextTab = useAgentChatStore.getState().tabs[0];
      expect(nextTab.runtimeSessionKey).not.toBe(previousKey);
      expect(nextTab.providerSessionIds).toEqual({});
      expect(nextTab.providerSyncCursors).toEqual({});
    });

    it("restores saved provider cursors without treating them as legacy", async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === "load_shared_session") {
          return {
            shared_session_id: "shared-cursors",
            title: "Alternating providers",
            last_modified: 1,
            last_provider: "codex",
            last_claude_model: "opus",
            last_codex_model: "gpt-5.4",
            provider_session_ids: {
              claude: "claude-session",
              codex: "codex-thread",
            },
            provider_sync_cursors: { claude: 1, codex: 2 },
            messages: [
              {
                type: "user",
                message: { content: [{ type: "text", text: "Question" }] },
              },
              {
                type: "assistant",
                provider: "codex",
                message: { content: [{ type: "text", text: "Answer" }] },
              },
            ],
          };
        }
        return undefined;
      });

      await useAgentChatStore.getState().resumeSession("shared-cursors", {
        useSessionLlm: true,
      });

      expect(useAgentChatStore.getState().tabs[0].providerSyncCursors).toEqual({
        claude: 1,
        codex: 2,
        pi: 0,
      });
    });
  });

  describe("tab switching preserves merge state across views", () => {
    it("switching tabs does not lose proposed changes", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      useProposedChangesStore.getState().addChange({
        id: "edit-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "before",
        newContent: "after",
        toolName: "Edit",
      });

      // Rapidly switch tabs
      chat.setActiveTab("tab-default");
      chat.setActiveTab(tabB);
      chat.setActiveTab("tab-default");
      chat.setActiveTab(tabB);

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
      expect(useProposedChangesStore.getState().changes[0].newContent).toBe(
        "after",
      );
    });

    it("keepAll saves all changes regardless of which tab is active", async () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();
      const saveFile = vi.fn(async () => {});
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        ...useDocumentStore.getState(),
        files: [
          {
            id: "main.tex",
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            content: "new-main",
          },
          {
            id: "refs.bib",
            relativePath: "refs.bib",
            absolutePath: "/project/refs.bib",
            content: "new-bib",
          },
        ],
        saveFile,
      } as any);

      useProposedChangesStore.getState().addChange({
        id: "edit-1",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old-main",
        newContent: "new-main",
        toolName: "Edit",
      });
      useProposedChangesStore.getState().addChange({
        id: "edit-2",
        filePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        oldContent: "old-bib",
        newContent: "new-bib",
        toolName: "Write",
      });

      chat.setActiveTab(tabB);
      await useProposedChangesStore.getState().keepAll();

      expect(useProposedChangesStore.getState().changes).toHaveLength(0);
      expect(saveFile.mock.calls).toEqual([["main.tex"], ["refs.bib"]]);
    });
  });

  describe("tab lifecycle does not affect proposed changes", () => {
    it("seeds a new tab draft with the active editor selection", () => {
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        files: [
          {
            id: "main.tex",
            name: "main.tex",
            relativePath: "main.tex",
            absolutePath: "/project/main.tex",
            type: "tex",
            content: "First line\nSelected words\nFinal line",
            isDirty: false,
          },
        ],
        activeFileId: "main.tex",
        selectionRange: { start: 11, end: 25 },
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles: vi.fn(() => Promise.resolve()),
      } as any);

      const newTabId = useAgentChatStore.getState().createTab();

      const newTab = useAgentChatStore
        .getState()
        .tabs.find((tab) => tab.id === newTabId)!;
      expect(newTab.draft.pinnedContexts).toEqual([
        {
          label: "@main.tex:2:1-2:15",
          filePath: "main.tex",
          selectedText: "Selected words",
        },
      ]);
    });

    it("seeds a new tab draft from the active tab selection chip when editor selection is gone", () => {
      vi.mocked(useDocumentStore.getState).mockReturnValue({
        projectRoot: "/project",
        files: [],
        activeFileId: null,
        selectionRange: null,
        reloadFile: vi.fn(),
        refreshFiles: vi.fn(() => Promise.resolve()),
        saveAllFiles: vi.fn(() => Promise.resolve()),
      } as any);
      useAgentChatStore.getState().saveDraft("tab-default", {
        input: "",
        pinnedContexts: [
          {
            label: "@main.tex:5:1-5:14",
            filePath: "main.tex",
            selectedText: "Hello harness",
          },
        ],
      });

      const newTabId = useAgentChatStore.getState().createTab();

      const newTab = useAgentChatStore
        .getState()
        .tabs.find((tab) => tab.id === newTabId)!;
      expect(newTab.draft.pinnedContexts).toEqual([
        {
          label: "@main.tex:5:1-5:14",
          filePath: "main.tex",
          selectedText: "Hello harness",
        },
      ]);
    });

    it("closing a tab does not remove its triggered proposed changes", () => {
      const chat = useAgentChatStore.getState();
      const tabB = chat.createTab();

      chat.setActiveTab(tabB);
      useProposedChangesStore.getState().addChange({
        id: "from-tab-b",
        filePath: "chapter.tex",
        absolutePath: "/project/chapter.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Write",
      });

      chat.closeTab(tabB);

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
      expect(useProposedChangesStore.getState().changes[0].id).toBe(
        "from-tab-b",
      );
    });

    it("creating a new tab does not clear existing proposed changes", () => {
      useProposedChangesStore.getState().addChange({
        id: "existing-edit",
        filePath: "main.tex",
        absolutePath: "/project/main.tex",
        oldContent: "old",
        newContent: "new",
        toolName: "Edit",
      });

      useAgentChatStore.getState().createTab();

      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });
});
