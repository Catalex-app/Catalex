import { beforeEach, describe, expect, it } from "vitest";
import { useAgentChatStore, type TabState } from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";

beforeEach(() => {
  useDocumentStore.setState({
    selectionRange: null,
    pdfSelectionContext: null,
  });
  useAgentChatStore.setState({
    tabs: [],
    activeTabId: "",
    pendingAttachments: [],
  });
  useAgentChatStore.getState().createTab();
});

describe("requestNewChat", () => {
  it("reuses only the active untouched chat and requests input focus each time", () => {
    const initial = useAgentChatStore.getState();
    expect(initial.requestNewChat()).toBe(initial.activeTabId);
    expect(initial.requestNewChat()).toBe(initial.activeTabId);
    const state = useAgentChatStore.getState();
    expect(state.tabs).toHaveLength(1);
    expect(state.composerFocusRequestNonce).toBe(
      initial.composerFocusRequestNonce + 2,
    );
  });

  it.each([
    "",
    "unsent draft",
    " ",
  ])("reuses an unsent draft with input %j from another chat", (input) => {
    const draft = useAgentChatStore.getState().tabs[0];
    useAgentChatStore
      .getState()
      .saveDraft(draft.id, { input, pinnedContexts: [] });
    const history = { ...draft, id: "history", sharedSessionId: "saved" };
    useAgentChatStore.setState((state) => ({ tabs: [...state.tabs, history] }));
    useAgentChatStore.getState().setActiveTab(history.id);
    expect(
      useAgentChatStore.getState().tabs.some((tab) => tab.id === draft.id),
    ).toBe(input.length > 0);
    const id = useAgentChatStore.getState().requestNewChat();
    if (input) expect(id).toBe(draft.id);
    expect(useAgentChatStore.getState().tabs).toHaveLength(2);
    expect(
      useAgentChatStore.getState().tabs.find((tab) => tab.id === id)?.draft
        .input,
    ).toBe(input);
  });

  const cases: [string, Partial<TabState>][] = [
    [
      "messages",
      {
        messages: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "hello" }] },
          },
        ],
      },
    ],
    ["saved session", { sharedSessionId: "saved" }],
    ["provider session", { sessionId: "provider-session" }],
    ["streaming", { isStreaming: true }],
    ["preparing", { turnPhase: "preparing" }],
    ["paused", { pauseState: "paused" }],
    ["settling", { isSettling: true }],
    ["error", { error: "Failed to start" }],
  ];
  it.each(
    cases,
  )("preserves a chat with %s and creates a new one", (_, update) => {
    const initial = useAgentChatStore.getState().tabs[0];
    const source = { ...initial, ...update };
    useAgentChatStore.setState({ tabs: [source] });
    const id = useAgentChatStore.getState().requestNewChat();
    const state = useAgentChatStore.getState();
    expect(id).not.toBe(source.id);
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[0]).toEqual(source);
    expect(state.activeTabId).toBe(id);
  });

  it("keeps queued attachments with the original chat", () => {
    const state = useAgentChatStore.getState();
    const attachment = {
      label: "figure",
      filePath: "figure.png",
      selectedText: "",
    };
    state.addPendingAttachment(attachment);
    const id = state.requestNewChat();
    expect(id).toBe(state.activeTabId);
    expect(useAgentChatStore.getState().pendingAttachments).toEqual([
      attachment,
    ]);
  });

  it("still allocates distinct tabs for saved-session loading", () => {
    const first = useAgentChatStore.getState().activeTabId;
    expect(useAgentChatStore.getState().createTab()).not.toBe(first);
    expect(useAgentChatStore.getState().tabs).toHaveLength(2);
  });
});
