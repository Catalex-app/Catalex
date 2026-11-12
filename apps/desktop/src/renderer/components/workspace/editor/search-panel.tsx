import { DocumentBarNavigation } from "../document-bar-navigation";
import {
  useSearchComments,
  useCommentSearchHighlight,
  dismissSearchComment,
} from "./search-comments";
import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  MessageSquareTextIcon,
  RegexIcon,
  AlignLeftIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { SearchScope } from "@/lib/preview-search";
import {
  documentBarButtonClassName,
  documentBarClassName,
  documentBarControlHeightClassName,
} from "../document-navigation-styles";

type HistoryField = "find" | "replace";
type HistoryDirection = "up" | "down";

interface SearchPanelProps {
  preview?: boolean;
  testId?: string;
  pdf?: boolean;
  commentRange?: { from: number; to: number } | null;
  statusText?: string;
  findText: string;
  replaceText: string;
  isReplaceOpen: boolean;
  isCaseSensitive: boolean;
  isWholeWord: boolean;
  isRegex: boolean;
  scope: SearchScope;
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
  onScopeChange?: (scope: SearchScope) => void;
  onTogglePreserveCase: () => void;
  onToggleFindInSelection: () => void;
  onClose: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onFindCurrent?: () => void;
  onReplaceNext: () => void;
  onReplaceAll: () => void;
  onHistoryNavigate: (field: HistoryField, direction: HistoryDirection) => void;
  matchCount: number;
  currentMatch: number;
}

const searchRowClassName = cn(
  documentBarClassName,
  "col-span-2 grid grid-cols-subgrid",
);
const searchControlsClassName =
  "flex min-h-8 min-w-0 flex-wrap content-center items-center gap-1";
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
        "flex @[460px]/search:h-8 h-7 min-w-0 items-center gap-1 @[460px]/search:rounded-lg rounded-md border border-input bg-muted/30 pr-1 transition-colors focus-within:border-foreground focus-within:bg-background",
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
  testId,
  pdf = false,
  commentRange,
  statusText,
  findText,
  replaceText,
  isReplaceOpen,
  isCaseSensitive,
  isWholeWord,
  isRegex,
  scope,
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
  onScopeChange,
  onTogglePreserveCase,
  onToggleFindInSelection,
  onClose,
  onFindNext,
  onFindPrevious,
  onFindCurrent,
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
    Boolean(onScopeChange) && scope !== "text" && isQueryValid,
    pdf,
    findInSelection ? commentRange : null,
  );
  useEffect(
    () => setCommentIndex(-1),
    [findText, isCaseSensitive, isWholeWord, isRegex, scope, comments.results],
  );
  const selectedComment = comments.results[commentIndex];
  const textCount = scope === "comments" ? 0 : matchCount;
  useCommentSearchHighlight(selectedComment, {
    text: findText,
    caseSensitive: isCaseSensitive,
    wholeWord: isWholeWord,
    regex: isRegex,
  });
  useEffect(() => {
    const pane = inputRef.current?.closest<HTMLElement>("[data-preview-pane]");
    if (preview && selectedComment && pane)
      return () => dismissSearchComment(pane, selectedComment);
  }, [preview, selectedComment]);
  const navigateComment = (index: number) => {
    setCommentIndex(index);
    comments.navigate(index, inputRef.current, preview);
  };
  const move = (direction: number) => {
    if (!findText || !isQueryValid) return;
    const count = comments.results.length;
    const moveText = direction > 0 ? onFindNext : onFindPrevious;
    if (!count) {
      if (textCount) moveText();
      return;
    }
    if (selectedComment) {
      const next = commentIndex + direction;
      if (next >= 0 && next < count) navigateComment(next);
      else if (!textCount) navigateComment((next + count) % count);
      else {
        setCommentIndex(-1);
        // Text was left at one end of its range when entering the comments.
        const boundary = direction > 0 ? 1 : textCount;
        if (currentMatch !== boundary) moveText();
        else onFindCurrent?.();
      }
    } else if (
      !textCount ||
      (direction > 0 ? currentMatch >= textCount : currentMatch <= 1)
    ) {
      navigateComment(direction > 0 ? 0 : count - 1);
    } else moveText();
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
    findText && isQueryValid ? textCount + comments.results.length : 0;
  const current = !total
    ? 0
    : selectedComment
      ? textCount + commentIndex + 1
      : textCount
        ? currentMatch || 1
        : 0;
  const status = findText && !isQueryValid ? "Invalid regex" : statusText;

  return (
    <div
      data-testid={
        testId ?? (preview ? "preview-search-panel" : "editor-search-panel")
      }
      className="@container/search grid shrink-0 grid-cols-[auto_minmax(0,1fr)]"
    >
      <div className={searchRowClassName}>
        {onScopeChange && (
          <div
            className={cn(
              documentBarControlHeightClassName,
              "flex items-center self-start",
            )}
          >
            <ButtonGroup<SearchScope>
              aria-label="Search scope"
              className="[&>button]:w-7 [&>button]:px-0"
              selection={{
                layout: "responsive",
                compactLabel: "Search scope",
                compactIconsOnly: true,
                value: scope,
                onValueChange: onScopeChange,
                options: [
                  {
                    value: "all",
                    label: "All",
                    icon: (
                      <SearchIcon className="size-3.5" aria-hidden="true" />
                    ),
                    hint: "All",
                  },
                  {
                    value: "comments",
                    label: "Comments only",
                    icon: (
                      <MessageSquareTextIcon
                        className="size-3.5"
                        aria-hidden="true"
                      />
                    ),
                    hint: "Comments only",
                  },
                  {
                    value: "text",
                    label: "Text only",
                    icon: (
                      <AlignLeftIcon className="size-3.5" aria-hidden="true" />
                    ),
                    hint: "Text only",
                  },
                ],
              }}
            />
          </div>
        )}
        <div
          className={cn(
            searchControlsClassName,
            !onScopeChange && "col-span-2",
          )}
        >
          <SearchField
            label="Search options"
            className={preview ? "flex-[1_1_9rem]" : "flex-[1_1_11rem]"}
          >
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
      </div>

      {isReplaceOpen ? (
        <div className={searchRowClassName}>
          <div className={cn(searchControlsClassName, "col-start-2")}>
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
        </div>
      ) : null}
    </div>
  );
}
