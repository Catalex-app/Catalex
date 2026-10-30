import { Hint } from "@/components/ui/tooltip";
import { ButtonGroup } from "@/components/ui/button-group";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  ChevronDown,
  ChevronUp,
  MessageSquareTextIcon,
  XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineEditorComment } from "./inline-comments";
import type { EditorCommentFilter } from "@/stores/settings-store";
import { getActiveComment, subscribeActiveComment } from "./active-comment";

export type CommentFilter = EditorCommentFilter;

function AuthorBadge({ agent }: { agent: boolean }) {
  return (
    <MessageSquareTextIcon
      className={cn(
        "size-3.5 shrink-0",
        agent ? "text-[#7352b3]" : "text-[#d49a00]",
      )}
      aria-hidden="true"
    />
  );
}

export function CommentAuthorFilter({
  comments,
  filter,
  onFilter,
}: {
  comments: InlineEditorComment[];
  filter: CommentFilter;
  onFilter: (filter: CommentFilter) => void;
}) {
  return (
    <ButtonGroup
      role="group"
      aria-label="Comment author"
      className="flex h-8 shrink-0 items-center text-xs"
    >
      {(["all", "human", "agent"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-label={`${value === "all" ? "All" : value === "human" ? "Human" : "Agent"} comments`}
          aria-pressed={filter === value}
          onClick={() => onFilter(value)}
          className={cn(
            "flex h-6 items-center justify-center gap-1 rounded-md px-2 font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            filter === value
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
          )}
        >
          {value === "all" ? (
            <span>All</span>
          ) : (
            <AuthorBadge agent={value === "agent"} />
          )}
          <span>
            {
              comments.filter(
                (comment) =>
                  value === "all" || (value === "agent") === !!comment.origin,
              ).length
            }
          </span>
        </button>
      ))}
    </ButtonGroup>
  );
}

export function CommentsSummaryButton({
  comments,
  onOpen,
}: {
  comments: InlineEditorComment[];
  onOpen: () => void;
}) {
  const humans = comments.filter((comment) => !comment.origin).length;
  const agents = comments.length - humans;
  return (
    <Hint content="Show comments">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Show comments: ${humans} human, ${agents} agent`}
        className="flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-muted-foreground text-xs tabular-nums transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1">
          <AuthorBadge agent={false} />
          {humans}
        </span>
        <span className="flex items-center gap-1">
          <AuthorBadge agent />
          {agents}
        </span>
      </button>
    </Hint>
  );
}

export function CommentsPanel({
  navigationSelection,
  comments,
  filter,
  onFilter,
  onClose,
  onNavigate,
}: {
  comments: InlineEditorComment[];
  filter: CommentFilter;
  onFilter: (filter: CommentFilter) => void;
  onClose: () => void;
  onNavigate: (comment: InlineEditorComment) => void;
  navigationSelection?: { id: string };
}) {
  useEffect(() => {
    if (navigationSelection) setSelectedId(navigationSelection.id);
  }, [navigationSelection]);
  const [selectedId, setSelectedId] = useState(getActiveComment);
  const activeId = useSyncExternalStore(
    subscribeActiveComment,
    getActiveComment,
  );
  const visible = comments
    .filter(
      (comment) =>
        filter === "all" || (filter === "agent") === !!comment.origin,
    )
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const focusedId = visible.some((comment) => comment.id === activeId)
    ? activeId
    : null;
  useEffect(() => {
    if (focusedId) setSelectedId(focusedId);
  }, [focusedId]);
  const index = Math.max(
    0,
    visible.findIndex((comment) => comment.id === selectedId),
  );
  const current = visible[index];
  const navigate = (direction: number) => {
    if (!visible.length) return;
    const comment =
      visible[(index + direction + visible.length) % visible.length];
    setSelectedId(comment.id);
    onNavigate(comment);
  };
  return (
    <div
      data-comments-panel="true"
      className="@container/comments flex h-12 shrink-0 items-center gap-2 border-border border-b bg-background px-3 text-xs"
    >
      <span className="shrink-0 font-medium text-foreground">Comments</span>
      <CommentAuthorFilter
        comments={comments}
        filter={filter}
        onFilter={(value) => {
          onFilter(value);
          setSelectedId(null);
        }}
      />
      {current ? (
        <Hint content={current.text || "Unsaved comment"}>
          <button
            type="button"
            onClick={() => onNavigate(current)}
            aria-label={`Go to comment ${current.origin ? "A" : "H"}-${current.number ?? current.expectedNumber ?? 1}`}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 font-semibold text-[10px] text-white",
                current.origin ? "bg-[#7352b3]" : "bg-[#d49a00]",
              )}
            >
              {current.origin ? "A" : "H"}-
              {current.number ?? current.expectedNumber ?? 1}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {current.text || "Unsaved comment"}
            </span>
          </button>
        </Hint>
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          role="status"
        >
          No comments
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <span
          className="font-mono text-muted-foreground"
          role="status"
          aria-label={`Comment ${current ? index + 1 : 0} of ${visible.length}`}
        >
          {current ? index + 1 : 0}/{visible.length}
        </span>
        {([-1, 1] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            onClick={() => navigate(direction)}
            disabled={!current}
            aria-label={direction < 0 ? "Previous comment" : "Next comment"}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
          >
            {direction < 0 ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        ))}
        <Hint content="Hide comments">
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide comments"
            className="ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" />
          </button>
        </Hint>
      </div>
    </div>
  );
}
