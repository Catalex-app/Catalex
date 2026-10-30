import { beforeEach, expect, it, vi } from "vitest";
import {
  useAgentQuestionStore,
  type AgentQuestion,
} from "./agent-question-store";

const mocks = vi.hoisted(() => ({
  chat: {
    _answerQuestion: vi.fn(),
    _rememberQuestion: vi.fn(),
    _setRoundWaiting: vi.fn(),
    tabs: [
      {
        id: "tab",
        runtimeSessionKey: "session",
        isStreaming: true,
        cancelledByUser: false,
      },
    ],
  },
  document: { projectRoot: "/project" },
}));
vi.mock("./agent-chat-store", () => ({
  useAgentChatStore: { getState: () => mocks.chat },
}));
vi.mock("./document-store", () => ({
  useDocumentStore: { getState: () => mocks.document },
}));
const question: AgentQuestion = {
  requestId: "q",
  tabId: "tab",
  sessionId: "session",
  projectRoot: "/project",
  question: "What next?",
  options: [{ label: "Update" }, { label: "Discard unsaved" }],
};
beforeEach(() => {
  useAgentQuestionStore.setState({ questions: [] });
  mocks.chat.tabs = [
    {
      id: "tab",
      runtimeSessionKey: "session",
      isStreaming: true,
      cancelledByUser: false,
    },
  ];
  mocks.document.projectRoot = "/project";
  mocks.chat._answerQuestion.mockReset().mockResolvedValue(undefined);
});
it("accepts only questions for a live project and session, without duplicates", () => {
  const store = useAgentQuestionStore.getState();
  store.receive({ ...question, sessionId: "old" });
  store.receive({ ...question, projectRoot: "/other" });
  store.receive({ ...question, tabId: "missing" });
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
  store.receive(question);
  store.receive(question);
  expect(useAgentQuestionStore.getState().questions).toEqual([question]);
});
it("sends an answer to its original question without creating a chat turn", async () => {
  useAgentQuestionStore.getState().receive(question);
  await useAgentQuestionStore.getState().answer("q", "Discard unsaved");
  expect(mocks.chat._answerQuestion).toHaveBeenCalledExactlyOnceWith(
    question,
    "Discard unsaved",
  );
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
});
it("refuses an answer after the session ended", async () => {
  useAgentQuestionStore.getState().receive(question);
  mocks.chat.tabs[0].isStreaming = false;
  await expect(
    useAgentQuestionStore.getState().answer("q", "Update"),
  ).rejects.toThrow("no longer active");
  expect(mocks.chat._answerQuestion).not.toHaveBeenCalled();
});
it("refuses answers immediately after Stop, before the provider finishes", async () => {
  useAgentQuestionStore.getState().receive(question);
  mocks.chat.tabs[0].cancelledByUser = true;
  await expect(
    useAgentQuestionStore.getState().answer("q", "Update"),
  ).rejects.toThrow("no longer active");
  expect(mocks.chat._answerQuestion).not.toHaveBeenCalled();
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
});
it("retains an answerable question on IPC failure and removes closed questions", async () => {
  useAgentQuestionStore.getState().receive(question);
  mocks.chat._answerQuestion.mockRejectedValueOnce("Connection failed");
  await expect(
    useAgentQuestionStore.getState().answer("q", "Custom answer"),
  ).rejects.toBe("Connection failed");
  expect(useAgentQuestionStore.getState().questions).toEqual([question]);
  useAgentQuestionStore.getState().remove("q");
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
});
it("prunes questions after a tab or project change", () => {
  useAgentQuestionStore.getState().receive(question);
  mocks.document.projectRoot = "/elsewhere";
  useAgentQuestionStore.getState().prune();
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
});

it("keeps permission requests live-only instead of restoring approvals as chat prompts", () => {
  mocks.chat._rememberQuestion.mockClear();
  useAgentQuestionStore.getState().receive({ ...question, permission: true });
  expect(useAgentQuestionStore.getState().questions).toHaveLength(1);
  expect(mocks.chat._rememberQuestion).not.toHaveBeenCalled();
  mocks.chat.tabs[0].isStreaming = false;
  useAgentQuestionStore.getState().prune();
  expect(useAgentQuestionStore.getState().questions).toEqual([]);
});
