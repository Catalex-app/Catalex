import { Hint } from "@/components/ui/tooltip";
import {
  CircleHelpIcon,
  ClipboardCheckIcon,
  ClockIcon,
  PauseIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getUnansweredQuestion,
  type TabState,
} from "@/stores/agent-chat-store";
import { useAgentQuestionStore } from "@/stores/agent-question-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useDocumentStore } from "@/stores/document-store";

export type SessionStatus =
  | "working"
  | "question"
  | "review"
  | "queued"
  | "paused"
  | null;

export function useSessionStatus() {
  const questions = useAgentQuestionStore((s) => s.questions);
  const entries = useAgentReviewQueueStore((s) => s.entries);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  return (tab: TabState | undefined): SessionStatus => {
    if (!tab) return null;
    const saved = !tab.isStreaming ? getUnansweredQuestion(tab) : null;
    const hasQuestion =
      saved?.projectRoot === projectRoot ||
      questions.some(
        (q) =>
          tab.isStreaming &&
          !tab.cancelledByUser &&
          q.tabId === tab.id &&
          q.sessionId === tab.runtimeSessionKey &&
          q.projectRoot === projectRoot,
      );
    const entry = entries.find(
      (item) =>
        item.session.tabId === tab.id &&
        item.session.projectRoot === projectRoot,
    );
    if (hasQuestion || entry?.phase === "question") return "question";
    if (entry?.phase === "review") return "review";
    if (entry?.phase === "queued" || entry?.phase === "checking")
      return "queued";
    if (tab.pauseState === "paused" || tab.pauseState === "pausing")
      return "paused";
    if (
      tab.isStreaming ||
      entry?.phase === "applying" ||
      entry?.phase === "revising"
    )
      return "working";
    return null;
  };
}

export const sessionStatusLabel = {
  working: "Agent working",
  question: "Awaiting your answer",
  review: "Draft ready for review",
  queued: "Waiting for review",
  paused: "Agent paused",
};

export function SessionStatusIndicator({
  status,
  className,
  workingClassName = "text-primary",
}: {
  status: SessionStatus;
  className?: string;
  workingClassName?: string;
}) {
  if (!status) return null;
  const Icon =
    status === "question"
      ? CircleHelpIcon
      : status === "review"
        ? ClipboardCheckIcon
        : status === "paused"
          ? PauseIcon
          : ClockIcon;
  return (
    <Hint content={sessionStatusLabel[status]}>
      <span
        role="img"
        aria-label={sessionStatusLabel[status]}
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center",
          status === "working"
            ? workingClassName
            : status === "question" || status === "review"
              ? "text-amber-500"
              : status === "queued"
                ? "text-violet-600 dark:text-violet-400"
                : "text-muted-foreground",
          className,
        )}
      >
        {status === "working" ? (
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-current" />
          </span>
        ) : (
          <Icon className="size-3.5" aria-hidden="true" />
        )}
      </span>
    </Hint>
  );
}
