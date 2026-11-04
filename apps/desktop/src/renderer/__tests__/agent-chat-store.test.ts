import { invoke } from "@/lib/desktop/core";
import { describe, it, expect, vi } from "vitest";
import {
  offsetToLineCol,
  lastCommunicationProvider,
  lastCommunicationDetails,
  useAgentChatStore,
  type AgentStreamMessage,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

describe("lastCommunicationProvider", () => {
  it("follows conversation messages rather than the selected provider", () => {
    const tab = {
      ...useAgentChatStore.getState().tabs[0],
      provider: "codex" as const,
      messages: [
        { type: "assistant", provider: "claude" },
      ] as AgentStreamMessage[],
      history: undefined,
    };
    expect(lastCommunicationProvider(tab)).toBe("claude");
    tab.messages.push({ type: "user", provider: "codex" });
    expect(lastCommunicationProvider(tab)).toBe("codex");
    tab.messages.push({ type: "system", provider: "pi" });
    expect(lastCommunicationProvider(tab)).toBe("codex");
  });

  it("keeps the latest provider while browsing older history, and leaves empty chats blank", () => {
    const tab = {
      ...useAgentChatStore.getState().tabs[0],
      lastCommunicationProvider: "pi" as const,
      messages: [
        { type: "assistant", provider: "claude" },
      ] as AgentStreamMessage[],
      history: { start: 0, total: 100 },
    };
    expect(lastCommunicationProvider(tab)).toBe("pi");
    expect(
      lastCommunicationProvider({ ...tab, history: undefined, messages: [] }),
    ).toBeUndefined();
  });
});

describe("offsetToLineCol", () => {
  it("returns line 1, col 1 for offset 0 on empty string", () => {
    expect(offsetToLineCol("", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns line 1, col 1 for offset 0 on non-empty string", () => {
    expect(offsetToLineCol("hello", 0)).toEqual({ line: 1, col: 1 });
  });

  it("returns correct col within a single line", () => {
    expect(offsetToLineCol("hello world", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles offset at end of single line", () => {
    expect(offsetToLineCol("hello", 5)).toEqual({ line: 1, col: 6 });
  });

  it("handles multiple lines correctly", () => {
    const content = "line1\nline2\nline3";
    // offset 6 is start of "line2"
    expect(offsetToLineCol(content, 6)).toEqual({ line: 2, col: 1 });
    // offset 11 is end of "line2" (the newline before line3)
    expect(offsetToLineCol(content, 11)).toEqual({ line: 2, col: 6 });
    // offset 12 is start of "line3"
    expect(offsetToLineCol(content, 12)).toEqual({ line: 3, col: 1 });
  });

  it("returns correct position at end of multi-line content", () => {
    const content = "ab\ncd\nef";
    expect(offsetToLineCol(content, 8)).toEqual({ line: 3, col: 3 });
  });

  it("handles content with only newlines", () => {
    expect(offsetToLineCol("\n\n", 1)).toEqual({ line: 2, col: 1 });
    expect(offsetToLineCol("\n\n", 2)).toEqual({ line: 3, col: 1 });
  });
});

describe("forkSessionAtMessage", () => {
  it("creates and persists an independent transcript through the selected answer", async () => {
    const messages: AgentStreamMessage[] = [
      {
        type: "user",
        sentAt: 1791000000000,
        provider: "codex",
        message: { content: [{ type: "text", text: "First question" }] },
      },
      {
        type: "assistant",
        provider: "codex",
        message: { content: [{ type: "text", text: "First answer" }] },
      },
      {
        type: "user",
        provider: "codex",
        message: { content: [{ type: "text", text: "Second question" }] },
      },
      {
        type: "assistant",
        provider: "codex",
        message: { content: [{ type: "text", text: "Second answer" }] },
      },
    ];
    const initial = useAgentChatStore.getState();
    const sourceTab = {
      ...initial.tabs[0],
      id: "source-tab",
      title: "Original chat",
      provider: "codex" as const,
      sessionId: "codex-thread",
      sharedSessionId: "shared-source",
      providerSessionIds: { codex: "codex-thread" },
      providerSyncCursors: { codex: 4 },
      messages,
    };
    useDocumentStore.setState({ projectRoot: "/tmp/fork-test" });
    useAgentChatStore.setState({
      tabs: [sourceTab],
      activeTabId: sourceTab.id,
      selectedProvider: "codex",
      messages,
      sessionId: sourceTab.sessionId,
      isStreaming: false,
      error: null,
      totalInputTokens: 12,
      totalOutputTokens: 24,
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "save_shared_session") {
        return {
          shared_session_id: "shared-fork",
          last_modified: 123,
        } as never;
      }
      return null as never;
    });

    const forkedTabId = await useAgentChatStore
      .getState()
      .forkSessionAtMessage(1);

    expect(forkedTabId).not.toBeNull();
    const forked = useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === forkedTabId);
    expect(forked).toMatchObject({
      title: "Original chat (fork)",
      provider: "codex",
      sessionId: null,
      providerSessionIds: {},
      providerSyncCursors: {},
      messages: messages.slice(0, 2),
    });
    expect(useAgentChatStore.getState().tabs[0].messages).toHaveLength(4);
    expect(forked?.messages).not.toBe(messages);
    expect(forked?.messages[1]).not.toBe(messages[1]);

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("save_shared_session", {
        projectPath: "/tmp/fork-test",
        sharedSessionId: null,
        title: "Original chat (fork)",
        lastProvider: "codex",
        lastClaudeModel: initial.selectedClaudeModel,
        lastCodexModel: initial.selectedCodexModel,
        lastPiModel: initial.selectedPiModel,
        pendingQuestion: null,
        providerSessionIds: {},
        providerSyncCursors: {},
        messages: messages.slice(0, 2),
      });
    });
    await vi.waitFor(() => {
      expect(
        useAgentChatStore.getState().tabs.find((tab) => tab.id === forkedTabId)
          ?.sharedSessionId,
      ).toBe("shared-fork");
    });
  });

  it("rejects a fork point that is not an assistant response", async () => {
    const state = useAgentChatStore.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(active).toBeDefined();
    if (!active) return;
    useAgentChatStore.setState({
      tabs: [
        {
          ...active,
          messages: [
            {
              type: "user",
              message: { content: [{ type: "text", text: "Question" }] },
            },
          ],
        },
      ],
      activeTabId: active.id,
      messages: [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Question" }] },
        },
      ],
    });

    expect(
      await useAgentChatStore.getState().forkSessionAtMessage(0),
    ).toBeNull();
    expect(useAgentChatStore.getState().tabs).toHaveLength(1);
  });
});

it("forks a paged chat in the backend and loads only its latest page", async () => {
  useAgentChatStore.getState().restoreProjectTabs("/paged");
  useDocumentStore.setState({ projectRoot: "/paged" });
  const base = useAgentChatStore.getState().tabs[0];
  const messages: AgentStreamMessage[] = Array.from(
    { length: 1000 },
    (_, index) => ({
      type: "assistant",
      uuid: `saved-${index}`,
      message: { content: [{ type: "text", text: `Answer ${index}` }] },
    }),
  );
  useAgentChatStore.setState({
    tabs: [
      {
        ...base,
        title: "Saved",
        history: { start: 800, total: 1000 },
        messages: messages.slice(800),
      },
    ],
    messages: messages.slice(800),
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "desktop:chat:fork")
      return {
        ...(args?.tab as object),
        sharedSessionId: "fork",
        messages: [],
        history: { start: 851, total: 851 },
      };
    if (command === "desktop:chat:messages")
      return messages.slice(
        Number(args?.start),
        Number(args?.start) + Number(args?.limit),
      );
    return undefined;
  });
  const id = await useAgentChatStore.getState().forkSessionAtMessage(850);
  const fork = useAgentChatStore.getState().tabs.find((tab) => tab.id === id)!;
  expect(fork.messages).toHaveLength(200);
  expect(fork.history).toEqual({ start: 651, total: 851 });
  expect(fork.messages[0].uuid).toBe("saved-651");
  expect(fork.messages[199].uuid).toBe("saved-850");
  expect(fork.providerSessionIds).toEqual({});
});

it.each([
  "clearMessages",
  "newSession",
] as const)("%s does not reload a discarded saved transcript", (action) => {
  const initial = useAgentChatStore.getState();
  try {
    const tab = {
      ...initial.tabs[0],
      agentWorkspace: null,
      messages: [],
      history: { total: 1000, start: 1000 },
    };
    useAgentChatStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      messages: [],
    });
    useAgentChatStore.getState()[action]();
    expect(useAgentChatStore.getState().tabs[0].history).toBeUndefined();
    expect(useAgentChatStore.getState().messages).toEqual([]);
  } finally {
    useAgentChatStore.setState(initial);
  }
});

describe("latest exchange details", () => {
  it("retains request effort with a reported model and never borrows it for a later unknown turn", () => {
    const tab = {
      ...useAgentChatStore.getState().tabs[0],
      history: undefined,
      messages: [
        {
          type: "user",
          provider: "claude",
          model: "sonnet",
          reasoningEffort: "high",
        },
        {
          type: "assistant",
          provider: "claude",
          message: { model: "claude-sonnet-4-6" },
        },
      ] as AgentStreamMessage[],
    };
    expect(lastCommunicationDetails(tab)).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      effort: "high",
    });
    tab.messages.push({ type: "user", provider: "claude" });
    expect(lastCommunicationDetails(tab)).toEqual({
      provider: "claude",
      model: undefined,
      effort: undefined,
    });
  });
});
