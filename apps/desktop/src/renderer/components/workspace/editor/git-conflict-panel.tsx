import { Hint } from "@/components/ui/tooltip";
import { DocumentBarNavigation } from "../document-bar-navigation";
import { documentBarGapClassName } from "../document-navigation-styles";
import { ReviewBarLayout } from "../review-bar-layout";
import {
  GIT_ANCESTOR_ACTION_CLASS,
  GIT_CURRENT_ACTION_CLASS,
  GIT_INCOMING_ACTION_CLASS,
} from "./git-conflict-styles";
import { type FC } from "react";

interface GitConflictPanelProps {
  threeWay?: boolean;
  ancestorContent?: string | null;
  onUseStarting?: () => void;
  currentDeleted?: boolean;
  incomingDeleted?: boolean;
  mergeChunkInfo: { current: number; total: number };
  resolving: boolean;
  error: string | null;
  onPreviousChunk: () => void;
  onNextChunk: () => void;
  onAcceptIncoming: () => void;
  onKeepCurrent: () => void;
}

export const GitConflictPanel: FC<GitConflictPanelProps> = ({
  threeWay = false,
  ancestorContent,
  onUseStarting,
  currentDeleted = false,
  incomingDeleted = false,
  mergeChunkInfo,
  resolving,
  error,
  onPreviousChunk,
  onNextChunk,
  onAcceptIncoming,
  onKeepCurrent,
}) => {
  const isWholeFileConflict = currentDeleted || incomingDeleted;
  return (
    <>
      <ReviewBarLayout
        data-git-conflict-panel="true"
        heading={
          <div
            className={`flex min-w-0 items-center text-sm ${documentBarGapClassName}`}
          >
            <span className="shrink-0 font-medium text-foreground">
              Resolve Git Conflict
            </span>
            {error && (
              <Hint content={error}>
                <span className="min-w-0 truncate text-destructive text-xs">
                  {error}
                </span>
              </Hint>
            )}
          </div>
        }
        navigation={
          mergeChunkInfo.total > 0 && (
            <DocumentBarNavigation
              label="Conflict navigation"
              previousLabel="Previous conflict"
              nextLabel="Next conflict"
              itemLabel="Conflict"
              current={mergeChunkInfo.current}
              total={mergeChunkInfo.total}
              onPrevious={onPreviousChunk}
              onNext={onNextChunk}
            />
          )
        }
        actions={
          <>
            {onUseStarting && (threeWay || ancestorContent != null) && (
              <button
                type="button"
                disabled={resolving}
                onClick={onUseStarting}
                className={GIT_ANCESTOR_ACTION_CLASS}
              >
                {threeWay ? "Use Ancestors" : "Use starting file"}
              </button>
            )}
            <button
              type="button"
              disabled={resolving}
              onClick={onKeepCurrent}
              aria-label={threeWay && !resolving ? "Reject All" : undefined}
              className={GIT_CURRENT_ACTION_CLASS}
            >
              {resolving
                ? "Resolving…"
                : threeWay
                  ? "Reject All"
                  : currentDeleted
                    ? "Keep current (delete file)"
                    : isWholeFileConflict
                      ? "Keep current"
                      : "Keep All Current"}
              {!resolving && (
                <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
                  ⌘N
                </kbd>
              )}
            </button>
            <button
              type="button"
              disabled={resolving}
              onClick={onAcceptIncoming}
              aria-label={threeWay && !resolving ? "Accept All" : undefined}
              className={GIT_INCOMING_ACTION_CLASS}
            >
              {resolving
                ? "Resolving…"
                : threeWay
                  ? "Accept All"
                  : incomingDeleted
                    ? "Use incoming (delete file)"
                    : isWholeFileConflict
                      ? "Use incoming"
                      : "Use All Incoming"}
              {!resolving && (
                <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
                  ⌘Y
                </kbd>
              )}
            </button>
          </>
        }
      />
      {!threeWay && ancestorContent !== undefined && (
        <details
          data-workspace-separator="conflict"
          className="max-h-48 shrink-0 overflow-auto border-slate-500/30 border-b bg-slate-500/10"
          open
        >
          <summary className="cursor-pointer px-3 py-2 font-medium text-slate-700 text-xs dark:text-slate-300">
            Common ancestor · entire starting file
          </summary>
          <pre className="whitespace-pre-wrap break-words px-3 pb-3 font-mono text-xs">
            {ancestorContent ??
              "This file did not exist in the common ancestor."}
          </pre>
        </details>
      )}
    </>
  );
};
