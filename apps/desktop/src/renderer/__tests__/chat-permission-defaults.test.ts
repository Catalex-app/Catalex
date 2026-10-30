import { beforeEach, expect, it } from "vitest";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";

beforeEach(() => {
  useSettingsStore.setState({
    workspacePreferencesByProject: {},
    defaultAgentExecutionMode: "default",
  });
  useDocumentStore.setState({
    projectRoot: null,
    files: [],
    agentWorkspaceRoot: null,
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useAgentChatStore.setState({
    tabs: [],
    selectedClaudeExecutionMode: "default",
    selectedCodexExecutionMode: "default",
  });
  useAgentChatStore.getState().createTab();
});

it.each([
  "claude",
  "codex",
] as const)("keeps %s chat permissions through default changes and initializes new chats from defaults", (provider) => {
  const store = useAgentChatStore.getState;
  const field =
    provider === "claude"
      ? "selectedClaudeExecutionMode"
      : "selectedCodexExecutionMode";
  const first = store().activeTabId;
  store().saveDraft(first, { input: "First draft", pinnedContexts: [] });
  expect(store()[field]).toBe("default");
  useSettingsStore.setState({ defaultAgentExecutionMode: "edit" });
  store().applyAgentDefaults();
  expect(store()[field]).toBe("default");
  const second = store().createTab();
  store().saveDraft(second, { input: "Second draft", pinnedContexts: [] });
  expect(store()[field]).toBe("edit");
  useSettingsStore.setState({ defaultAgentExecutionMode: "default" });
  store().applyAgentDefaults();
  expect(store()[field]).toBe("edit");
  store().setActiveTab(first);
  expect(store()[field]).toBe("default");
  store().setActiveTab(second);
  expect(store()[field]).toBe("edit");
  store().closeTab(second);
  expect(store()[field]).toBe("default");
  store().createTab();
  expect(store()[field]).toBe("default");
});

it("preserves explicit choices and uses changed defaults only for new sessions", () => {
  const store = useAgentChatStore.getState;
  store().setSelectedClaudeExecutionMode("edit");
  store().setSelectedCodexExecutionMode("edit");
  useSettingsStore.setState({ defaultAgentExecutionMode: "default" });
  store().applyAgentDefaults();
  expect(store().selectedCodexExecutionMode).toBe("edit");
  useSettingsStore.setState({ defaultAgentExecutionMode: "default" });
  store().applyAgentDefaults();
  expect(store().selectedClaudeExecutionMode).toBe("edit");
  store().newSession();
  expect(store().selectedClaudeExecutionMode).toBe("default");
  expect(store().selectedCodexExecutionMode).toBe("default");
});

it("uses changed defaults for new chats during an active run", () => {
  const store = useAgentChatStore.getState;
  useAgentChatStore.setState((state) => ({
    tabs: state.tabs.map((tab) => ({ ...tab, isStreaming: true })),
  }));
  useSettingsStore.setState({ defaultAgentExecutionMode: "edit" });
  store().applyAgentDefaults();
  expect(store().selectedCodexExecutionMode).toBe("default");
  store().createTab();
  expect(store().selectedCodexExecutionMode).toBe("edit");
});

it("uses one default across project layouts and preserves saved permissions", () => {
  const store = useAgentChatStore.getState;
  const settings = useSettingsStore.getState();
  settings.setWorkspacePreferences("/project", {
    mode: "duet",
    chatLayout: "workspace",
  });
  useSettingsStore.setState({ defaultAgentExecutionMode: "edit" });
  store().restoreProjectTabs("/project");
  expect(store().selectedClaudeExecutionMode).toBe("edit");
  expect(store().selectedCodexExecutionMode).toBe("edit");
  const savedTabs = store().tabs;
  settings.setWorkspacePreferences("/project", {
    mode: "duet",
    chatLayout: "drawer",
  });
  useSettingsStore.setState({ defaultAgentExecutionMode: "default" });
  store().restoreProjectTabs("/project", savedTabs);
  expect(store().selectedCodexExecutionMode).toBe("edit");
  store().restoreProjectTabs("/other-project");
  expect(store().selectedCodexExecutionMode).toBe("default");
});
