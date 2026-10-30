import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentQuestion } from "@/stores/agent-question-store";
import type { ReviewQueueEntry } from "@/stores/agent-review-queue-store";
import { type TabState, useAgentChatStore } from "@/stores/agent-chat-store";
import { SessionStatusIndicator, useSessionStatus } from "./session-status";

const state = vi.hoisted(() => ({
  questions: [] as AgentQuestion[],
  entries: [] as ReviewQueueEntry[],
  projectRoot: "/project" as string | null,
}));

vi.mock("@/stores/agent-question-store", () => ({
  useAgentQuestionStore: (select: (value: typeof state) => unknown) =>
    select(state),
}));
vi.mock("@/stores/agent-review-queue-store", () => ({
  useAgentReviewQueueStore: (select: (value: typeof state) => unknown) =>
    select(state),
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: (select: (value: typeof state) => unknown) => select(state),
}));

const question: AgentQuestion = {
  requestId: "question-1",
  tabId: "tab-1",
  sessionId: "runtime-1",
  projectRoot: "/project",
  question: "Which changes should I keep?",
  options: [{ label: "Update draft" }],
};

function Status({ tab }: { tab: TabState }) {
  return <SessionStatusIndicator status={useSessionStatus()(tab)} />;
}

function render(patch: Partial<TabState> = {}) {
  const tab = {
    ...useAgentChatStore.getState().tabs[0],
    id: "tab-1",
    runtimeSessionKey: "runtime-1",
    isStreaming: false,
    messages: [],
    ...patch,
  };
  return renderToStaticMarkup(<Status tab={tab} />);
}

function enqueue(phase: ReviewQueueEntry["phase"], projectRoot = "/project") {
  state.entries = [
    {
      session: {
        version: 2,
        sessionId: "workspace-1",
        tabId: "tab-1",
        projectRoot,
        mode: "edit",
        status: "review",
        createdAt: 0,
        updatedAt: 0,
        sourceCommit: "fixture-source",
        baselineCommit: "fixture-baseline",
        candidateRoot: "/candidate",
        warnings: [],
      },
      phase,
      conflicts: [],
    },
  ];
}

beforeEach(() => {
  state.questions = [];
  state.entries = [];
  state.projectRoot = "/project";
});

describe("session status", () => {
  it("animates working agents and leaves idle sessions unmarked", () => {
    expect(render()).toBe("");
    expect(render({ isStreaming: true })).toContain(
      'aria-label="Agent working"',
    );
    expect(render({ isStreaming: true })).toContain("animate-ping");
  });

  it("prioritizes a live question over streaming with an accessible amber indicator", () => {
    state.questions = [question];
    const html = render({ isStreaming: true });
    expect(html).toContain('aria-label="Awaiting your answer"');
    expect(html).not.toContain('title="Awaiting your answer"');
    expect(html).toContain("text-amber-500");
    expect(html).not.toContain("animate-ping");
  });

  it("ignores live questions for an old runtime or a different project", () => {
    state.questions = [{ ...question, sessionId: "old-runtime" }];
    expect(render({ isStreaming: true })).toContain(
      'aria-label="Agent working"',
    );
    state.questions = [{ ...question, projectRoot: "/other" }];
    expect(render({ isStreaming: true })).toContain(
      'aria-label="Agent working"',
    );
  });

  it("restores an unanswered saved question but ignores answered or foreign questions", () => {
    expect(render({ pendingQuestion: question })).toContain(
      'aria-label="Awaiting your answer"',
    );
    expect(
      render({ pendingQuestion: { ...question, projectRoot: "/other" } }),
    ).toBe("");
    expect(
      render({
        pendingQuestion: question,
        messages: [{ type: "user", uuid: "question-answer-question-1" }],
      }),
    ).toBe("");
  });

  it.each([
    "queued",
    "checking",
  ] as const)("shows a purple queue clock for %s", (phase) => {
    enqueue(phase);
    const html = render();
    expect(html).toContain('aria-label="Waiting for review"');
    expect(html).toContain("text-violet-600");
    expect(html).toContain("lucide-clock");
  });

  it("shows amber review and conflict question states", () => {
    enqueue("review");
    expect(render()).toContain('aria-label="Draft ready for review"');
    expect(render()).toContain("text-amber-500");
    enqueue("question");
    expect(render({ isStreaming: true })).toContain(
      'aria-label="Awaiting your answer"',
    );
  });

  it("shows pause state and gives an unanswered question priority", () => {
    expect(render({ pauseState: "paused" })).toContain(
      'aria-label="Agent paused"',
    );
    expect(
      render({ pauseState: "paused", pendingQuestion: question }),
    ).toContain('aria-label="Awaiting your answer"');
  });

  it("ignores review entries belonging to another project", () => {
    enqueue("review", "/other");
    expect(render()).toBe("");
  });
});
