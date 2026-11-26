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
  });
  useAgentChatStore.getState().createTab();
});

it("uses the same writing choice after switching providers, chats, and projects", () => {
  const chat = useAgentChatStore.getState;
  const settings = useSettingsStore.getState;
  const first = chat().activeTabId;
  const obsoleteChoices = {
    ...chat().tabs[0],
    pauseState: "paused" as const,
    selectedCodexExecutionMode: "default",
  };
  settings().setDefaultAgentExecutionMode("edit");
  chat().createTab();
  chat().setProvider("claude");
  chat().setActiveTab(first);
  chat().restoreProjectTabs("/project", [obsoleteChoices]);
  expect(settings().defaultAgentExecutionMode).toBe("edit");
  expect(chat().tabs[0].id).toBe(first);
  expect(chat().tabs[0]).not.toHaveProperty("selectedCodexExecutionMode");
});
