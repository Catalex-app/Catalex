import { useDocumentStore } from "@/stores/document-store";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useAgentEvents } from "@/hooks/use-agent-events";
import {
  getUnansweredQuestion,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useAgentQuestionStore } from "@/stores/agent-question-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { readTexFileContent } from "@/lib/project-files";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type MockProjectFile = {
  id: string;
  relativePath: string;
  absolutePath: string;
  content: string;
};

const mocks = vi.hoisted(() => {
  const documentState = {
    projectRoot: "/project",
    agentWorkspaceSessionId: null as string | null,
    agentWorkspaceRoot: null as string | null,
    files: [] as MockProjectFile[],
    activeFileId: null as string | null,
    selectionRange: null,
    isCompiling: false,
    refreshFiles: vi.fn(() => Promise.resolve()),
    saveAllFiles: vi.fn(() => Promise.resolve()),
    setIsCompiling: vi.fn(),
    setPendingRecompile: vi.fn(),
    setPdfData: vi.fn(),
    setCompileError: vi.fn(),
    activateAgentWorkspace: vi.fn(),
    setAgentWorkspaceReadOnly: vi.fn(),
    restoreSourceWorkspace: vi.fn(() => Promise.resolve()),
    addAgentWorkspaceReviewFiles: vi.fn(() => Promise.resolve()),
  };
  return {
    documentState,
    documentListeners: new Set<(state: any, previous: any) => void>(),
    historyState: {
      init: vi.fn(() => Promise.resolve()),
      createSnapshot: vi.fn(() => Promise.resolve()),
    },
    eventHandlers: new Map<string, (event: { payload: any }) => void>(),
    unlisteners: [] as ReturnType<typeof vi.fn>[],
    compileLatex: vi.fn(() =>
      Promise.resolve({ pdfData: new Uint8Array(), diagnostics: [] }),
    ),
    resolveCompileTarget: vi.fn(() => ({
      rootId: "main",
      targetPath: "main.tex",
    })),
    getOrOpenDocument: vi.fn(() =>
      Promise.resolve({
        docId: 7,
        pageSizes: [
          { width: 612, height: 792 },
          { width: 612, height: 792 },
        ],
        cacheHit: true,
      }),
    ),
    renderThumbnail: vi.fn(),
  };
});

vi.mock("@/lib/desktop/event", () => ({
  listen: vi.fn(
    (eventName: string, handler: (event: { payload: any }) => void) => {
      mocks.eventHandlers.set(eventName, handler);
      const unlisten = vi.fn();
      mocks.unlisteners.push(unlisten);
      return Promise.resolve(unlisten);
    },
  ),
}));

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: vi.fn(() => mocks.documentState),
    subscribe: (listener: (state: any, previous: any) => void) => {
      mocks.documentListeners.add(listener);
      return () => mocks.documentListeners.delete(listener);
    },
    setState: vi.fn((update) => {
      const previous = { ...mocks.documentState };
      Object.assign(
        mocks.documentState,
        typeof update === "function" ? update(mocks.documentState) : update,
      );
      for (const listener of mocks.documentListeners)
        listener(mocks.documentState, previous);
    }),
  },
}));

vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => mocks.historyState),
  },
}));

vi.mock("@/lib/latex-compiler", () => ({
  compileLatex: mocks.compileLatex,
  detectTexEngineFromContent: vi.fn(() => null),
  resolveCompileTarget: mocks.resolveCompileTarget,
  formatCompileError: vi.fn((error) => error?.message ?? String(error)),
  compileErrorDiagnostics: vi.fn((error) => error?.diagnostics ?? []),
}));

vi.mock("@/lib/project-files", () => ({
  getAssetUrl: vi.fn((path: string) => `asset://localhost/${path}`),
  readTexFileContent: vi.fn(() => Promise.resolve("")),
}));

vi.mock("@/lib/mupdf/mupdf-client", () => ({
  getMupdfClient: vi.fn(() => ({
    renderThumbnail: mocks.renderThumbnail,
  })),
}));

vi.mock("@/lib/mupdf/pdf-doc-cache", () => ({
  getOrOpenDocument: mocks.getOrOpenDocument,
}));

function Harness() {
  useAgentEvents();
  return null;
}

function resetAgentChatStore() {
  useAgentChatStore.setState({
    selectedProvider: "codex",
    messages: [],
    sessionId: null,
    isStreaming: true,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    selectedClaudeModel: "opus",
    selectedClaudeExecutionMode: "default",
    selectedCodexModel: "gpt-5.4",
    selectedCodexReasoningEffort: "medium",
    selectedCodexExecutionMode: "default",
    effortLevel: "medium",
    tabs: [
      {
        id: "tab-default",
        runtimeSessionKey: "runtime-session-test",
        title: "New Chat",
        provider: "codex",
        sessionId: null,
        sharedSessionId: null,
        providerSessionIds: {},
        providerSyncCursors: {},
        pendingCrossProviderTranscript: null,
        messages: [],
        isStreaming: true,
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
}

async function waitForEventHandler(eventName: string) {
  for (let index = 0; index < 20; index += 1) {
    const handler = mocks.eventHandlers.get(eventName);
    if (handler) return handler;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Listener for ${eventName} was not registered`);
}

async function settleAsyncWork() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function pngBuffer(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes.buffer;
}

describe("useAgentEvents provider updates", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    mocks.eventHandlers.clear();
    mocks.unlisteners.length = 0;
    mocks.historyState.createSnapshot.mockClear();
    mocks.historyState.init.mockClear();
    mocks.documentState.files = [];
    mocks.documentState.activeFileId = null;
    mocks.documentState.agentWorkspaceSessionId = null;
    mocks.documentState.agentWorkspaceRoot = null;
    mocks.documentState.selectionRange = null;
    mocks.documentState.isCompiling = false;
    mocks.documentState.refreshFiles.mockReset();
    mocks.documentState.refreshFiles.mockResolvedValue(undefined);
    mocks.documentState.saveAllFiles.mockClear();
    mocks.documentState.setIsCompiling.mockClear();
    mocks.documentState.setPendingRecompile.mockClear();
    mocks.documentState.setPdfData.mockClear();
    mocks.documentState.setCompileError.mockClear();
    mocks.documentState.activateAgentWorkspace.mockReset();
    mocks.documentState.activateAgentWorkspace.mockImplementation(
      async (sessionId: string, candidateRoot: string) => {
        mocks.documentState.agentWorkspaceSessionId = sessionId;
        mocks.documentState.agentWorkspaceRoot = candidateRoot;
      },
    );
    mocks.documentState.setAgentWorkspaceReadOnly.mockClear();
    mocks.documentState.restoreSourceWorkspace.mockClear();
    mocks.documentState.addAgentWorkspaceReviewFiles.mockClear();
    mocks.compileLatex.mockClear();
    mocks.resolveCompileTarget.mockClear();
    mocks.getOrOpenDocument.mockClear();
    mocks.getOrOpenDocument.mockResolvedValue({
      docId: 7,
      pageSizes: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
      ],
      cacheHit: true,
    });
    mocks.renderThumbnail.mockReset();
    mocks.renderThumbnail.mockResolvedValue(pngBuffer(1800, 2329));
    vi.mocked(readTexFileContent).mockReset();
    vi.mocked(readTexFileContent).mockResolvedValue("");
    useAgentReviewQueueStore.setState({ entries: [] });
    resetAgentChatStore();
    useAgentQuestionStore.setState({ questions: [] });
    useProposedChangesStore.setState({
      changes: [],
      activeProjectRoot: null,
      changesByProject: {},
      workspaceReview: null,
      workspaceReviewsByProject: {},
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("finishes native %s compaction without syncing or reconciling history", async (provider) => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        compacting: true,
        isStreaming: true,
        providerSyncCursors: { [provider]: 9 },
      })),
    }));
    await act(async () => root?.render(<Harness />));
    const complete = await waitForEventHandler(`${provider}-complete`);
    await act(async () =>
      complete({
        payload: {
          tab_id: useAgentChatStore.getState().activeTabId,
          success: true,
        },
      }),
    );
    const tab = useAgentChatStore.getState().tabs[0];
    expect(tab.compacting).toBe(false);
    expect(tab.isStreaming).toBe(false);
    expect(tab.providerSyncCursors).toEqual({ [provider]: 9 });
    expect(mocks.documentState.restoreSourceWorkspace).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "desktop:chat:sync-shared",
      expect.anything(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it.each([
    "claude",
    "codex",
  ] as const)("keeps %s operational status transient and separate from errors", async (provider) => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        sessionId: "current-session",
      })),
    }));
    await act(async () => root?.render(<Harness />));
    const output = await waitForEventHandler(`${provider}-output`);
    const compact =
      provider === "claude"
        ? {
            type: "system",
            subtype: "status",
            status: "compacting",
            session_id: "current-session",
          }
        : { type: "provider_status", status: "compacting" };
    const retry =
      provider === "claude"
        ? { type: "system", subtype: "api_retry", error_status: null }
        : { type: "provider_status", status: "retrying" };
    const emit = (message: unknown) =>
      act(() =>
        output({
          payload: { tab_id: "tab-default", data: JSON.stringify(message) },
        }),
      );
    emit(compact);
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBe(
      "compacting",
    );
    emit(retry);
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      isStreaming: true,
      error: null,
      providerStatus: "retrying",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      expect.stringMatching(/^cancel_/),
      expect.anything(),
    );
    act(() => useAgentChatStore.getState()._setStreaming("tab-default", false));
    emit(compact);
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBeNull();
    act(() => useAgentChatStore.getState()._setStreaming("tab-default", true));
    emit(compact);
    act(() =>
      useAgentChatStore.getState()._setError("tab-default", "Terminal error"),
    );
    emit(retry);
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      error: "Terminal error",
      providerStatus: null,
    });
  });

  it.each([
    "claude",
    "codex",
  ] as const)("records %s response context without a query and rejects other sessions", async (provider) => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        sessionId: "current-session",
        contextUsage: undefined,
      })),
    }));
    await act(async () => root?.render(<Harness />));
    const output = await waitForEventHandler(`${provider}-output`);
    const emit = (session: string, tokens: number) =>
      act(() =>
        output({
          payload: {
            tab_id: "tab-default",
            data: JSON.stringify(
              provider === "claude"
                ? {
                    type: "assistant",
                    session_id: session,
                    message: {
                      model: "opus",
                      usage: { input_tokens: tokens, output_tokens: 0 },
                      content: [],
                    },
                  }
                : {
                    method: "thread/tokenUsage/updated",
                    params: {
                      threadId: session,
                      tokenUsage: {
                        last: { totalTokens: tokens },
                        modelContextWindow: 1000,
                      },
                    },
                  },
            ),
          },
        }),
      );
    const callsBefore = vi.mocked(invoke).mock.calls.length;
    emit("current-session", 120);
    emit("other-session", 900);
    expect(
      useAgentChatStore.getState().tabs[0].contextUsage?.[provider]?.tokens,
    ).toBe(120);
    emit("current-session", 40);
    expect(
      useAgentChatStore.getState().tabs[0].contextUsage?.[provider]?.tokens,
    ).toBe(40);
    expect(vi.mocked(invoke).mock.calls.length).toBe(callsBefore);
  });

  it("isolates status between providers and background tabs", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: [
        { ...state.tabs[0], provider: "codex" },
        { ...state.tabs[0], id: "background", provider: "claude" },
      ],
    }));
    await act(async () => root?.render(<Harness />));
    const claude = await waitForEventHandler("claude-output");
    const codex = await waitForEventHandler("codex-output");
    const compact = JSON.stringify({
      type: "system",
      subtype: "status",
      status: "compacting",
    });
    act(() => {
      claude({ payload: { tab_id: "tab-default", data: compact } });
      claude({ payload: { tab_id: "background", data: compact } });
      codex({
        payload: {
          tab_id: "background",
          data: JSON.stringify({
            type: "provider_status",
            status: "retrying",
          }),
        },
      });
    });
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBeFalsy();
    expect(useAgentChatStore.getState().tabs[1].providerStatus).toBe(
      "compacting",
    );
    act(() => useAgentChatStore.getState().setProvider("claude"));
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBeFalsy();
  });

  it("ignores mismatched Claude sessions and clears provider state on unmount", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "claude",
        sessionId: "current",
      })),
    }));
    await act(async () => root?.render(<Harness />));
    const output = await waitForEventHandler("claude-output");
    const send = (session_id: string) =>
      act(() =>
        output({
          payload: {
            tab_id: "tab-default",
            data: JSON.stringify({
              type: "system",
              subtype: "status",
              status: "compacting",
              session_id,
            }),
          },
        }),
      );
    send("old");
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBeFalsy();
    send("current");
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBe(
      "compacting",
    );
    act(() => root?.unmount());
    root = null;
    expect(useAgentChatStore.getState().tabs[0].providerStatus).toBeNull();
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("dispatches a queued %s prompt only after successful completion is settled", async (provider) => {
    let release!: () => void;
    mocks.documentState.refreshFiles.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        queuedPrompts: [{ id: "queued", prompt: "Next", context: [] }],
      })),
    }));
    const run = vi
      .spyOn(useAgentChatStore.getState(), "_runNextQueuedPrompt")
      .mockResolvedValue(undefined);
    await act(async () => {
      root?.render(<Harness />);
    });
    const complete = await waitForEventHandler(`${provider}-complete`);
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: true } });
      await settleAsyncWork();
    });
    expect(run).not.toHaveBeenCalled();
    expect(useAgentChatStore.getState().tabs[0].isSettling).toBe(true);
    await act(async () => {
      release();
      await settleAsyncWork();
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("tab-default");
    expect(useAgentChatStore.getState().tabs[0].isSettling).toBe(false);
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("settles manually stopped %s edits into review without pausing or draining the queue", async (provider) => {
    const workspace = {
      version: 2 as const,
      sessionId: "stopped-draft",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "edit" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "source",
      baselineCommit: "base",
      candidateRoot: "/candidate",
      warnings: [],
    };
    const changes = [
      {
        id: "modified:main.tex",
        kind: "modified",
        filePath: "main.tex",
        oldFilePath: "main.tex",
        newFilePath: "main.tex",
        oldContent: "before",
        newContent: "partial edit",
        binary: false,
        sourceChanged: false,
        sourceAbsolutePath: "/project/main.tex",
        candidateAbsolutePath: "/candidate/main.tex",
      },
    ];
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd, args) =>
      cmd === "reconcile_agent_workspace"
        ? { session: { ...workspace, status: "cancelled" }, changes }
        : original(cmd, args),
    );
    const enqueue = vi
      .spyOn(useAgentReviewQueueStore.getState(), "enqueue")
      .mockResolvedValue();
    const drain = vi
      .spyOn(useAgentChatStore.getState(), "_runNextQueuedPrompt")
      .mockResolvedValue();
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        turnPhase: "running",
        agentWorkspace: workspace,
        draft: { input: "Keep this follow-up", pinnedContexts: [] },
        queuedPrompts: [
          { id: "queued", prompt: "Next request", context: [], createdAt: 1 },
        ],
        pendingQuestion: {
          requestId: "question",
          projectRoot: "/project",
          question: "Continue?",
          options: [],
        },
      })),
    }));
    await act(async () => {
      root?.render(<Harness />);
    });
    await act(async () => {
      await useAgentChatStore.getState().cancelExecution();
    });
    const complete = await waitForEventHandler(`${provider}-complete`);
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: false } });
      complete({ payload: { tab_id: "tab-default", success: false } });
      await settleAsyncWork();
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      isStreaming: false,
      isSettling: false,
      pauseState: null,
      pausedRequest: null,
      cancelledByUser: false,
      promptQueuePaused: true,
      pendingQuestion: null,
      error: null,
      draft: { input: "Keep this follow-up" },
      agentWorkspace: { status: "cancelled" },
    });
    expect(invoke).toHaveBeenCalledWith("reconcile_agent_workspace", {
      projectRoot: "/project",
      sessionId: workspace.sessionId,
      outcome: "cancelled",
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      { ...workspace, status: "cancelled" },
      undefined,
    );
    expect(drain).not.toHaveBeenCalled();
    expect(mocks.compileLatex).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("keeps an interrupted %s turn paused without reconciling its draft", async (provider) => {
    const workspace = {
      version: 2,
      sessionId: "interrupted",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "ask",
      status: "active",
      candidateRoot: "/candidate",
      warnings: [],
    } as any;
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        isStreaming: true,
        turnPhase: "running",
        error: "Lost connection",
        agentWorkspace: workspace,
        retryRequest: { prompt: "Original request", context: [], provider },
      })),
    }));
    await act(async () => {
      root?.render(<Harness />);
    });
    const complete = await waitForEventHandler(`${provider}-complete`);
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: false } });
      complete({ payload: { tab_id: "tab-default", success: false } });
      await settleAsyncWork();
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      isStreaming: false,
      pauseState: "paused",
      turnPhase: null,
      error: "Lost connection",
      agentWorkspace: workspace,
      pausedRequest: null,
    });
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
    expect(mocks.documentState.refreshFiles).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "reconcile_agent_workspace",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(mocks.compileLatex).not.toHaveBeenCalled();
  });

  it.each([
    "claude",
    "codex",
    "pi",
  ] as const)("retains a paused %s draft and ignores duplicate completion", async (provider) => {
    const workspace = {
      version: 2 as const,
      sessionId: "paused-draft",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "edit" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/candidate",
      warnings: [],
    };
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        pauseState: "pausing",
        cancelledByUser: true,
        agentWorkspace: workspace,
        turnPhase: "running",
      })),
    }));
    await act(async () => {
      root?.render(<Harness />);
    });
    const complete = await waitForEventHandler(`${provider}-complete`);
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: false } });
      complete({ payload: { tab_id: "tab-default", success: false } });
      await settleAsyncWork();
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      pauseState: "paused",
      isStreaming: false,
      agentWorkspace: workspace,
      error: null,
    });
    expect(mocks.documentState.refreshFiles).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith(
      "reconcile_agent_workspace",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "discard_agent_workspace",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    expect(mocks.compileLatex).not.toHaveBeenCalled();
  });

  it("does not resurrect a closed question from an in-flight recovery snapshot", async () => {
    let recover!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "list_agent_questions"
        ? new Promise((resolve) => {
            recover = resolve;
          })
        : Promise.resolve(undefined),
    );
    await act(async () => {
      root?.render(<Harness />);
    });
    const receive = await waitForEventHandler("catalex-question");
    const close = await waitForEventHandler("catalex-question-closed");
    const question = {
      requestId: "question",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard unsaved" }],
    };
    await act(async () => {
      receive({ payload: question });
    });
    expect(useAgentQuestionStore.getState().questions).toEqual([question]);
    await act(async () => {
      close({ payload: { requestId: "question" } });
      recover([question]);
      await settleAsyncWork();
    });
    expect(useAgentQuestionStore.getState().questions).toEqual([]);
  });

  it.each([
    "codex",
    "claude",
  ] as const)("persists an unanswered %s question and restores it without starting inference", async (provider) => {
    const question = {
      requestId: "persist-q",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard unsaved" }],
    };
    let saved: any;
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === "save_shared_session") {
        saved = args;
        return { shared_session_id: "saved-chat" };
      }
      if (command === "load_shared_session")
        return {
          shared_session_id: "saved-chat",
          title: "Review",
          last_provider: provider,
          provider_session_ids: {},
          messages: saved.messages,
          pending_question: saved.pendingQuestion,
        };
      return undefined;
    });
    useAgentQuestionStore.getState().receive(question);
    await vi.waitFor(() =>
      expect(saved?.pendingQuestion).toEqual({
        requestId: question.requestId,
        projectRoot: question.projectRoot,
        question: question.question,
        options: question.options,
      }),
    );
    // Simulate project close/app memory loss, then reopening the saved chat.
    useAgentChatStore.getState().newSession();
    useAgentQuestionStore.setState({ questions: [] });
    vi.mocked(invoke).mockClear();
    await useAgentChatStore
      .getState()
      .resumeSession("saved-chat", { useSessionLlm: true });
    const tab = useAgentChatStore.getState().tabs[0];
    expect(tab).toMatchObject({
      isStreaming: false,
      pendingQuestion: saved.pendingQuestion,
    });
    expect(tab.runtimeSessionKey).not.toBe(question.sessionId);
    expect(invoke).not.toHaveBeenCalledWith(
      "answer_agent_question",
      expect.anything(),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) =>
          /^(execute|resume)_(codex|claude)_code$/.test(command),
        ),
    ).toBe(false);
  });

  it.each([
    "codex",
    "claude",
  ] as const)("records a %s question answer before continuation and saves it in history", async (provider) => {
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({ ...tab, provider })),
    }));
    const chat = useAgentChatStore.getState();
    chat._appendMessage("tab-default", {
      type: "assistant",
      message: { content: [{ type: "text", text: "How should I proceed?" }] },
    });
    useAgentQuestionStore.getState().receive({
      requestId: "q-history",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "How should I proceed?",
      options: [{ label: "Update comment" }, { label: "Discard unsaved" }],
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "answer_agent_question") {
        // The provider may resume before the answer IPC acknowledgement arrives.
        const current = useAgentChatStore.getState().messages;
        expect(current[current.length - 1]?.type).toBe("user");
        chat._applyActivity("tab-default", {
          kind: "text_delta",
          id: "resumed",
          text: "Reviewing the latest paragraph.",
        });
      }
      return undefined;
    });
    await useAgentQuestionStore
      .getState()
      .answer("q-history", "Update comment");
    const messages = useAgentChatStore.getState().messages;
    expect(messages.map((message) => message.type)).toEqual([
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[1].message?.content).toEqual([
      { type: "text", text: "Update comment" },
    ]);
    expect(invoke).toHaveBeenCalledWith(
      "save_shared_session",
      expect.objectContaining({ messages, pendingQuestion: null }),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) =>
          /^(execute|resume)_(codex|claude)_code$/.test(command),
        ),
    ).toBe(false);
    expect(
      getUnansweredQuestion(useAgentChatStore.getState().tabs[0]),
    ).toBeNull();
    expect(useAgentChatStore.getState().tabs[0].pendingQuestion).toBeNull();
    expect(useAgentChatStore.getState().isStreaming).toBe(true);
  });

  it("preserves a newer question received before an answer acknowledgement", async () => {
    const question = {
      requestId: "q-first",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [],
    };
    useAgentQuestionStore.getState().receive(question);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "answer_agent_question")
        useAgentQuestionStore.getState().receive({
          ...question,
          requestId: "q-next",
          question: "Which section?",
        });
      return undefined;
    });
    await useAgentQuestionStore.getState().answer("q-first", "Update");
    expect(
      useAgentChatStore.getState().tabs[0].pendingQuestion?.requestId,
    ).toBe("q-next");
    expect(
      useAgentQuestionStore.getState().questions.map((q) => q.requestId),
    ).toEqual(["q-next"]);
  });

  it("does not leave a rejected question answer in history and allows retry", async () => {
    useAgentQuestionStore.getState().receive({
      requestId: "q-history",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard" }],
    });
    vi.mocked(invoke).mockRejectedValueOnce(new Error("Connection failed"));
    await expect(
      useAgentQuestionStore.getState().answer("q-history", "Update"),
    ).rejects.toThrow("Connection failed");
    expect(useAgentChatStore.getState().messages).toEqual([]);
    expect(useAgentQuestionStore.getState().questions).toHaveLength(1);
    expect(
      useAgentChatStore.getState().tabs[0].pendingQuestion?.requestId,
    ).toBe("q-history");
    await useAgentQuestionStore
      .getState()
      .answer("q-history", "Custom instruction");
    expect(useAgentChatStore.getState().messages).toHaveLength(1);
    expect(useAgentChatStore.getState().messages[0].message?.content).toEqual([
      { type: "text", text: "Custom instruction" },
    ]);
  });

  it("does not let an older pending save overwrite a submitted answer", async () => {
    let release!: () => void;
    const saves: any[] = [];
    let persisted: any;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "save_shared_session") return undefined;
      saves.push(args);
      if (saves.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      persisted = args;
      return { shared_session_id: "saved-chat" };
    });
    useAgentQuestionStore.getState().receive({
      requestId: "q-race",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard" }],
    });
    const answering = useAgentQuestionStore
      .getState()
      .answer("q-race", "Update");
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(saves).toHaveLength(1);
    } finally {
      release();
    }
    await answering;
    expect(persisted.pendingQuestion).toBeNull();
    expect(
      persisted.messages.some(
        (message: any) => message.uuid === "question-answer-q-race",
      ),
    ).toBe(true);
  });

  it("does not attach a late question-save acknowledgement to a new chat", async () => {
    let release!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation((command) =>
      command === "save_shared_session"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(undefined),
    );
    useAgentQuestionStore.getState().receive({
      requestId: "q-late",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard" }],
    });
    useAgentChatStore.getState().newSession();
    release({ shared_session_id: "old-chat" });
    await Promise.resolve();
    expect(useAgentChatStore.getState().tabs[0].sharedSessionId).toBeNull();
    expect(useAgentChatStore.getState().tabs[0].pendingQuestion).toBeNull();
  });

  it("updates an earlier tool after an answer without duplicating it or moving new text before the answer", async () => {
    const chat = useAgentChatStore.getState();
    const tool = {
      kind: "tool_started" as const,
      id: "ask-tool",
      name: "mcp__catalex__ask_user",
      input: { question: "What next?" },
    };
    chat._applyActivity("tab-default", tool);
    useAgentQuestionStore.getState().receive({
      requestId: "q-history",
      tabId: "tab-default",
      sessionId: "runtime-session-test",
      projectRoot: "/project",
      question: "What next?",
      options: [{ label: "Update" }, { label: "Discard" }],
    });
    await useAgentQuestionStore.getState().answer("q-history", "Update");
    chat._applyActivity("tab-default", {
      kind: "tool_completed",
      id: "ask-tool",
      content: "Update",
    });
    chat._applyActivity("tab-default", tool); // Late provider finalization of the same tool.
    chat._applyActivity("tab-default", {
      kind: "text_delta",
      id: "new-text",
      text: "Updating.",
    });
    const messages = useAgentChatStore.getState().messages;
    expect(
      messages
        .flatMap((m) => m.message?.content ?? [])
        .filter((b) => b.type === "tool_use"),
    ).toHaveLength(1);
    expect(messages[1].message?.content).toEqual([
      { type: "text", text: "Update" },
    ]);
    expect(messages[messages.length - 1]?.message?.content).toEqual([
      { type: "text", id: "new-text", text: "Updating." },
    ]);
  });

  it("routes app-server thread.started to the event tab instead of the active tab", async () => {
    useAgentChatStore.setState((state) => ({
      sessionId: null,
      tabs: [
        {
          ...state.tabs[0],
          id: "tab-event",
          provider: "codex",
          sessionId: null,
          providerSessionIds: {},
          isStreaming: true,
        },
        {
          ...state.tabs[0],
          id: "tab-active",
          provider: "codex",
          sessionId: null,
          providerSessionIds: {},
          isStreaming: true,
        },
      ],
      activeTabId: "tab-active",
      selectedProvider: "codex",
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexOutput = await waitForEventHandler("codex-output");

    act(() => {
      codexOutput({
        payload: {
          tab_id: "tab-event",
          data: JSON.stringify({
            type: "thread.started",
            thread_id: "thread-from-event",
            session_id: "thread-from-event",
          }),
        },
      });
    });

    const state = useAgentChatStore.getState();
    const eventTab = state.tabs.find((tab) => tab.id === "tab-event")!;
    const activeTab = state.tabs.find((tab) => tab.id === "tab-active")!;

    expect(eventTab.sessionId).toBe("thread-from-event");
    expect(eventTab.providerSessionIds.codex).toBe("thread-from-event");
    expect(activeTab.sessionId).toBeNull();
    expect(activeTab.providerSessionIds.codex).toBeUndefined();
    expect(state.sessionId).toBeNull();
  });

  it("routes Pi sessions, usage, and activity to the matching background chat", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: [state.tabs[0], { ...state.tabs[0], id: "pi-tab", provider: "pi" }],
    }));
    await act(async () => root?.render(<Harness />));
    const output = await waitForEventHandler("pi-output");
    const activity = await waitForEventHandler("pi-activity");
    act(() => {
      for (const tabId of ["tab-default", "pi-tab", "missing"]) {
        for (const message of [
          { type: "session", session_id: "/sessions/pi.jsonl" },
          { type: "usage", tokens: 120, capacity: 1000, model: "test-model" },
        ]) {
          output({ payload: { tab_id: tabId, data: JSON.stringify(message) } });
        }
        for (const item of [
          { kind: "thinking_delta", item_id: "thinking", text: "Inspecting" },
          {
            kind: "tool_started",
            item_id: "read",
            name: "read",
            input: { path: "main.tex" },
          },
          {
            kind: "tool_completed",
            item_id: "read",
            content: "Source",
            is_error: false,
          },
          { kind: "text_delta", item_id: "answer", text: "Draft " },
          { kind: "text_delta", item_id: "answer", text: "ready." },
        ]) {
          activity({ payload: { tab_id: tabId, ...item } });
        }
      }
    });
    const state = useAgentChatStore.getState();
    expect(state.tabs[0]).toMatchObject({
      messages: [],
      sessionId: null,
      providerSessionIds: {},
    });
    expect(state.messages).toEqual([]);
    expect(state.sessionId).toBeNull();
    const tab = state.tabs[1];
    expect(tab).toMatchObject({
      sessionId: "/sessions/pi.jsonl",
      providerSessionIds: { pi: "/sessions/pi.jsonl" },
      contextUsage: {
        pi: { tokens: 120, capacity: 1000, model: "test-model" },
      },
    });
    expect(
      tab.messages.find((message) => message.type === "assistant")?.message
        ?.content,
    ).toEqual([
      {
        type: "thinking",
        id: "thinking",
        thinking: "Inspecting",
        signature: "thinking",
      },
      {
        type: "tool_use",
        id: "read",
        name: "read",
        input: { path: "main.tex" },
      },
      { type: "text", id: "answer", text: "Draft ready." },
    ]);
    expect(
      tab.messages.find((message) => message.type === "user")?.message?.content,
    ).toEqual([
      {
        type: "tool_result",
        tool_use_id: "read",
        content: "Source",
        is_error: false,
      },
    ]);
  });

  it("shows nonfatal Pi diagnostics and tracks native compaction and retries", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: [{ ...state.tabs[0], provider: "pi" }],
    }));
    await act(async () => root?.render(<Harness />));
    const output = await waitForEventHandler("pi-output");
    const send = (message: Record<string, unknown>) =>
      act(() => {
        output({
          payload: { tab_id: "tab-default", data: JSON.stringify(message) },
        });
      });
    const tab = () => useAgentChatStore.getState().tabs[0];
    send({
      type: "extension_error",
      event: "session_start",
      error: "Hook failed",
      extensionPath: "/config/extension.ts",
    });
    expect(tab().messages[tab().messages.length - 1]).toMatchObject({
      type: "result",
      subtype: "error",
      result:
        "Pi extension error (session_start): Hook failed\n/config/extension.ts",
    });
    expect(tab().isStreaming).toBe(true);
    expect(tab().error).toBeNull();
    send({ type: "usage", tokens: 800, capacity: 1000 });
    send({ type: "compaction_start", reason: "threshold" });
    expect(tab().providerStatus).toBe("compacting");
    send({
      type: "compaction_end",
      result: { estimatedTokensAfter: 200 },
      willRetry: false,
    });
    expect(tab().contextUsage?.pi).toMatchObject({
      tokens: 200,
      capacity: 1000,
    });
    expect(tab().providerStatus).toBeNull();
    send({ type: "auto_retry_start", attempt: 1 });
    expect(tab().providerStatus).toBe("retrying");
    send({
      type: "auto_retry_end",
      success: false,
      finalError: "Retries exhausted",
    });
    expect(tab().providerStatus).toBeNull();
    expect(tab().messages[tab().messages.length - 1]?.result).toBe(
      "Pi: Retries exhausted",
    );
    send({
      type: "compaction_end",
      errorMessage: "Summary failed",
      aborted: false,
    });
    expect(tab().messages[tab().messages.length - 1]?.result).toBe(
      "Pi: Summary failed",
    );
    const count = tab().messages.length;
    send({ type: "compaction_end", errorMessage: "Cancelled", aborted: true });
    expect(tab().messages).toHaveLength(count);
    expect(tab().isStreaming).toBe(true);
    expect(tab().error).toBeNull();
  });

  it("keeps Pi failures on their chat and ignores late events after completion", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: [state.tabs[0], { ...state.tabs[0], id: "pi-tab", provider: "pi" }],
    }));
    await act(async () => root?.render(<Harness />));
    const error = await waitForEventHandler("pi-error");
    const complete = await waitForEventHandler("pi-complete");
    const activity = await waitForEventHandler("pi-activity");
    const output = await waitForEventHandler("pi-output");
    await act(async () => {
      for (const tabId of ["tab-default", "pi-tab"]) {
        error({ payload: { tab_id: tabId, data: "Authentication failed" } });
        complete({ payload: { tab_id: tabId, success: false } });
      }
      await settleAsyncWork();
      error({ payload: { tab_id: "pi-tab", data: "Late error" } });
      activity({
        payload: {
          tab_id: "pi-tab",
          kind: "text_delta",
          item_id: "late",
          text: "Late text",
        },
      });
      output({
        payload: {
          tab_id: "pi-tab",
          data: JSON.stringify({ type: "session", session_id: "late" }),
        },
      });
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      error: null,
      isStreaming: true,
    });
    expect(useAgentChatStore.getState().tabs[1]).toMatchObject({
      error: "Authentication failed",
      isStreaming: false,
      pauseState: "paused",
      sessionId: null,
      messages: [],
    });
    expect(mocks.documentState.refreshFiles).not.toHaveBeenCalled();
    expect(mocks.compileLatex).not.toHaveBeenCalled();
  });

  it("reports a Pi failure even if the harness supplied no error", async () => {
    useAgentChatStore.setState((state) => ({
      selectedProvider: "pi",
      tabs: state.tabs.map((tab) => ({ ...tab, provider: "pi" })),
    }));
    await act(async () => root?.render(<Harness />));
    const complete = await waitForEventHandler("pi-complete");
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: false } });
      await settleAsyncWork();
    });
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      error: "Pi request failed without an error message.",
      isStreaming: false,
      pauseState: "paused",
    });
  });

  it("projects Codex reasoning, tools, and streamed text into ordered chat blocks", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });

    const codexActivity = await waitForEventHandler("codex-activity");
    const codexFinal = await waitForEventHandler("codex-final");

    act(() => {
      codexActivity({
        payload: {
          tab_id: "tab-default",
          kind: "thinking_delta",
          item_id: "reason-1",
          text: "Inspecting the project",
        },
      });
      codexActivity({
        payload: {
          tab_id: "tab-default",
          kind: "tool_started",
          item_id: "command-1",
          name: "Bash",
          input: { command: "rg --files" },
        },
      });
      codexActivity({
        payload: {
          tab_id: "tab-default",
          kind: "tool_completed",
          item_id: "command-1",
          content: "main.tex",
          is_error: false,
        },
      });
      codexActivity({
        payload: {
          tab_id: "tab-default",
          kind: "text_delta",
          item_id: "answer-1",
          text: "Draft answer",
        },
      });
      codexFinal({
        payload: {
          tab_id: "tab-default",
          item_id: "answer-1",
          data: "Final answer",
        },
      });
    });

    const messages = useAgentChatStore.getState().tabs[0].messages;
    const assistant = messages.find((message) => message.type === "assistant");
    expect(assistant?.message?.content).toEqual([
      {
        type: "thinking",
        id: "reason-1",
        thinking: "Inspecting the project",
        signature: "reason-1",
      },
      {
        type: "tool_use",
        id: "command-1",
        name: "Bash",
        input: { command: "rg --files" },
      },
      { type: "text", id: "answer-1", text: "Final answer" },
    ]);
    expect(
      messages.find((message) => message.type === "user")?.message?.content,
    ).toEqual([
      {
        type: "tool_result",
        tool_use_id: "command-1",
        content: "main.tex",
        is_error: false,
      },
    ]);
  });

  it("ignores terminal agent events without their matching start", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });
    const compile = await waitForEventHandler("catalex-verification-compile");
    await act(async () => {
      await compile({
        payload: {
          request_id: "unknown",
          project_path: "/project",
          root_id: "main",
          status: "failed",
          error: "obsolete",
        },
      });
    });
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("a cancelled agent compilation releases its spinner without publishing results", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });
    const compile = await waitForEventHandler("catalex-verification-compile");
    const payload = {
      request_id: "cancelled",
      project_path: "/project",
      root_id: "main",
    };
    await act(async () => {
      await compile({ payload: { ...payload, status: "started" } });
    });
    expect(mocks.documentState.isCompiling).toBe(true);
    vi.mocked(invoke).mockClear();
    await act(async () => {
      await compile({ payload: { ...payload, status: "cancelled" } });
    });
    expect(mocks.documentState.isCompiling).toBe(false);
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith(
      "get_compiled_pdf",
      expect.anything(),
    );
  });

  it("does not substitute another PDF when a request-specific result has expired", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "get_compiled_pdf" ? null : undefined,
    );
    await act(async () => {
      root?.render(<Harness />);
    });
    const compile = await waitForEventHandler("catalex-verification-compile");
    const payload = {
      request_id: "expired",
      project_path: "/project",
      root_id: "main",
    };
    await act(async () => {
      await compile({ payload: { ...payload, status: "started" } });
      await compile({ payload: { ...payload, status: "succeeded" } });
      await settleAsyncWork();
    });
    expect(invoke).toHaveBeenCalledWith("get_compiled_pdf", {
      projectDir: "/project",
      requestId: "expired",
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("an older agent failure cannot finish a newer compilation", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });
    const compile = await waitForEventHandler("catalex-verification-compile");
    await act(async () => {
      await compile({
        payload: {
          request_id: "old",
          project_path: "/project",
          root_id: "main",
          status: "started",
        },
      });
      await compile({
        payload: {
          request_id: "new",
          project_path: "/project",
          root_id: "main",
          status: "started",
        },
      });
      await compile({
        payload: {
          request_id: "old",
          project_path: "/project",
          root_id: "main",
          status: "failed",
          error: "obsolete",
        },
      });
    });
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(true);
    await act(async () => {
      await compile({
        payload: {
          request_id: "new",
          project_path: "/project",
          root_id: "main",
          status: "failed",
          error: "current",
        },
      });
    });
    expect(mocks.documentState.setCompileError).toHaveBeenCalledWith(
      "current",
      "main",
      [],
    );
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("loads the exact PDF produced by an in-turn Codex compile", async () => {
    const pdfBuffer = new Uint8Array([37, 80, 68, 70]).buffer;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") return pdfBuffer;
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexCompile = await waitForEventHandler(
      "catalex-verification-compile",
    );
    act(() => {
      codexCompile({
        payload: {
          request_id: "compile-1",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "started",
        },
      });
    });
    expect(mocks.documentState.isCompiling).toBe(true);

    await act(async () => {
      codexCompile({
        payload: {
          request_id: "compile-1",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "succeeded",
          duration_ms: 125,
          diagnostics: [
            { severity: "warning", message: "Undefined reference" },
          ],
        },
      });
      await settleAsyncWork();
    });

    expect(invoke).toHaveBeenCalledWith("get_compiled_pdf", {
      requestId: "compile-1",
      projectDir: "/project",
    });
    expect(mocks.documentState.setPdfData).toHaveBeenCalledWith(
      new Uint8Array(pdfBuffer),
      "main",
      undefined,
      [{ severity: "warning", message: "Undefined reference" }],
    );
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it.each([
    false,
    true,
  ])("ignores a late PDF load after switching drafts (failed=%s)", async (failed) => {
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command !== "get_compiled_pdf") return Promise.resolve(undefined);
      return new Promise((resolve, reject) => {
        finish = () =>
          failed
            ? reject(new Error("old draft failed"))
            : resolve(new ArrayBuffer(4));
      });
    });
    mocks.documentState.agentWorkspaceRoot = "/draft-a";
    mocks.documentState.agentWorkspaceSessionId = "draft-a";
    await act(async () => {
      root?.render(<Harness />);
    });
    const compile = await waitForEventHandler("catalex-verification-compile");
    act(() => {
      compile({
        payload: {
          request_id: "compile-1",
          project_path: "/draft-a",
          root_id: "main",
          status: "started",
        },
      });
      compile({
        payload: {
          request_id: "compile-1",
          tab_id: "tab-default",
          project_path: "/draft-a",
          root_id: "main",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "succeeded",
        },
      });
    });
    expect(invoke).toHaveBeenCalledWith("get_compiled_pdf", {
      requestId: "compile-1",
      projectDir: "/draft-a",
    });
    useDocumentStore.setState({
      agentWorkspaceRoot: "/draft-b",
      agentWorkspaceSessionId: "draft-b",
    });
    await act(async () => {
      finish();
      await settleAsyncWork();
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("projects an in-turn Codex compile failure into the preview error state", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });

    const codexCompile = await waitForEventHandler(
      "catalex-verification-compile",
    );
    act(() => {
      codexCompile({
        payload: {
          request_id: "compile-1",
          project_path: "/project",
          root_id: "main",
          status: "started",
        },
      });
      codexCompile({
        payload: {
          request_id: "compile-1",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "failed",
          duration_ms: 80,
          error: "Undefined control sequence at main.tex:12",
          diagnostics: [
            {
              severity: "error",
              message: "Undefined control sequence",
              file: "main.tex",
              line: 12,
            },
          ],
        },
      });
    });

    expect(mocks.documentState.setCompileError).toHaveBeenCalledWith(
      "Undefined control sequence at main.tex:12",
      "main",
      [
        {
          severity: "error",
          message: "Undefined control sequence",
          file: "main.tex",
          line: 12,
        },
      ],
    );
    expect(mocks.documentState.isCompiling).toBe(false);
    expect(invoke).not.toHaveBeenCalledWith(
      "get_compiled_pdf",
      expect.anything(),
    );
  });

  it("keeps sandbox compile events out of the source PDF preview", async () => {
    const pdfBuffer = new Uint8Array([37, 80, 68, 70]).buffer;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") return pdfBuffer;
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });
    const codexCompile = await waitForEventHandler(
      "catalex-verification-compile",
    );

    act(() => {
      codexCompile({
        payload: {
          tab_id: "tab-default",
          project_path: "/workspace/candidate",
          root_id: "main",
          main_file: "main.tex",
          backend: "latexmk",
          engine: "lualatex",
          status: "succeeded",
          duration_ms: 125,
        },
      });
    });
    await settleAsyncWork();

    expect(invoke).not.toHaveBeenCalledWith("get_compiled_pdf", {
      projectDir: "/workspace/candidate",
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("renders requested compiled PDF pages through the shared MuPDF cache", async () => {
    const pdfBuffer = new Uint8Array([37, 80, 68, 70]).buffer;
    mocks.renderThumbnail
      .mockResolvedValueOnce(pngBuffer(1800, 2329))
      .mockResolvedValueOnce(pngBuffer(1800, 2400));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") return pdfBuffer;
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexRenderPage = await waitForEventHandler(
      "catalex-verification-render-page",
    );
    await act(async () => {
      codexRenderPage({
        payload: {
          request_id: "render-1",
          tab_id: "tab-default",
          project_path: "/background-project",
          root_id: "main",
          pages: [1, 2],
          target_width: 900,
        },
      });
      await settleAsyncWork();
    });

    expect(invoke).toHaveBeenCalledWith("get_compiled_pdf", {
      projectDir: "/background-project",
    });
    expect(mocks.getOrOpenDocument).toHaveBeenCalledWith(
      new Uint8Array(pdfBuffer),
    );
    expect(mocks.renderThumbnail).toHaveBeenNthCalledWith(1, 7, 0, 900);
    expect(mocks.renderThumbnail).toHaveBeenNthCalledWith(2, 7, 1, 900);
    expect(invoke).toHaveBeenCalledWith("resolve_verification_render_request", {
      requestId: "render-1",
      result: {
        status: "success",
        pageCount: 2,
        pages: [
          {
            page: 1,
            width: 1800,
            height: 2329,
            imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
          },
          {
            page: 2,
            width: 1800,
            height: 2400,
            imageDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      },
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
    expect(mocks.documentState.isCompiling).toBe(false);
  });

  it("returns a bounded invalid-page error without rendering or changing preview state", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") {
        return new Uint8Array([37, 80, 68, 70]).buffer;
      }
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexRenderPage = await waitForEventHandler(
      "catalex-verification-render-page",
    );
    await act(async () => {
      codexRenderPage({
        payload: {
          request_id: "render-invalid",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          pages: [3],
          target_width: 900,
        },
      });
      await settleAsyncWork();
    });

    expect(mocks.renderThumbnail).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("resolve_verification_render_request", {
      requestId: "render-invalid",
      result: {
        status: "error",
        code: "invalid_page",
        message: "Requested page 3; the compiled PDF has 2 page(s)",
        pageCount: 2,
      },
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
  });

  it("returns a missing-PDF error when no compiled output is cached", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") {
        throw new Error("No compiled PDF is available for this project");
      }
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexRenderPage = await waitForEventHandler(
      "catalex-verification-render-page",
    );
    await act(async () => {
      codexRenderPage({
        payload: {
          request_id: "render-missing",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          pages: [1],
          target_width: 900,
        },
      });
      await settleAsyncWork();
    });

    expect(mocks.getOrOpenDocument).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("resolve_verification_render_request", {
      requestId: "render-missing",
      result: {
        status: "error",
        code: "missing_pdf",
        message: "No compiled PDF is available for this project",
      },
    });
  });

  it("returns a structured render failure when MuPDF cannot open the compiled PDF", async () => {
    mocks.getOrOpenDocument.mockRejectedValueOnce(new Error("damaged PDF"));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "get_compiled_pdf") {
        return new Uint8Array([37, 80, 68, 70]).buffer;
      }
      return undefined;
    });

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexRenderPage = await waitForEventHandler(
      "catalex-verification-render-page",
    );
    await act(async () => {
      codexRenderPage({
        payload: {
          request_id: "render-failed",
          tab_id: "tab-default",
          project_path: "/project",
          root_id: "main",
          pages: [1],
          target_width: 900,
        },
      });
      await settleAsyncWork();
    });

    expect(invoke).toHaveBeenCalledWith("resolve_verification_render_request", {
      requestId: "render-failed",
      result: {
        status: "error",
        code: "render_failed",
        message: "damaged PDF",
      },
    });
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(mocks.documentState.setCompileError).not.toHaveBeenCalled();
  });

  it("keeps quota updates and stderr diagnostic without hiding real SDK failures", async () => {
    await act(async () => {
      root?.render(<Harness />);
    });
    const output = await waitForEventHandler("claude-output");
    const diagnostic = await waitForEventHandler("claude-diagnostic");
    const failure = await waitForEventHandler("claude-error");
    const emit = (message: unknown) =>
      act(() =>
        output({
          payload: {
            tab_id: "tab-default",
            data: JSON.stringify(message),
          },
        }),
      );
    for (const status of ["allowed", "allowed_warning", "rejected"]) {
      emit({
        type: "rate_limit_event",
        rate_limit_info: { status, rateLimitType: "seven_day" },
      });
    }
    act(() =>
      diagnostic({
        payload: {
          tab_id: "tab-default",
          data: "git-bash error in optional diagnostic",
        },
      }),
    );
    expect(useAgentChatStore.getState().error).toBeNull();
    act(() =>
      failure({
        payload: { tab_id: "tab-default", data: "Original SDK exception" },
      }),
    );
    expect(useAgentChatStore.getState().error).toBe("Original SDK exception");
    emit({
      type: "result",
      is_error: true,
      errors: ["Original failure", "Provider detail"],
    });
    expect(useAgentChatStore.getState().error).toBe(
      "Original failure\nProvider detail",
    );
    emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
    expect(useAgentChatStore.getState().error).toBe(
      "Original failure\nProvider detail",
    );
  });

  it("merges Claude partial events and the completed assistant message without duplicates", async () => {
    useAgentChatStore.setState((state) => ({
      selectedProvider: "claude",
      tabs: state.tabs.map((tab) => ({ ...tab, provider: "claude" })),
    }));
    await act(async () => {
      root?.render(<Harness />);
    });

    const claudeOutput = await waitForEventHandler("claude-output");
    act(() => {
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "stream_event",
            uuid: "assistant-1",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          }),
        },
      });
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "stream_event",
            uuid: "assistant-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "I will inspect. " },
            },
          }),
        },
      });
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "stream_event",
            uuid: "assistant-1",
            event: {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: {},
              },
            },
          }),
        },
      });
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            message: {
              content: [
                { type: "text", text: "I will inspect. " },
                {
                  type: "tool_use",
                  id: "read-1",
                  name: "Read",
                  input: { file_path: "/project/main.tex" },
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
        },
      });
    });

    const messages = useAgentChatStore.getState().tabs[0].messages;
    const assistants = messages.filter(
      (message) => message.type === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect(assistants[0].message?.content).toEqual([
      { type: "text", id: "assistant-1:0", text: "I will inspect. " },
      {
        type: "tool_use",
        id: "read-1",
        name: "Read",
        input: { file_path: "/project/main.tex" },
      },
    ]);
    expect(useAgentChatStore.getState().totalInputTokens).toBe(10);
    expect(useAgentChatStore.getState().totalOutputTokens).toBe(5);
  });

  it("does not register Claude edit-mode tool results as proposed changes", async () => {
    mocks.documentState.files = [
      {
        id: "main",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        content: "before",
      },
    ];
    vi.mocked(readTexFileContent).mockResolvedValue("after");
    useAgentChatStore.setState((state) => ({
      selectedProvider: "claude",
      selectedClaudeExecutionMode: "edit",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "claude",
        isStreaming: true,
        pendingClaudeExecutionMode: "edit",
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });

    const claudeOutput = await waitForEventHandler("claude-output");

    act(() => {
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Edit",
                  input: { file_path: "/project/main.tex" },
                },
              ],
            },
          }),
        },
      });
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  is_error: false,
                  content: "edited",
                },
              ],
            },
          }),
        },
      });
    });
    await settleAsyncWork();

    expect(useProposedChangesStore.getState().changes).toHaveLength(0);
  });

  it("does not treat Claude tool results as filesystem truth", async () => {
    mocks.documentState.files = [
      {
        id: "main",
        relativePath: "main.tex",
        absolutePath: "/project/main.tex",
        content: "before",
      },
    ];
    vi.mocked(readTexFileContent).mockResolvedValue("after");
    useAgentChatStore.setState((state) => ({
      selectedProvider: "claude",
      selectedClaudeExecutionMode: "default",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "claude",
        isStreaming: true,
        pendingClaudeExecutionMode: "default",
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });

    const claudeOutput = await waitForEventHandler("claude-output");

    act(() => {
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "MultiEdit",
                  input: { file_path: "/project/main.tex" },
                },
              ],
            },
          }),
        },
      });
      claudeOutput({
        payload: {
          tab_id: "tab-default",
          data: JSON.stringify({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  is_error: false,
                  content: "edited",
                },
              ],
            },
          }),
        },
      });
    });
    await settleAsyncWork();

    expect(readTexFileContent).not.toHaveBeenCalled();
    expect(useProposedChangesStore.getState().changes).toHaveLength(0);
  });

  it.each([
    "codex",
    "pi",
  ] as const)("reconciles and verifies a %s ask-mode workspace without changing source files", async (provider) => {
    const workspaceSession = {
      version: 2,
      sessionId: "workspace-1",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "ask" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/workspace/candidate",
      warnings: [],
    };
    mocks.documentState.files = [
      {
        id: "main",
        relativePath: "main.tex",
        absolutePath: "/workspace/candidate/main.tex",
        content: "after",
      },
    ];
    mocks.documentState.agentWorkspaceRoot = null;
    mocks.documentState.activeFileId = "main";
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (
        command === "reconcile_agent_workspace" ||
        command === "preview_agent_workspace"
      ) {
        return {
          session: { ...workspaceSession, status: "review" },
          currentContents: { "workspace-change": "before" },
          mergedContents: {},
          sourceRevision: "revision-1",
          conflicts: [],
          changes: [
            {
              id: "workspace-change",
              kind: "modified",
              filePath: "main.tex",
              oldFilePath: "main.tex",
              newFilePath: "main.tex",
              sourceAbsolutePath: "/project/main.tex",
              candidateAbsolutePath: "/workspace/candidate/main.tex",
              oldContent: "before",
              newContent: "after",
              binary: false,
              sourceChanged: false,
            },
          ],
        } as any;
      }
      return undefined;
    });
    useAgentChatStore.setState((state) => ({
      selectedProvider: provider,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider,
        sharedSessionId: "shared-session",
        providerSessionIds: { [provider]: "thread-1" },
        isStreaming: true,
        pendingFileBaseline: null,
        roundTiming: {
          elapsedMs: 4200,
          runningSince: null,
          startIndex: 0,
          waitingFor: [],
        },
        messages: [
          {
            type: "assistant" as const,
            message: {
              content: [
                { type: "text" as const, text: "Draft ready for review." },
              ],
            },
          },
        ],
        agentWorkspace: workspaceSession,
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexComplete = await waitForEventHandler(`${provider}-complete`);

    await act(async () => {
      codexComplete({
        payload: {
          tab_id: "tab-default",
          success: true,
        },
      });
      await settleAsyncWork();
    });

    const tab = useAgentChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    expect(tab.roundTiming).toMatchObject({
      elapsedMs: 4200,
      runningSince: null,
      finished: true,
    });
    expect(tab.messages[0]).toMatchObject({
      roundDurationMs: 4200,
      roundCompletedAt: expect.any(Number),
    });
    expect(useAgentChatStore.getState().messages[0].roundDurationMs).toBe(4200);
    expect(tab.pendingFileBaseline).toBeNull();
    expect(mocks.historyState.createSnapshot).not.toHaveBeenCalled();
    expect(mocks.documentState.refreshFiles).not.toHaveBeenCalled();
    expect(mocks.documentState.saveAllFiles).toHaveBeenCalledWith({
      requireClean: true,
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    expect(useAgentReviewQueueStore.getState().entries[0]?.phase).toBe(
      "review",
    );
    expect(mocks.documentState.activateAgentWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      "/workspace/candidate",
    );
    expect(mocks.compileLatex.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.documentState.activateAgentWorkspace.mock.invocationCallOrder[0],
    );
    expect(mocks.compileLatex).toHaveBeenCalledWith(
      "/workspace/candidate",
      "main.tex",
      "latexmk",
      "pdflatex",
      undefined,
    );
    // Verifying a candidate must not replace the current project's PDF.
    expect(mocks.documentState.setPdfData).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith(
      "save_shared_session",
      expect.objectContaining({
        sharedSessionId: "shared-session",
        providerSessionIds: { [provider]: "thread-1" },
      }),
    );
    expect(useProposedChangesStore.getState().changes).toEqual([
      expect.objectContaining({
        id: "workspace-change",
        filePath: "main.tex",
        absolutePath: "/workspace/candidate/main.tex",
        oldContent: "before",
        newContent: "after",
        toolName: "Agent modified",
        workspaceSessionId: "workspace-1",
      }),
    ]);
  });

  it("automatically applies a verified Edit-mode workspace after compilation", async () => {
    const workspaceSession = {
      version: 2,
      sessionId: "workspace-edit",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "edit" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/workspace/candidate",
      warnings: [],
    };
    const change = {
      id: "workspace-change",
      kind: "modified",
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
    mocks.documentState.files = [
      {
        id: "main",
        relativePath: "main.tex",
        absolutePath: "/workspace/candidate/main.tex",
        content: "after",
      },
    ];
    mocks.documentState.activeFileId = "main";
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (
        command === "reconcile_agent_workspace" ||
        command === "preview_agent_workspace"
      ) {
        return {
          session: { ...workspaceSession, status: "review" },
          currentContents: { "workspace-change": "before" },
          mergedContents: {},
          sourceRevision: "revision-1",
          conflicts: [],
          changes: [change],
        } as any;
      }
      if (command === "apply_agent_workspace") {
        return {
          applied: true,
          changedPaths: ["main.tex"],
          conflicts: [],
        } as any;
      }
      return undefined;
    });
    useAgentChatStore.setState((state) => ({
      selectedProvider: "codex",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "codex",
        isStreaming: true,
        agentWorkspace: workspaceSession,
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });
    const complete = await waitForEventHandler("codex-complete");
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: true } });
      await settleAsyncWork();
    });

    expect(invoke).toHaveBeenCalledWith("apply_agent_workspace", {
      projectRoot: "/project",
      sessionId: "workspace-edit",
      expectedSourceRevision: "revision-1",
      decisions: [
        { changeId: "workspace-change", accept: true, content: "after" },
      ],
    });
    expect(invoke).toHaveBeenCalledWith("discard_agent_workspace", {
      projectRoot: "/project",
      sessionId: "workspace-edit",
    });
    expect(mocks.historyState.createSnapshot).toHaveBeenCalledWith(
      "/project",
      "[edit] After accepted agent edit",
    );
    expect(mocks.documentState.restoreSourceWorkspace).toHaveBeenCalledWith(
      ["main.tex"],
      { preserveSelection: true },
    );
    expect(mocks.compileLatex).toHaveBeenCalledWith(
      "/workspace/candidate",
      "main.tex",
      "latexmk",
      "pdflatex",
      undefined,
    );
    const applyIndex = vi
      .mocked(invoke)
      .mock.calls.findIndex(([command]) => command === "apply_agent_workspace");
    expect(mocks.compileLatex.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(invoke).mock.invocationCallOrder[applyIndex],
    );
    expect(mocks.documentState.activateAgentWorkspace).not.toHaveBeenCalled();
    expect(useAgentReviewQueueStore.getState().entries).toEqual([]);
    expect(useAgentChatStore.getState().tabs[0].agentWorkspace).toBeNull();
    expect(useProposedChangesStore.getState().changes).toEqual([]);
  });

  it("keeps an Edit-mode workspace for review when candidate verification fails", async () => {
    const workspaceSession = {
      version: 2,
      sessionId: "workspace-edit-failed",
      projectRoot: "/project",
      tabId: "tab-default",
      mode: "edit" as const,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/workspace/candidate",
      warnings: [],
    };
    const change = {
      id: "workspace-change",
      kind: "modified",
      filePath: "main.tex",
      oldFilePath: "main.tex",
      newFilePath: "main.tex",
      sourceAbsolutePath: "/project/main.tex",
      candidateAbsolutePath: "/workspace/candidate/main.tex",
      oldContent: "before",
      newContent: "broken",
      binary: false,
      sourceChanged: false,
    };
    mocks.documentState.files = [
      {
        id: "main",
        relativePath: "main.tex",
        absolutePath: "/workspace/candidate/main.tex",
        content: "broken",
      },
    ];
    mocks.documentState.activeFileId = "main";
    mocks.compileLatex.mockRejectedValueOnce(new Error("compile failed"));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (
        command === "reconcile_agent_workspace" ||
        command === "preview_agent_workspace"
      ) {
        return {
          session: { ...workspaceSession, status: "review" },
          currentContents: { "workspace-change": "before" },
          mergedContents: {},
          sourceRevision: "revision-1",
          conflicts: [],
          changes: [change],
        } as any;
      }
      return undefined;
    });
    useAgentChatStore.setState((state) => ({
      selectedProvider: "codex",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "codex",
        isStreaming: true,
        agentWorkspace: workspaceSession,
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });
    const complete = await waitForEventHandler("codex-complete");
    await act(async () => {
      complete({ payload: { tab_id: "tab-default", success: true } });
      await settleAsyncWork();
    });

    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    expect(mocks.documentState.restoreSourceWorkspace).not.toHaveBeenCalled();
    expect(useProposedChangesStore.getState().changes).toEqual([
      expect.objectContaining({
        id: "workspace-change",
        workspaceSessionId: "workspace-edit-failed",
      }),
    ]);
    expect(useAgentChatStore.getState().tabs[0].error).toContain(
      "did not compile",
    );
    expect(useAgentReviewQueueStore.getState().entries[0]?.phase).toBe(
      "review",
    );
    // Rechecking source conflicts must not clear the failed compilation gate.
    await act(async () => {
      await useAgentReviewQueueStore
        .getState()
        .recheck("workspace-edit-failed");
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "apply_agent_workspace",
      expect.anything(),
    );
    expect(useAgentReviewQueueStore.getState().entries[0]?.phase).toBe(
      "review",
    );
  });

  it.each([
    null,
    "Connection failed\nRetry budget exhausted",
  ])("clears failed Codex completion without post-edit work and preserves error %s", async (message) => {
    useAgentChatStore.setState((state) => ({
      selectedProvider: "codex",
      tabs: state.tabs.map((tab) => ({
        ...tab,
        provider: "codex",
        isStreaming: true,
        pendingFileBaseline: { "main.tex": "before" },
      })),
      isStreaming: true,
    }));

    await act(async () => {
      root?.render(<Harness />);
    });

    const codexComplete = await waitForEventHandler("codex-complete");
    const codexOutput = await waitForEventHandler("codex-output");

    await act(async () => {
      if (message) {
        codexOutput({
          payload: {
            tab_id: "tab-default",
            data: JSON.stringify({ type: "error", message }),
          },
        });
      }
      codexComplete({
        payload: {
          tab_id: "tab-default",
          success: false,
        },
      });
      await settleAsyncWork();
    });

    const tab = useAgentChatStore.getState().tabs[0];
    expect(tab.isStreaming).toBe(false);
    expect(tab.pauseState).toBe("paused");
    if (message) expect(tab.error).toBe(message);
    expect(mocks.historyState.createSnapshot).not.toHaveBeenCalled();
    expect(mocks.documentState.refreshFiles).not.toHaveBeenCalled();
    expect(mocks.documentState.saveAllFiles).not.toHaveBeenCalled();
    expect(mocks.compileLatex).not.toHaveBeenCalled();
    expect(useProposedChangesStore.getState().changes).toHaveLength(0);
  });
});
