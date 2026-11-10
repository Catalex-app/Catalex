import { Hint } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
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
import {
  documentCounterClassName,
  documentStepButtonClassName,
} from "../document-navigation-styles";

export type CommentFilter = EditorCommentFilter;

function AuthorBadge({ filter }: { filter: CommentFilter }) {
  return (
    <MessageSquareTextIcon
      className={cn(
        "size-3.5 shrink-0",
        filter === "all"
          ? "text-muted-foreground"
          : filter === "agent"
            ? "text-[#7352b3]"
            : "text-[#d49a00]",
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
  const humans = comments.filter((comment) => !comment.origin).length;
  return (
    <ButtonGroup
      aria-label="Comment author"
      selection={{
        layout: "responsive",
        compactLabel: "Filter comments",
        value: filter,
        onValueChange: onFilter,
        options: [
          {
            value: "all",
            label: "All comments",
            shortLabel: "All",
            icon: <AuthorBadge filter="all" />,
            count: comments.length,
          },
          {
            value: "human",
            label: "Human comments",
            icon: <AuthorBadge filter="human" />,
            count: humans,
          },
          {
            value: "agent",
            label: "Agent comments",
            icon: <AuthorBadge filter="agent" />,
            count: comments.length - humans,
          },
        ],
      }}
    />
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
          <AuthorBadge filter="human" />
          {humans}
        </span>
        <span className="flex items-center gap-1">
          <AuthorBadge filter="agent" />
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
    .sort((a, b) => {
      const first = a.pdf?.regions[0],
        second = b.pdf?.regions[0];
      return first && second
        ? first.page - second.page || first.y - second.y || first.x - second.x
        : a.from - b.from || a.to - b.to;
    });
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
      className="@container/comments flex h-12 shrink-0 items-center gap-1 border-border border-b bg-background px-2 text-xs"
    >
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
            className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded-md @[320px]/comments:px-2 px-1 py-1 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
        <div
          role="group"
          aria-label="Comment navigation"
          className="flex shrink-0 items-center"
        >
          <Hint content="Previous comment">
            <Button
              variant="ghost"
              size="icon"
              className={documentStepButtonClassName}
              onClick={() => navigate(-1)}
              disabled={!current}
              aria-label="Previous comment"
            >
              <ChevronUp className="size-3.5" />
            </Button>
          </Hint>
          <span
            className={`${documentCounterClassName} text-muted-foreground`}
            role="status"
            aria-label={`Comment ${current ? index + 1 : 0} of ${visible.length}`}
          >
            <span>{current ? index + 1 : 0}</span>
            <span>/</span>
            <span>{visible.length}</span>
          </span>
          <Hint content="Next comment">
            <Button
              variant="ghost"
              size="icon"
              className={documentStepButtonClassName}
              onClick={() => navigate(1)}
              disabled={!current}
              aria-label="Next comment"
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </Hint>
        </div>
        <Hint content="Hide comments">
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide comments"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" />
          </button>
        </Hint>
      </div>
    </div>
  );
}
