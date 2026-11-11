import { DocumentBarNavigation } from "../document-bar-navigation";
import { Hint } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { useEffect, useState, useSyncExternalStore } from "react";
import { MessageSquareTextIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InlineEditorComment } from "./inline-comments";
import type { EditorCommentFilter } from "@/stores/settings-store";
import { getActiveComment, subscribeActiveComment } from "./active-comment";
import {
  documentBarButtonClassName,
  documentBarClassName,
  documentBarSummaryButtonClassName,
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
        className={documentBarSummaryButtonClassName}
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
      className={`@container/comments ${documentBarClassName}`}
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
        <DocumentBarNavigation
          label="Comment navigation"
          previousLabel="Previous comment"
          nextLabel="Next comment"
          itemLabel="Comment"
          current={current ? index + 1 : 0}
          total={visible.length}
          onPrevious={() => navigate(-1)}
          onNext={() => navigate(1)}
        />
        <Hint content="Hide comments">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onClose}
            aria-label="Hide comments"
            className={documentBarButtonClassName}
          >
            <XIcon className="size-3.5" />
          </Button>
        </Hint>
      </div>
    </div>
  );
}
