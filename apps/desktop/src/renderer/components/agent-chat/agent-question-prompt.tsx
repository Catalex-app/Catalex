import { usePausedReviewStore } from "@/stores/paused-review-store";
import {
  getUnansweredQuestion,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useAgentQuestionStore } from "@/stores/agent-question-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { AskUserQuestionWidget } from "./tool-widgets";
import { useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function ProjectChangedDialog() {
  const root = useDocumentStore((state) => state.projectRoot);
  const notice = useAgentReviewQueueStore((state) =>
    state.entries.find(
      (entry) =>
        entry.session.projectRoot === root && entry.projectChangePending,
    ),
  );
  const [busy, setBusy] = useState(false);
  const acknowledge = async () => {
    if (!notice || busy) return;
    setBusy(true);
    try {
      await useAgentReviewQueueStore
        .getState()
        .acknowledgeProjectChange(notice.session.sessionId);
    } catch (error) {
      toast.error(`Could not return to the project: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(notice)}>
      <DialogContent
        showCloseButton={false}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogIconHeader showCloseButton={false}>
          <TriangleAlertIcon aria-hidden="true" />
        </DialogIconHeader>
        <DialogHeader className="text-left">
          <DialogTitle>Project changed externally</DialogTitle>
          <DialogDescription>
            Review has stopped because the project changed outside this review.
            Your remaining draft is saved.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button disabled={busy} onClick={() => void acknowledge()}>
            {busy ? "Closing…" : "Got it"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function useActiveAgentQuestion() {
  const tab = useAgentChatStore((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId),
  );
  const root = useDocumentStore((s) => s.projectRoot);
  const questions = useAgentQuestionStore((s) => s.questions);
  const live =
    tab?.isStreaming && !tab.cancelledByUser
      ? questions.find(
          (q) =>
            q.tabId === tab?.id &&
            q.sessionId === tab.runtimeSessionKey &&
            q.projectRoot === root,
        )
      : undefined;
  const saved = tab && !tab.isStreaming ? getUnansweredQuestion(tab) : null;
  const draft = useAgentReviewQueueStore((s) =>
    s.entries.find(
      (entry) =>
        entry.session.tabId === tab?.id &&
        entry.session.projectRoot === root &&
        entry.phase === "question",
    ),
  );
  const draftQuestion = draft
    ? {
        requestId: `draft-${draft.session.sessionId}-${draft.preview?.sourceRevision ?? "retry"}`,
        projectRoot: draft.session.projectRoot,
        question: draft.error
          ? `The draft could not be checked: ${draft.error}`
          : `The project changed while this agent was working. How should this draft proceed?\n${draft.conflicts.map((conflict) => `${conflict.filePath}: ${conflict.reason}`).join("\n")}`,
        options: draft.error
          ? [
              {
                label: "Check again",
                description: "Compare the draft with the current project.",
              },
              {
                label: "Discard draft",
                description: "Keep the project unchanged.",
              },
            ]
          : [
              {
                label: "Update draft",
                description:
                  "Let the agent revise its proposal against the latest project.",
              },
              {
                label: "Keep safe changes only",
                description:
                  "Review compatible changes and drop conflicting edits.",
              },
              {
                label: "Discard draft",
                description: "Keep the project unchanged.",
              },
            ],
      }
    : null;
  const paused = usePausedReviewStore((s) =>
    tab ? s.pending[tab.id] : undefined,
  );
  const resume =
    paused &&
    paused.session.projectRoot === root &&
    paused.session.sessionId === tab?.agentWorkspace?.sessionId &&
    !tab?.isStreaming
      ? paused
      : null;
  const resumeQuestion = resume
    ? {
        requestId: `resume-${resume.session.sessionId}-${resume.inspection.revision}`,
        projectRoot: resume.session.projectRoot,
        question:
          "The document changed while this agent was paused. How should it continue? Your saved agent draft will be preserved until you choose.",
        options: resume.inspection.changes.length
          ? [
              {
                label: "Update the draft",
                description:
                  "Recommended. Reconsider unfinished edits using the current document. Keep the saved draft as a backup.",
              },
              {
                label: "Review the saved draft first",
                description:
                  "Review existing edits against the current document; flag conflicts.",
              },
              {
                label: "Stay paused",
                description: "Leave everything unchanged.",
              },
            ]
          : [
              {
                label: "Continue from the current document",
                description:
                  "Start with the latest text; there are no unfinished edits.",
              },
              {
                label: "Stay paused",
                description: "Leave everything unchanged.",
              },
            ],
      }
    : null;
  const question =
    resumeQuestion ??
    draftQuestion ??
    live ??
    (saved?.projectRoot === root ? saved : null);
  return { tab, live, question, draft, resume };
}

export function AgentQuestionPrompt() {
  const { tab, live, question, draft, resume } = useActiveAgentQuestion();
  const answer = useAgentQuestionStore((s) => s.answer);
  const answerRestored = useAgentChatStore((s) => s._answerRestoredQuestion);
  if (!question || !tab) return null;
  return (
    <section
      aria-label="Agent question"
      className={
        resume
          ? "flex min-h-0 shrink-0 flex-col [&>[data-testid=agent-question-widget]]:min-h-[min(16rem,40dvh)]"
          : "flex min-h-0 flex-col"
      }
    >
      <AskUserQuestionWidget
        key={question.requestId}
        input={{ questions: [question] }}
        allowSkip={!draft && !resume}
        onAnswer={(value) =>
          resume
            ? usePausedReviewStore.getState().answer(tab.id, value)
            : draft
              ? useAgentReviewQueueStore
                  .getState()
                  .answer(draft.session.sessionId, value)
              : live
                ? answer(question.requestId, value)
                : answerRestored(tab.id, question.requestId, value)
        }
      />
    </section>
  );
}

export function useInterruptedReviewHold() {
  const tab = useAgentChatStore((s) =>
    s.tabs.find((item) => item.id === s.activeTabId),
  );
  const root = useDocumentStore((s) => s.projectRoot);
  return useAgentReviewQueueStore((s) => {
    const entries = s.entries.filter(
      (item) => item.session.projectRoot === root,
    );
    return (
      tab?.pauseState === "paused" &&
      !tab.isStreaming &&
      entries[0]?.session.tabId === tab.id &&
      entries[0]?.phase === "revising" &&
      entries.slice(1).some((item) => item.phase === "queued")
    );
  });
}

export function AgentDraftStatus() {
  const holdsReview = useInterruptedReviewHold();
  const tabId = useAgentChatStore((s) => s.activeTabId);
  const root = useDocumentStore((s) => s.projectRoot);
  const entry = useAgentReviewQueueStore((s) =>
    s.entries.find(
      (item) =>
        item.session.tabId === tabId && item.session.projectRoot === root,
    ),
  );
  const head = useAgentReviewQueueStore((s) =>
    s.entries.find((item) => item.session.projectRoot === root),
  );
  const queuePosition = useAgentReviewQueueStore((s) =>
    s.entries
      .filter((item) => item.session.projectRoot === root)
      .findIndex((item) => item.session.tabId === tabId),
  );
  const headTitle = useAgentChatStore(
    (s) => s.tabs.find((tab) => tab.id === head?.session.tabId)?.title,
  );
  if (!entry) return null;
  if (holdsReview)
    return (
      <span role="status" className="text-muted-foreground">
        Draft kept · Other reviews are waiting
      </span>
    );
  if (entry.phase === "queued" && head && queuePosition > 0) {
    return (
      <span className="font-semibold text-violet-700 dark:text-violet-300">
        Waiting for review of{" "}
        <button
          type="button"
          onClick={() =>
            useAgentChatStore.getState().setActiveTab(head.session.tabId)
          }
          className="underline decoration-violet-400/60 underline-offset-2 transition-colors hover:text-violet-600 dark:hover:text-violet-200"
        >
          {headTitle || "another chat"}
        </button>
      </span>
    );
  }
  const messages = {
    queued: "Waiting for review",
    checking: "Checking…",
    review: "Review in editor",
    revising: "Revising draft…",
    applying: "Applying…",
    question: "Needs your answer",
  };
  return (
    <span
      role="status"
      className={
        entry.phase === "checking" || entry.phase === "applying"
          ? "text-blue-700/80 dark:text-blue-400/80"
          : entry.phase === "review"
            ? "font-semibold text-amber-700 dark:text-amber-400"
            : "text-amber-700 dark:text-amber-400"
      }
    >
      {messages[entry.phase]}
    </span>
  );
}

export function AgentDraftNotice({ compact = false }: { compact?: boolean }) {
  const tabId = useAgentChatStore((s) => s.activeTabId);
  const root = useDocumentStore((s) => s.projectRoot);
  const review = useProposedChangesStore((s) => s.workspaceReview);
  const changes = useProposedChangesStore((s) => s.changes);
  const entry = useAgentReviewQueueStore((s) =>
    s.entries.find(
      (item) =>
        item.session.tabId === tabId && item.session.projectRoot === root,
    ),
  );
  const ownChanges =
    review?.session.tabId === tabId &&
    review.session.projectRoot === root &&
    (!entry || entry.phase === "review")
      ? changes.filter(
          (change) => change.workspaceSessionId === review.session.sessionId,
        )
      : [];
  if (!entry && !ownChanges.length) return null;
  const openReview = () => {
    const doc = useDocumentStore.getState();
    const first = ownChanges.find((change) =>
      doc.files.some((file) => file.relativePath === change.filePath),
    );
    if (first) doc.setActiveFile(first.filePath);
  };
  return (
    <div
      data-agent-draft-notice
      className={
        compact
          ? "min-w-0 truncate text-xs"
          : "flex shrink-0 flex-wrap items-center gap-x-2 px-5 py-1.5 text-xs"
      }
    >
      {ownChanges.length > 0 ? (
        <button
          type="button"
          data-agent-workspace-review-link="true"
          onClick={openReview}
          className="truncate font-semibold text-amber-600 underline decoration-amber-500/60 underline-offset-2 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
        >
          Review draft ({ownChanges.length} change
          {ownChanges.length === 1 ? "" : "s"})
        </button>
      ) : (
        <AgentDraftStatus />
      )}
    </div>
  );
}
