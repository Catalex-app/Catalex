import { DocumentBarNavigation } from "../document-bar-navigation";
import {
  useSearchComments,
  useCommentSearchHighlight,
} from "./search-comments";
import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import {
  XIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  RegexIcon,
  MessageSquareTextIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  documentBarButtonClassName,
  documentBarClassName,
  documentBarControlHeightClassName,
} from "../document-navigation-styles";

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
  includeComments: boolean;
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
  onToggleComments: () => void;
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

const searchRowClassName = cn(documentBarClassName, "flex-wrap content-center");
function SearchField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className: string;
}) {
  return (
    <div
      className={cn(
        documentBarControlHeightClassName,
        "flex min-w-0 items-center gap-1 rounded-md border border-input bg-muted/30 pr-1 transition-colors focus-within:border-foreground focus-within:bg-background",
        className,
      )}
    >
      <ButtonGroup
        variant="plain"
        aria-label={label}
        className="flex h-full min-w-0 flex-1 items-center gap-1"
      >
        {children}
      </ButtonGroup>
    </div>
  );
}

const searchInputClassName =
  "h-full flex-1 rounded-none border-0 bg-transparent px-2 shadow-none outline-none! dark:bg-transparent";

function ToggleButton({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Hint content={title}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={title}
        aria-pressed={active}
        onClick={onClick}
        disabled={disabled}
        className={cn(
          documentBarButtonClassName,
          "text-[11px] aria-pressed:bg-accent aria-pressed:text-foreground",
        )}
      >
        {children}
      </Button>
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
  includeComments,
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
  onToggleComments,
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
    if (!findText || !isQueryValid) return;
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

  const total =
    findText && isQueryValid ? matchCount + comments.results.length : 0;
  const current = total
    ? commentIndex >= 0
      ? matchCount + commentIndex + 1
      : currentMatch || 1
    : 0;
  const status = findText && !isQueryValid ? "Invalid regex" : statusText;

  return (
    <div
      data-testid={preview ? "preview-search-panel" : "editor-search-panel"}
      className="flex shrink-0 flex-col"
    >
      <div className={searchRowClassName}>
        <SearchField label="Search options" className="flex-[1_1_9rem]">
          {preview ? null : isReplaceOpen ? (
            <div className="ml-1 size-6 shrink-0" aria-hidden="true" />
          ) : (
            <Hint content="Toggle Replace">
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(documentBarButtonClassName, "ml-1")}
                onClick={onToggleReplace}
                aria-label="Toggle Replace"
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </Hint>
          )}
          <Input
            ref={inputRef}
            type="text"
            value={findText}
            onChange={(e) => onFindTextChange(e.target.value)}
            onKeyDown={handleFindKeyDown}
            aria-label="Search"
            placeholder="Search..."
            className={cn(searchInputClassName, !preview && "pl-0")}
          />
          <ToggleButton
            active={isCaseSensitive}
            onClick={onToggleCaseSensitive}
            title="Match Case"
          >
            Aa
          </ToggleButton>
          <ToggleButton
            active={isWholeWord}
            onClick={onToggleWholeWord}
            title="Match Whole Word"
          >
            ab
          </ToggleButton>
          <ToggleButton
            active={isRegex}
            onClick={onToggleRegex}
            title="Use Regex"
          >
            <RegexIcon className="size-3.5" />
          </ToggleButton>
        </SearchField>

        <div className="ml-auto flex min-w-0 items-center gap-1">
          {status && (
            <span
              className="min-w-0 truncate text-muted-foreground"
              role="status"
              title={status}
            >
              {status}
            </span>
          )}
          {!preview && (
            <ToggleButton
              active={findInSelection}
              onClick={onToggleFindInSelection}
              disabled={!canEnableFindInSelection && !findInSelection}
              title="Find in Selection"
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
          <ToggleButton
            active={includeComments}
            onClick={onToggleComments}
            title="Include Comments"
          >
            <MessageSquareTextIcon className="size-3.5" strokeWidth={1.5} />
          </ToggleButton>
          <DocumentBarNavigation
            label="Search navigation"
            previousLabel="Find Previous"
            nextLabel="Find Next"
            itemLabel="Match"
            current={current}
            total={total}
            onPrevious={() => move(-1)}
            onNext={() => move(1)}
          />
          <Hint content="Close">
            <Button
              variant="ghost"
              size="icon-xs"
              className={documentBarButtonClassName}
              onClick={onClose}
              aria-label="Close"
            >
              <XIcon className="size-3.5" />
            </Button>
          </Hint>
        </div>
      </div>

      {comments.results.length > 0 && (
        <div
          className="max-h-36 overflow-auto border-border border-b bg-background px-2 py-1"
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
        <div className={searchRowClassName}>
          <SearchField label="Replace options" className="flex-[1_1_7rem]">
            <Hint content="Collapse Replace">
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(documentBarButtonClassName, "ml-1")}
                onClick={onToggleReplace}
                aria-label="Collapse Replace"
              >
                <ChevronUpIcon className="size-3.5" />
              </Button>
            </Hint>
            <Input
              type="text"
              value={replaceText}
              onChange={(e) => onReplaceTextChange(e.target.value)}
              onKeyDown={handleReplaceKeyDown}
              placeholder="Replace..."
              className={cn(searchInputClassName, "pl-0")}
            />
            <ToggleButton
              active={preserveCase}
              onClick={onTogglePreserveCase}
              disabled={isRegex}
              title="Preserve Case"
            >
              AB
            </ToggleButton>
          </SearchField>
          <Button
            variant="ghost"
            size="xs"
            className={documentBarButtonClassName}
            onClick={onReplaceNext}
            disabled={!canReplace || !isQueryValid || commentIndex >= 0}
          >
            Replace
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className={documentBarButtonClassName}
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
