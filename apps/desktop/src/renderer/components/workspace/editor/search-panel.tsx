import { canCloseSearchOnEscape } from "@/lib/search-escape";
import {
  useSearchComments,
  useCommentSearchHighlight,
} from "./search-comments";
import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import {
  XIcon,
  ChevronUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  RegexIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type HistoryField = "find" | "replace";
type HistoryDirection = "up" | "down";

interface SearchPanelProps {
  preview?: boolean;
  pdf?: boolean;
  commentRange?: { from: number; to: number } | null;
  statusText?: string;
  findText: string;
  replaceText: string;
  isReplaceOpen: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
  isRegex: boolean;
  preserveCase: boolean;
  findInSelection: boolean;
  canEnableFindInSelection: boolean;
  isQueryValid: boolean;
  canReplace: boolean;
  onFindTextChange: (query: string) => void;
  onReplaceTextChange: (value: string) => void;
  onToggleReplace: () => void;
  onToggleCaseSensitive: () => void;
  onToggleWholeWord: () => void;
  onToggleRegex: () => void;
  onTogglePreserveCase: () => void;
  onToggleFindInSelection: () => void;
  onClose: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
  onHistoryNavigate: (field: HistoryField, direction: HistoryDirection) => void;
  matchCount: number;
  currentMatch: number;
}

function ToggleButton({
  active,
  disabled,
  onClick,
  title,
  compact = false,
  ariaLabel,
  iconOnly = false,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  compact?: boolean;
  ariaLabel?: string;
  iconOnly?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Hint content={title}>
      <button
        type="button"
        aria-label={ariaLabel ?? title}
        aria-pressed={active}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "inline-flex h-6 items-center justify-center rounded-md font-medium text-[11px] leading-none transition-colors",
          iconOnly ? "size-6 px-0" : compact ? "px-1.5" : "px-2",
          active
            ? "bg-accent text-foreground"
            : disabled
              ? "text-muted-foreground"
              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          disabled && "cursor-default opacity-50",
        )}
      >
        {children}
      </button>
    </Hint>
  );
}

export function SearchPanel({
  preview = false,
  pdf = false,
  commentRange,
  statusText,
  findText,
  replaceText,
  isReplaceOpen,
  isCaseSensitive,
  isWholeWord,
  isRegex,
  preserveCase,
  findInSelection,
  canEnableFindInSelection,
  isQueryValid,
  canReplace,
  onFindTextChange,
  onReplaceTextChange,
  onToggleReplace,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onTogglePreserveCase,
  onToggleFindInSelection,
  onClose,
  onFindNext,
  onFindPrevious,
  onReplaceNext,
  onReplaceAll,
  onHistoryNavigate,
  matchCount,
  currentMatch,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [includeComments, setIncludeComments] = useState(true);
  const [commentIndex, setCommentIndex] = useState(-1);
  const comments = useSearchComments(
    {
      text: findText,
      caseSensitive: isCaseSensitive,
      wholeWord: isWholeWord,
      regex: isRegex,
    },
    includeComments && isQueryValid,
    pdf,
    findInSelection ? commentRange : null,
  );
  useEffect(
    () => setCommentIndex(-1),
    [
      findText,
      isCaseSensitive,
      isWholeWord,
      isRegex,
      includeComments,
      comments.results,
    ],
  );
  useCommentSearchHighlight(comments.results[commentIndex], {
    text: findText,
    caseSensitive: isCaseSensitive,
    wholeWord: isWholeWord,
    regex: isRegex,
  });
  const navigateComment = (index: number) => {
    setCommentIndex(index);
    comments.navigate(index);
  };
  const move = (direction: number) => {
    const count = comments.results.length;
    if (!count) {
      direction > 0 ? onFindNext() : onFindPrevious();
      return;
    }
    if (commentIndex >= 0) {
      const next = commentIndex + direction;
      if (next >= 0 && next < count) navigateComment(next);
      else if (!matchCount) navigateComment((next + count) % count);
      else {
        setCommentIndex(-1);
        direction > 0 ? onFindNext() : onFindPrevious();
      }
    } else if (
      !matchCount ||
      (direction > 0 ? currentMatch >= matchCount : currentMatch <= 1)
    ) {
      navigateComment(direction > 0 ? 0 : count - 1);
    } else direction > 0 ? onFindNext() : onFindPrevious();
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        move(-1);
      } else {
        move(1);
      }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onHistoryNavigate("find", e.key === "ArrowUp" ? "up" : "down");
    }
  };

  const handleReplaceKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        move(-1);
      } else {
        move(1);
      }
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onHistoryNavigate("replace", e.key === "ArrowUp" ? "up" : "down");
    }
  };

  const countLabel =
    statusText ??
    (!findText
      ? ""
      : !isQueryValid
        ? "Invalid regex"
        : matchCount + comments.results.length === 0
          ? "No results"
          : `${commentIndex >= 0 ? matchCount + commentIndex + 1 : currentMatch || 1} of ${matchCount + comments.results.length}`);

  return (
    <div
      data-testid={preview ? "preview-search-panel" : "editor-search-panel"}
      onKeyDownCapture={(event) => {
        if (!canCloseSearchOnEscape(event.nativeEvent)) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      className="pointer-events-auto flex w-full max-w-[860px] flex-col gap-1.5 rounded-xl border border-border/70 bg-background/95 p-1.5 shadow-lg backdrop-blur-sm"
    >
      <div className={cn("flex items-center gap-1.5", preview && "flex-wrap")}>
        {preview ? null : isReplaceOpen ? (
          <div className="size-6 shrink-0" aria-hidden="true" />
        ) : (
          <Hint content="Toggle Replace">
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                isReplaceOpen && "bg-accent text-foreground",
              )}
              onClick={onToggleReplace}
              aria-label="Toggle Replace"
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </Hint>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center rounded-md border border-border/70 bg-muted/40 transition-colors focus-within:border-ring",
            preview && "min-w-[180px]",
          )}
        >
          <Input
            ref={inputRef}
            type="text"
            value={findText}
            onChange={(e) => onFindTextChange(e.target.value)}
            onKeyDown={handleFindKeyDown}
            aria-label="Search"
            placeholder="Search..."
            className="h-7 min-w-0 flex-1 border-transparent bg-transparent text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-transparent"
          />
          <div className="mr-1 flex items-center gap-0">
            <ToggleButton
              active={isCaseSensitive}
              onClick={onToggleCaseSensitive}
              title="Match Case"
              compact
            >
              Aa
            </ToggleButton>
            <ToggleButton
              active={isWholeWord}
              onClick={onToggleWholeWord}
              title="Match Whole Word"
              compact
            >
              ab
            </ToggleButton>
            <ToggleButton
              active={isRegex}
              onClick={onToggleRegex}
              title="Use Regex"
              compact
            >
              <RegexIcon className="size-3.5" />
            </ToggleButton>
          </div>
        </div>

        {countLabel ? (
          <span className="shrink-0 text-muted-foreground text-xs">
            {countLabel}
          </span>
        ) : null}

        <div className="flex items-center gap-0.5">
          <Hint content="Find Previous">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => move(-1)}
              disabled={
                !findText ||
                !isQueryValid ||
                matchCount + comments.results.length === 0
              }
              aria-label="Find Previous"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
          </Hint>
          <Hint content="Find Next">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => move(1)}
              disabled={
                !findText ||
                !isQueryValid ||
                matchCount + comments.results.length === 0
              }
              aria-label="Find Next"
            >
              <ChevronRightIcon className="size-4" />
            </Button>
          </Hint>
          {!preview && (
            <ToggleButton
              active={findInSelection}
              onClick={onToggleFindInSelection}
              disabled={!canEnableFindInSelection && !findInSelection}
              title="Find in Selection"
              ariaLabel="Find in Selection"
              iconOnly
            >
              <svg
                viewBox="0 0 16 16"
                className="size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3.5 5h9" />
                <path d="M3.5 8h9" />
                <path d="M3.5 11h6.5" />
              </svg>
            </ToggleButton>
          )}
          <Hint content="Include Comments">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Include Comments"
              aria-pressed={includeComments}
              onClick={() => setIncludeComments((value) => !value)}
              className={cn(
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                includeComments && "bg-accent text-foreground",
              )}
            >
              <MessageSquareTextIcon className="size-3.5" strokeWidth={1.5} />
            </Button>
          </Hint>
          <Hint content="Close">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onClose}
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </Button>
          </Hint>
        </div>
      </div>

      {comments.results.length > 0 && (
        <div
          className="max-h-36 overflow-auto border-border/60 border-t pt-1"
          role="group"
          aria-label="Comment search results"
        >
          {comments.results.map((result, index) => (
            <button
              type="button"
              key={result.filePath + result.id}
              onClick={() => navigateComment(index)}
              className={cn(
                "flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted",
                commentIndex === index && "bg-muted",
              )}
              aria-label={`Open comment: ${result.text}`}
            >
              <MessageSquareTextIcon className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0 break-words">
                {result.text.slice(
                  Math.max(0, result.match.start - 50),
                  result.match.start,
                )}
                <mark>
                  {result.text.slice(result.match.start, result.match.end)}
                </mark>
                {result.text.slice(result.match.end, result.match.end + 100)}
              </span>
            </button>
          ))}
        </div>
      )}

      {isReplaceOpen ? (
        <div className="flex items-center gap-1.5">
          <Hint content="Collapse Replace">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onToggleReplace}
              aria-label="Collapse Replace"
            >
              <ChevronUpIcon className="size-4" />
            </Button>
          </Hint>
          <div className="flex min-w-0 flex-1 items-center rounded-md border border-border/70 bg-muted/40 transition-colors focus-within:border-ring">
            <Input
              type="text"
              value={replaceText}
              onChange={(e) => onReplaceTextChange(e.target.value)}
              onKeyDown={handleReplaceKeyDown}
              placeholder="Replace..."
              className="h-7 min-w-0 flex-1 border-transparent bg-transparent text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0 focus-visible:ring-transparent"
            />
            <div className="mr-1 flex items-center gap-0">
              <ToggleButton
                active={preserveCase}
                onClick={onTogglePreserveCase}
                disabled={isRegex}
                title="Preserve Case"
                compact
              >
                AB
              </ToggleButton>
            </div>
          </div>
          <Button
            variant="outline"
            size="xs"
            className="h-7"
            onClick={onReplaceNext}
            disabled={!canReplace || !isQueryValid || commentIndex >= 0}
          >
            Replace
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="h-7"
            onClick={onReplaceAll}
            disabled={!canReplace || !isQueryValid || commentIndex >= 0}
          >
            Replace All
          </Button>
        </div>
      ) : null}
    </div>
  );
}
