import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { type FC } from "react";
import { type ProposedChange } from "@/stores/proposed-changes-store";
import { DocumentBarNavigation } from "@/components/workspace/document-bar-navigation";
import {
  documentBarClassName,
  documentBarGapClassName,
} from "@/components/workspace/document-navigation-styles";

interface ProposedChangesPanelProps {
  change: ProposedChange;
  mergeChunkInfo?: { current: number; total: number };
  showChunkNavigation?: boolean;
  onPreviousChunk?: () => void;
  onNextChunk?: () => void;
  threeWay?: boolean;
  onUseStarting?: () => void;
  onKeep: () => void;
  onUndo: () => void;
  settlementError?: string | null;
  disabled?: boolean;
}

export const ProposedChangesPanel: FC<ProposedChangesPanelProps> = ({
  change,
  mergeChunkInfo,
  showChunkNavigation = true,
  onPreviousChunk,
  onNextChunk,
  threeWay = false,
  onUseStarting,
  onKeep,
  onUndo,
  settlementError,
  disabled = false,
}) => {
  const oldLines = change.oldContent.split("\n").length;
  const newLines = change.newContent.split("\n").length;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);

  return (
    <div
      data-proposed-changes-panel="true"
      className={cn(
        documentBarClassName,
        "justify-between bg-muted/50",
        threeWay && "@container/review-bar flex-wrap",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 items-center overflow-hidden text-sm",
          documentBarGapClassName,
          threeWay && "flex-1",
        )}
      >
        <span className="shrink-0 font-medium text-foreground">
          {change.workspaceSessionId ? "Review draft" : "Proposed Changes"}
        </span>
        {showChunkNavigation &&
          change.workspaceChangeKind &&
          change.workspaceChangeKind !== "modified" && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs capitalize">
              {change.workspaceChangeKind}
            </span>
          )}
        {settlementError && (
          <Hint content={settlementError}>
            <span className="shrink-0 text-amber-600 text-xs dark:text-amber-400">
              conflict — source unchanged
            </span>
          </Hint>
        )}
        {showChunkNavigation && added > 0 && (
          <span className="shrink-0 text-green-400">+{added}</span>
        )}
        {showChunkNavigation && removed > 0 && (
          <span className="shrink-0 text-red-400">-{removed}</span>
        )}
      </div>
      <div
        className={cn(
          "flex @max-[532px]/review-bar:contents shrink-0 items-center",
          documentBarGapClassName,
          threeWay && "ml-auto max-w-full flex-wrap justify-end",
        )}
      >
        {mergeChunkInfo && mergeChunkInfo.total > 0 && (
          <>
            {showChunkNavigation ? (
              <DocumentBarNavigation
                label="Change navigation"
                previousLabel="Previous change"
                nextLabel="Next change"
                itemLabel="Change"
                current={mergeChunkInfo.current}
                total={mergeChunkInfo.total}
                onPrevious={() => onPreviousChunk?.()}
                onNext={() => onNextChunk?.()}
              />
            ) : (
              <span className="px-1 font-mono text-muted-foreground text-xs">
                {mergeChunkInfo.total}{" "}
                {mergeChunkInfo.total === 1 ? "change" : "changes"}
              </span>
            )}
            <div className="@max-[532px]/review-bar:hidden h-4 w-px bg-border" />
          </>
        )}
        <div
          className={cn(
            "@max-[532px]/review-bar:flex contents @max-[532px]/review-bar:w-full @max-[532px]/review-bar:flex-wrap @max-[532px]/review-bar:justify-end",
            documentBarGapClassName,
          )}
        >
          {threeWay && onUseStarting && (
            <button
              type="button"
              disabled={disabled}
              onClick={onUseStarting}
              className="flex h-7 items-center gap-1 rounded-md bg-[#64748b] px-2.5 font-medium text-white text-xs transition-colors hover:bg-[#475569]"
            >
              Use Ancestors
            </button>
          )}
          <button
            type="button"
            disabled={disabled}
            onClick={onUndo}
            aria-label="Reject All"
            className="flex h-7 items-center gap-1 rounded-md bg-[#ef4444] px-2.5 font-medium text-white text-xs transition-colors hover:bg-[#dc3e3e]"
          >
            Reject All
            <kbd className="ml-1 @max-[317px]/review-bar:hidden rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
              ⌘N
            </kbd>
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={onKeep}
            aria-label="Accept All"
            className="flex h-7 items-center gap-1 rounded-md bg-[#36ad5e] px-2.5 font-medium text-white text-xs transition-colors hover:bg-[#2f9852]"
          >
            Accept All
            <kbd className="ml-1 @max-[317px]/review-bar:hidden rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
              ⌘Y
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
};
