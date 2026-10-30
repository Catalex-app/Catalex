import { create } from "zustand";
import { useAgentChatStore } from "./agent-chat-store";
import { useDocumentStore } from "./document-store";

export interface AgentQuestion {
  requestId: string;
  tabId: string;
  sessionId: string;
  projectRoot: string;
  question: string;
  details?: string;
  permission?: boolean;
  options: { label: string; description?: string }[];
}

export type SavedAgentQuestion = Pick<
  AgentQuestion,
  "requestId" | "projectRoot" | "question" | "options" | "details"
>;

function isActive(question: AgentQuestion): boolean {
  const tab = useAgentChatStore
    .getState()
    .tabs.find((tab) => tab.id === question.tabId);
  return (
    tab?.isStreaming === true &&
    !tab.cancelledByUser &&
    tab.runtimeSessionKey === question.sessionId &&
    useDocumentStore.getState().projectRoot === question.projectRoot
  );
}

export const useAgentQuestionStore = create<{
  questions: AgentQuestion[];
  receive: (question: AgentQuestion) => void;
  remove: (requestId: string) => void;
  prune: () => void;
  answer: (requestId: string, answer: string) => Promise<void>;
}>((set, get) => ({
  questions: [],
  receive: (question) => {
    if (!isActive(question)) return;
    useAgentChatStore
      .getState()
      ._setRoundWaiting(question.tabId, question.requestId, true);
    // Runtime permission requests expire with the turn; never restore them as chat prompts.
    if (!question.permission)
      useAgentChatStore.getState()._rememberQuestion(question);
    set((state) => ({
      questions: [
        ...state.questions.filter((q) => q.requestId !== question.requestId),
        question,
      ],
    }));
  },
  remove: (requestId) => {
    const question = get().questions.find((q) => q.requestId === requestId);
    if (question)
      useAgentChatStore
        .getState()
        ._setRoundWaiting(question.tabId, requestId, false);
    set((state) => ({
      questions: state.questions.filter((q) => q.requestId !== requestId),
    }));
  },
  prune: () => {
    const questions = get().questions.filter(isActive);
    if (questions.length !== get().questions.length) set({ questions });
  },
  answer: async (requestId, answer) => {
    const question = get().questions.find((q) => q.requestId === requestId);
    if (!question || !isActive(question)) {
      get().remove(requestId);
      throw new Error("This question is no longer active.");
    }
    await useAgentChatStore.getState()._answerQuestion(question, answer);
    get().remove(requestId);
  },
}));
