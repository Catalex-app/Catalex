import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import {
  useAgentChatStore,
  createChatPanelStore,
  lastCommunicationDetails,
  type QueuedChatPrompt,
} from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useDocumentStore } from "@/stores/document-store";

vi.mock("@/lib/project-chat-lifecycle", () => ({
  saveProjectChats: vi.fn(async () => {}),
  withChatCheckpoint: vi.fn(async (operation) => operation()),
}));
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: { getState: () => ({ init: vi.fn(async () => {}) }) },
}));
vi.mock("@/lib/agent-workspace", async (original) => ({
  ...(await original<typeof import("@/lib/agent-workspace")>()),
  prepareAgentWorkspace: vi.fn(async (_root, tabId) => ({
    version: 2,
    sessionId: `workspace-${tabId}`,
    projectRoot: "/project",
    candidateRoot: `/draft/${tabId}`,
    tabId,
    status: "active",
    sourceCommit: "source",
    baselineCommit: "base",
    warnings: [],
  })),
}));

const initial = structuredClone(useAgentChatStore.getState().tabs[0]);
const queued = (id: string): QueuedChatPrompt => ({
  id,
  prompt: id,
  context: [],
});
function tab() {
  return useAgentChatStore.getState().tabs.find((item) => item.id === "one")!;
}
function update(patch: Partial<ReturnType<typeof tab>>) {
  useAgentChatStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === "one" ? { ...item, ...patch } : item,
    ),
  }));
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) =>
      command === "save_shared_session"
        ? ({ shared_session_id: "shared", last_modified: 1 } as never)
        : (undefined as never),
    );
  useSettingsStore.setState({
    enabledProviders: { claude: true, codex: true, pi: false },
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useAgentChatStore.setState({
    tabs: ["one", "two"].map((id) => ({
      ...structuredClone(initial),
      id,
      runtimeSessionKey: id,
      provider: "codex",
      isStreaming: true,
      turnPhase: "running",
      agentWorkspace: null,
      error: null,
      draft: { input: "Keep my newer draft", pinnedContexts: [] },
      messages: [],
    })),
    activeTabId: "one",
    selectedProvider: "codex",
    chatProjectRoot: "/project",
    isLeavingProject: false,
    isStreaming: true,
    error: null,
  });
  useDocumentStore.setState({
    projectRoot: "/project",
    files: [],
    activeFileId: "",
    selectionRange: null,
    pdfSelectionContext: null,
    agentWorkspaceRoot: null,
    saveAllFiles: vi.fn(async () => {}),
    refreshFiles: vi.fn(async () => {}),
  });
});

describe("chat prompt queue", () => {
  it("resets manual prompt visibility on file changes, not content updates", () => {
    useDocumentStore.setState({ activeFileId: "main.tex" });
    const store = useAgentChatStore.getState();
    store.setMiniPromptsExpanded("one", false);
    store.setMiniPromptsExpanded("two", true);
    useDocumentStore.setState({ contentGeneration: 10 });
    expect(tab().miniPromptsExpanded).toBe(false);
    useDocumentStore.setState({ activeFileId: "figure.svg" });
    expect(
      useAgentChatStore
        .getState()
        .tabs.every((item) => item.miniPromptsExpanded === undefined),
    ).toBe(true);
    useDocumentStore.setState({ activeFileId: "main.tex" });
    expect(tab().miniPromptsExpanded).toBeUndefined();
    store.setMiniPromptsExpanded("one", true);
    useDocumentStore.setState({ projectRoot: "/another-project" });
    expect(tab().miniPromptsExpanded).toBeUndefined();
  });
  it("resets manual Mini prompt visibility on each chat visit", () => {
    const store = useAgentChatStore.getState();
    store.setMiniPromptsExpanded("one", true);
    store.setMiniPromptsExpanded("two", false);
    store.setActiveTab("two");
    expect(
      useAgentChatStore.getState().tabs.find((item) => item.id === "two")
        ?.miniPromptsExpanded,
    ).toBeUndefined();
    store.setActiveTab("one");
    expect(tab().miniPromptsExpanded).toBeUndefined();
  });
  it("folds only the submitting tab's Mini prompts after acceptance, not rejection", async () => {
    const store = useAgentChatStore.getState();
    store.setMiniPromptsExpanded("one", true);
    store.setMiniPromptsExpanded("two", true);
    const accepted = vi.fn();
    await store.sendPrompt("", [], false, accepted);
    expect(accepted).not.toHaveBeenCalled();
    expect(tab().miniPromptsExpanded).toBe(true);
    await store.sendPrompt("Review this", [], false, accepted);
    expect(accepted).toHaveBeenCalledOnce();
    expect(tab().miniPromptsExpanded).toBe(false);
    expect(
      useAgentChatStore.getState().tabs.find((item) => item.id === "two")
        ?.miniPromptsExpanded,
    ).toBe(true);
  });
  it("continues after a turn that completed before its launch acknowledgement", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a"), queued("b")],
    });
    let acknowledge!: () => void;
    const send = vi
      .spyOn(useAgentChatStore.getState(), "sendPrompt")
      .mockImplementation(async (prompt, _context, _retry, accepted) => {
        accepted?.();
        if (prompt === "a")
          await new Promise<void>((resolve) => {
            acknowledge = resolve;
          });
      });
    const first = useAgentChatStore.getState()._runNextQueuedPrompt("one");
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    expect(send).toHaveBeenCalledTimes(1);
    acknowledge();
    await first;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(tab().queuedPrompts).toEqual([]);
  });
  it("resumes a paused turn ahead of queued follow-ups", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      pauseState: "paused",
      promptQueuePaused: true,
      queuedPrompts: [queued("a")],
    });
    await useAgentChatStore.getState().continueExecution();
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({ prompt: expect.stringContaining("Continue") }),
    );
    expect(tab().queuedPrompts?.map((item) => item.id)).toEqual(["a"]);
  });
  it("answers a restored question ahead of queued follow-ups", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      promptQueuePaused: true,
      queuedPrompts: [queued("a")],
      pendingQuestion: {
        requestId: "question",
        projectRoot: "/project",
        question: "Which method?",
        options: [],
      },
    });
    await useAgentChatStore
      .getState()
      ._answerRestoredQuestion("one", "question", "Method B");
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({ prompt: expect.stringContaining("Method B") }),
    );
    expect(tab().queuedPrompts?.map((item) => item.id)).toEqual(["a"]);
    expect(tab().pendingQuestion).toBeNull();
  });
  it("does not replace a conversation that has unsent queued prompts", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a")],
    });
    useAgentChatStore.getState().newSession();
    useAgentChatStore.getState().clearMessages();
    await useAgentChatStore.getState().resumeSession("different-session");
    expect(tab().runtimeSessionKey).toBe("one");
    expect(tab().queuedPrompts?.map((item) => item.id)).toEqual(["a"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "load_shared_session",
      expect.anything(),
    );
  });
  it.each([
    "running",
    "starting",
    "settling",
  ])("accepts multiple prompts while %s and captures their context", async (phase) => {
    update({
      isStreaming: phase === "running",
      turnPhase: phase === "starting" ? "starting" : null,
      isSettling: phase === "settling",
    });
    const context = [
      { label: "@main.tex:1:1-1:4", filePath: "main.tex", selectedText: "old" },
    ];
    const accepted = vi.fn();
    await useAgentChatStore
      .getState()
      .sendPrompt("First", context, false, accepted);
    context[0].selectedText = "changed later";
    await useAgentChatStore
      .getState()
      .sendPrompt("Second", [], false, accepted);
    expect(accepted).toHaveBeenCalledTimes(2);
    expect(tab().queuedPrompts?.map((item) => item.prompt)).toEqual([
      "First",
      "Second",
    ]);
    expect(tab().queuedPrompts?.[0].context[0].selectedText).toBe("old");
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
  });
  it("withdraws a prompt into the selected chat's normal draft and sends it to the back normally", () => {
    update({ queuedPrompts: [queued("a"), queued("b"), queued("c")] });
    const store = useAgentChatStore.getState();
    store.moveQueuedPrompt("one", "c", "a");
    expect(store.editQueuedPrompt("one", "c")).toEqual({
      input: "c",
      pinnedContexts: [],
    });
    expect(tab().queuedPrompts?.map((item) => item.prompt)).toEqual(["a", "b"]);
    store.enqueuePrompt("one", "Edited C", []);
    store.removeQueuedPrompt("one", "b");
    expect(tab().queuedPrompts?.map((item) => item.prompt)).toEqual([
      "a",
      "Edited C",
    ]);
    expect(useAgentChatStore.getState().tabs[1].queuedPrompts).toBeUndefined();
  });
  it("replaces existing input and attachments, and allows another queued prompt to replace it again", () => {
    const store = useAgentChatStore.getState();
    const context = [
      {
        label: "@queued.md",
        filePath: "queued.md",
        selectedText: "Queue attachment",
      },
    ];
    update({
      draft: {
        input: "Discard this draft",
        pinnedContexts: [
          {
            label: "@old.md",
            filePath: "old.md",
            selectedText: "Old attachment",
          },
        ],
      },
      queuedPrompts: [{ ...queued("a"), context }, queued("b")],
    });
    store.editQueuedPrompt("one", "a");
    expect(tab().draft).toEqual({ input: "a", pinnedContexts: context });
    store.editQueuedPrompt("one", "b");
    expect(tab().draft).toEqual({ input: "b", pinnedContexts: [] });
    expect(tab().queuedPrompts).toEqual([]);
  });
  it("does not withdraw a message already being dispatched or replace input for a missing message", () => {
    const store = useAgentChatStore.getState();
    update({ queuedPrompts: [queued("a")], dispatchingQueuedPromptId: "a" });
    expect(store.editQueuedPrompt("one", "a")).toBeNull();
    expect(store.editQueuedPrompt("one", "missing")).toBeNull();
    expect(tab().draft.input).toBe("Keep my newer draft");
    expect(tab().queuedPrompts).toHaveLength(1);
  });
  it("runs remaining messages while a withdrawn prompt stays in the normal draft", async () => {
    const store = useAgentChatStore.getState();
    update({ queuedPrompts: [queued("a"), queued("b")] });
    store.editQueuedPrompt("one", "a");
    store.saveDraft("one", { input: "Still editing A", pinnedContexts: [] });
    update({ isStreaming: false, turnPhase: null });
    await store._runNextQueuedPrompt("one");
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({ prompt: expect.stringContaining("b") }),
    );
    expect(tab().queuedPrompts).toEqual([]);
    expect(tab().draft.input).toBe("Still editing A");
  });
  it.each([
    { isSettling: true },
    { pauseState: "paused" as const },
    { error: "Disconnected" },
    { promptQueuePaused: true },
    { pendingQuestion: {} as never },
    { pendingResumeChoice: {} as never },
  ])("does not dispatch while blocked by %j", async (patch) => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a")],
      ...patch,
    });
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    expect(tab().queuedPrompts).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
  });
  it("retains a prompt when dispatch is not accepted, and prevents concurrent dispatch", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a"), queued("b")],
    });
    let finish!: () => void;
    const send = vi
      .spyOn(useAgentChatStore.getState(), "sendPrompt")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const first = useAgentChatStore.getState()._runNextQueuedPrompt("one");
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    useAgentChatStore.getState().removeQueuedPrompt("one", "a");
    expect(send).toHaveBeenCalledTimes(1);
    expect(tab().queuedPrompts).toHaveLength(2);
    finish();
    await first;
    expect(tab().dispatchingQueuedPromptId).toBeNull();
    expect(tab().queuedPrompts).toHaveLength(2);
  });
  it("sends only the first queued prompt and leaves the composer draft intact", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a"), queued("b")],
    });
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({ tabId: "one" }),
    );
    expect(tab().queuedPrompts?.map((item) => item.id)).toEqual(["b"]);
    expect(tab().draft.input).toBe("Keep my newer draft");
    expect(tab().isStreaming).toBe(true);
  });
  it("routes a background queue to its own provider and tab without moving focus", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a")],
    });
    useAgentChatStore.setState({
      activeTabId: "two",
      selectedProvider: "claude",
    });
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    expect(invoke).toHaveBeenCalledWith(
      "execute_codex_code",
      expect.objectContaining({ tabId: "one" }),
    );
    expect(useAgentChatStore.getState().activeTabId).toBe("two");
    expect(useAgentChatStore.getState().selectedProvider).toBe("claude");
  });
  it("does not dispatch into a different project", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      queuedPrompts: [queued("a")],
    });
    useDocumentStore.setState({ projectRoot: "/another-project" });
    await useAgentChatStore.getState()._runNextQueuedPrompt("one");
    expect(tab().queuedPrompts).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
  });
  it("restores queued text and editing drafts paused without replaying them", () => {
    const restored = {
      ...tab(),
      queuedPrompts: [queued("b")],
      draft: { input: "Unfinished edit", pinnedContexts: [] },
      dispatchingQueuedPromptId: "a",
    };
    useAgentChatStore
      .getState()
      .restoreProjectTabs("/project", [restored], "one");
    expect(tab()).toMatchObject({
      queuedPrompts: restored.queuedPrompts,
      draft: restored.draft,
      promptQueuePaused: true,
      dispatchingQueuedPromptId: null,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
  });
});

it.each([
  false,
  true,
])("routes Pi %s through its harness with the draft workspace and model", async (resume) => {
  useSettingsStore.getState().setProviderEnabled("pi", true);
  const model = JSON.stringify(["anthropic", "test-model"]);
  usePiSetupStore.setState({
    models: [
      {
        id: "test-model",
        provider: "anthropic",
        name: "Test",
        reasoning: true,
      },
    ],
  });
  update({
    provider: "pi",
    isStreaming: false,
    turnPhase: null,
    sessionId: resume ? "/pi/session.jsonl" : null,
    providerSessionIds: resume ? { pi: "/pi/session.jsonl" } : {},
  });
  useAgentChatStore.setState({
    selectedProvider: "pi",
    isStreaming: false,
    selectedPiModel: model,
    selectedPiReasoningEffort: "max",
  });
  const request = resume
    ? "/skill:review-document Review this document"
    : "Review this document";
  await useAgentChatStore.getState().sendPrompt(request, [
    {
      filePath: "main.tex",
      label: "main.tex:1:1-1:5",
      selectedText: "Draft excerpt",
    },
  ]);
  expect(invoke).toHaveBeenCalledWith(
    resume ? "resume_pi_code" : "execute_pi_code",
    expect.objectContaining({
      tabId: "one",
      projectPath: "/draft/one",
      sourceProjectPath: "/project",
      model,
      reasoningEffort: "high",
      sessionId: resume ? "/pi/session.jsonl" : null,
    }),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "execute_codex_code",
    expect.anything(),
  );
  expect(invoke).not.toHaveBeenCalledWith(
    "execute_claude_code",
    expect.anything(),
  );
  const args = vi
    .mocked(invoke)
    .mock.calls.find(
      ([command]) =>
        command === (resume ? "resume_pi_code" : "execute_pi_code"),
    )![1]!;
  expect(args.prompt).toContain("Draft excerpt");
  expect(args.prompt).toContain("Review this document");
  if (resume) {
    expect(args.prompt).toMatch(/^\/skill:review-document /);
    expect(String(args.prompt).match(/\/skill:review-document/g)).toHaveLength(
      1,
    );
  }
  await useAgentChatStore.getState().cancelExecution();
  expect(invoke).toHaveBeenCalledWith("cancel_pi_execution", { tabId: "one" });
});

describe("sent model and effort snapshot", () => {
  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("captures %s settings used by the request", async (provider) => {
    useSettingsStore.setState({
      enabledProviders: { claude: true, codex: true, pi: true },
    });
    useClaudeSetupStore.setState({
      models: [
        {
          value: "claude-sonnet-4-6",
          displayName: "Sonnet 4.6",
          description: "",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
      ],
    });
    usePiSetupStore.setState({
      models: [
        {
          id: "test-model",
          provider: "test",
          name: "Test model",
          reasoning: true,
        },
      ],
    });
    const model =
      provider === "claude"
        ? "claude-sonnet-4-6"
        : provider === "pi"
          ? '["test","test-model"]'
          : "gpt-6.1-sol";
    update({ provider, isStreaming: false, turnPhase: null, pauseState: null });
    useAgentChatStore.setState({
      selectedProvider: provider,
      isStreaming: false,
      selectedClaudeModel: "claude-sonnet-4-6",
      effortLevel: "max",
      selectedCodexModel: "gpt-6.1-sol",
      selectedCodexReasoningEffort: "high",
      selectedPiModel: '["test","test-model"]',
      selectedPiReasoningEffort: "max",
    });
    await useAgentChatStore.getState().sendPrompt("Remember this model", []);
    const request = vi
      .mocked(invoke)
      .mock.calls.find(([name]) => name === `execute_${provider}_code`);
    expect(request).toBeDefined();
    const effort = provider === "claude" ? "low" : "high";
    expect(request![1]).toEqual(
      expect.objectContaining({
        model,
        [provider === "claude" ? "effortLevel" : "reasoningEffort"]: effort,
      }),
    );
    expect(lastCommunicationDetails(tab())).toEqual({
      provider,
      model,
      effort,
    });
    useAgentChatStore.setState({
      selectedCodexModel: "other-model",
      selectedCodexReasoningEffort: "low",
      effortLevel: "low",
      selectedPiReasoningEffort: "off",
    });
    expect(lastCommunicationDetails(tab())).toEqual({
      provider,
      model,
      effort,
    });
  });
});

describe("pinned chat views", () => {
  it("queues a simultaneous send from the other view instead of starting a second agent", async () => {
    update({ isStreaming: false, turnPhase: null });
    const { store: view, dispose } = createChatPanelStore("one");
    try {
      await Promise.all([
        view.getState().sendPrompt("First send", []),
        useAgentChatStore.getState().sendPrompt("Second send", []),
      ]);
      expect(
        vi
          .mocked(invoke)
          .mock.calls.filter(([name]) => name === "execute_codex_code"),
      ).toHaveLength(1);
      expect(tab().queuedPrompts?.map((item) => item.prompt)).toEqual([
        "Second send",
      ]);
      expect(
        tab().messages.filter((message) => message.type === "user"),
      ).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("keeps an in-flight agent and its messages alive when the pop-out closes", async () => {
    update({ isStreaming: false, turnPhase: null });
    const { store: view, dispose } = createChatPanelStore("one");
    await view.getState().sendPrompt("Continue after close", []);
    dispose();
    useAgentChatStore.getState().setActiveTab("two");
    useAgentChatStore.getState()._appendMessage("one", {
      type: "assistant",
      message: { content: [{ type: "text", text: "Still running" }] },
    });
    expect(tab().isStreaming).toBe(true);
    expect(tab().messages.slice(-1)[0]?.message?.content).toEqual([
      { type: "text", text: "Still running" },
    ]);
    expect(invoke).not.toHaveBeenCalledWith(
      "cancel_codex_execution",
      expect.anything(),
    );
    const reopened = createChatPanelStore("one");
    expect(reopened.store.getState().messages).toBe(tab().messages);
    reopened.dispose();
  });

  it("discards an in-flight history preparation when its project changes", async () => {
    update({
      isStreaming: false,
      turnPhase: null,
      sessionId: "session-one",
      sharedSessionId: "shared-one",
      history: { start: 1000, total: 1000 },
    });
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "desktop:chat:prepare-turn")
        return new Promise((resolve) => {
          release = resolve;
        }) as never;
      return undefined as never;
    });
    const { store: view, dispose } = createChatPanelStore("one");
    try {
      const sending = view.getState().sendPrompt("Old project prompt", []);
      await vi.waitFor(() => expect(release).toBeDefined());
      useAgentChatStore.setState({ chatProjectRoot: "/different-project" });
      useDocumentStore.setState({ projectRoot: "/different-project" });
      release({
        messages: [],
        start: 1000,
        total: 1000,
        prefixCount: 1000,
        latestReview: null,
        transcript: "",
      });
      await sending;
      expect(tab().messages).toEqual([]);
      expect(tab().isStreaming).toBe(false);
      expect(invoke).not.toHaveBeenCalledWith(
        "execute_codex_code",
        expect.anything(),
      );
    } finally {
      dispose();
    }
  });

  it("shares one chat's edits, model choices and stream without selecting it in the owner", async () => {
    update({ isStreaming: false, turnPhase: null });
    const { store: view, dispose } = createChatPanelStore("one");
    try {
      useAgentChatStore.getState().setActiveTab("two");
      const otherModel = useAgentChatStore.getState().selectedCodexModel;
      view.getState().setSelectedCodexModel("gpt-6.1-sol");
      view.getState().setSelectedCodexReasoningEffort("high");
      view
        .getState()
        .saveDraft("one", { input: "Only for one", pinnedContexts: [] });
      expect(view.getState().activeTabId).toBe("one");
      expect(useAgentChatStore.getState().activeTabId).toBe("two");
      expect(useAgentChatStore.getState().selectedCodexModel).toBe(otherModel);
      expect(tab().draft.input).toBe("Only for one");
      expect(
        useAgentChatStore.getState().tabs.find((t) => t.id === "two")?.draft
          .input,
      ).toBe("Keep my newer draft");
      await view.getState().sendPrompt("Send from pinned chat", []);
      expect(invoke).toHaveBeenCalledWith(
        "execute_codex_code",
        expect.objectContaining({
          tabId: "one",
          model: "gpt-6.1-sol",
          reasoningEffort: "high",
        }),
      );
      expect(useAgentChatStore.getState().activeTabId).toBe("two");
      expect(useAgentChatStore.getState().messages).not.toEqual(
        view.getState().messages,
      );
      useAgentChatStore.getState()._appendMessage("one", {
        type: "assistant",
        provider: "codex",
        message: { content: [{ type: "text", text: "Response to one" }] },
      });
      expect(view.getState().messages.slice(-1)[0]?.message?.content).toEqual([
        { type: "text", text: "Response to one" },
      ]);
      await view.getState().cancelExecution();
      expect(invoke).toHaveBeenCalledWith(
        "cancel_codex_execution",
        expect.objectContaining({ tabId: "one" }),
      );
      expect(useAgentChatStore.getState().activeTabId).toBe("two");
      useAgentChatStore.getState().setActiveTab("one");
      expect(useAgentChatStore.getState().selectedCodexModel).toBe(
        "gpt-6.1-sol",
      );
      expect(useAgentChatStore.getState().selectedCodexReasoningEffort).toBe(
        "high",
      );
    } finally {
      dispose();
    }
  });
  it("changes the pinned provider and resumes its question without affecting the owner's chat", async () => {
    update({ isStreaming: false, turnPhase: null });
    const { store: view, dispose } = createChatPanelStore("one");
    try {
      useAgentChatStore.getState().setActiveTab("two");
      view.getState().setProvider("claude");
      expect(tab().provider).toBe("claude");
      expect(view.getState().selectedProvider).toBe("claude");
      expect(useAgentChatStore.getState().selectedProvider).toBe("codex");
      view.getState().setProvider("codex");
      update({
        pauseState: "paused",
        pendingQuestion: {
          requestId: "question",
          projectRoot: "/project",
          question: "Which method?",
          options: [],
        },
      });
      await view
        .getState()
        ._answerRestoredQuestion("one", "question", "Method B");
      expect(invoke).toHaveBeenCalledWith(
        "execute_codex_code",
        expect.objectContaining({
          tabId: "one",
          prompt: expect.stringContaining("Method B"),
        }),
      );
      expect(useAgentChatStore.getState().activeTabId).toBe("two");
      expect(tab().pendingQuestion).toBeNull();
    } finally {
      dispose();
    }
  });
});

it("does not retain initial transcripts or keep observing the owner after a chat view closes", () => {
  update({
    messages: [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Loaded transcript" }] },
      },
    ],
  });
  const { store: view, dispose } = createChatPanelStore("one");
  expect(view.getState().messages).toHaveLength(1);
  // The permanent Zustand initial snapshot must not pin any loaded transcript.
  expect(view.getInitialState().tabs).toEqual([]);
  expect(view.getInitialState().messages).toEqual([]);
  const notify = vi.fn();
  const stop = view.subscribe(notify);
  update({ title: "Updated title" });
  expect(notify).toHaveBeenCalledTimes(1);
  dispose();
  update({ title: "After close" });
  expect(notify).toHaveBeenCalledTimes(1);
  stop();
});

it("rejects stale pop-out edits and sends after the owner changes project", async () => {
  update({ isStreaming: false, turnPhase: null });
  const { store: view, dispose } = createChatPanelStore("one");
  try {
    useAgentChatStore.setState({ chatProjectRoot: "/different-project" });
    view
      .getState()
      .saveDraft("one", { input: "Stale draft", pinnedContexts: [] });
    await view.getState().sendPrompt("Stale prompt", []);
    expect(tab().draft.input).toBe("Keep my newer draft");
    expect(invoke).not.toHaveBeenCalledWith(
      "execute_codex_code",
      expect.anything(),
    );
  } finally {
    dispose();
  }
});
