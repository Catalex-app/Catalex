import { FileVersionPane } from "./file-version-pane";
import { useEffect, useState, type ReactNode } from "react";
import {
  GIT_ANCESTOR_ACTION_CLASS,
  GIT_CURRENT_ACTION_CLASS,
  GIT_INCOMING_ACTION_CLASS,
} from "./git-conflict-styles";
import { invoke } from "@/lib/desktop/core";
import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  type ConflictFile,
  advanceAfterGitConflictResolution,
} from "@/lib/git-conflicts";
import { useDocumentStore } from "@/stores/document-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

export function GitFileConflictView({
  projectRoot,
  file,
  active,
  rebasing,
  onResolved,
  onRefresh,
  children,
}: {
  projectRoot: string | null;
  file: ConflictFile | null;
  active: boolean;
  rebasing: boolean;
  onResolved: (file: ConflictFile) => void;
  onRefresh: () => void;
  children: (panes: { current: ReactNode; incoming: ReactNode }) => ReactNode;
}) {
  const conflictKey = file
    ? `${projectRoot}:${file.path}:${file.version}`
    : null;
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const error = failure?.key === conflictKey ? failure?.message : null;
  const [pending, setPending] = useState<{
    key: string;
    choice: "ancestor" | "current" | "incoming";
  } | null>(null);
  const resolving = pending?.key === conflictKey ? pending?.choice : null;
  const busy = useDocumentStore((s) => s.isGitOperationRunning);
  const hasPendingReview = useProposedChangesStore((s) => s.changes.length > 0);
  const disabled = !active || Boolean(pending || busy || hasPendingReview);
  const unsupported =
    file &&
    [file.ancestor, file.current, file.incoming].some(
      (side) => side && (!side.supported || side.path !== file.path),
    );
  const resolve = async (choice: "ancestor" | "current" | "incoming") => {
    if (!file || !projectRoot || !conflictKey || disabled || unsupported)
      return;
    const navigation = useDocumentStore.getState();
    setPending({ key: conflictKey, choice });
    setFailure(null);
    try {
      await useDocumentStore.getState().runGitOperation(
        projectRoot,
        {
          saveFiles: [],
          discardFiles: file.document_path ? [file.document_path] : [],
        },
        () =>
          invoke("git_panel_resolve_conflict_side", {
            projectRoot,
            filePath: file.path,
            choice,
            expectedVersion: file.version,
          }),
      );
      const state = useDocumentStore.getState();
      const accepted = file[choice];
      if (
        state.projectRoot === projectRoot &&
        !state.agentWorkspaceRoot &&
        accepted
      ) {
        useDocumentStore.setState({
          files: state.files.map((entry) =>
            entry.relativePath === file.document_path
              ? {
                  ...entry,
                  isBinary:
                    entry.type !== "image" &&
                    entry.type !== "pdf" &&
                    accepted.binary,
                  fileSize: accepted.size,
                }
              : entry,
          ),
        });
      }
      onResolved(file);
      await advanceAfterGitConflictResolution(navigation, file.path);
    } catch (error) {
      setFailure({
        key: conflictKey,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(null);
    }
  };
  useEffect(() => {
    if (!active || disabled || unsupported) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.repeat
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (
        target?.closest(
          'input, textarea, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return;
      const choice =
        event.key.toLowerCase() === "n"
          ? "current"
          : event.key.toLowerCase() === "y"
            ? "incoming"
            : null;
      if (!choice) return;
      event.preventDefault();
      event.stopPropagation();
      void resolve(choice);
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [active, disabled, unsupported, resolve]);

  const renderPane = (choice: "ancestor" | "current" | "incoming") => {
    if (!file) return null;
    const side = file[choice];
    const label =
      choice === "ancestor"
        ? "Common ancestor"
        : choice === "current"
          ? "Current"
          : "Incoming";
    const acceptButton = (
      <button
        type="button"
        className={
          choice === "ancestor"
            ? GIT_ANCESTOR_ACTION_CLASS
            : choice === "current"
              ? GIT_CURRENT_ACTION_CLASS
              : GIT_INCOMING_ACTION_CLASS
        }
        aria-label={
          choice === "ancestor"
            ? "Use starting version of entire file"
            : `Accept ${choice}`
        }
        disabled={disabled || Boolean(unsupported)}
        onClick={() => void resolve(choice)}
      >
        {resolving === choice
          ? "Accepting…"
          : choice === "ancestor"
            ? "Use starting file"
            : `Accept ${choice}`}
        {!resolving && choice !== "ancestor" && (
          <kbd className="ml-1 rounded bg-white/20 px-1 py-0.5 font-mono text-[10px]">
            {choice === "current" ? "⌘N" : "⌘Y"}
          </kbd>
        )}
      </button>
    );
    const sideExplanation =
      choice === "ancestor" ? (
        <p className="shrink-0 border-slate-500/30 border-b bg-slate-500/10 px-3 py-2 text-slate-700 text-xs dark:text-slate-300">
          Shared starting version. Selecting this restores the entire file.
        </p>
      ) : rebasing ? (
        <p className="shrink-0 border-b px-3 py-2 text-muted-foreground text-xs">
          {choice === "current"
            ? "Rebase target — the history you are rebasing onto."
            : "Commit being replayed — your changes."}
        </p>
      ) : null;
    return (
      <FileVersionPane
        key={`${conflictKey}:${choice}`}
        path={file.path}
        label={`${label} version`}
        previewUrl={side?.preview_url}
        size={side?.size}
        text={side?.text ?? null}
        deleted={!side}
        actions={acceptButton}
      >
        {sideExplanation}
      </FileVersionPane>
    );
  };
  return (
    <section
      aria-label={active ? "File conflict versions" : undefined}
      data-workspace-conflict-panes={active ? "true" : undefined}
      data-workspace-standard-panels="true"
      className="flex h-full min-h-0 flex-col gap-2"
    >
      {active && error && (
        <div
          role="alert"
          className="max-h-32 shrink-0 overflow-auto rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
        >
          <p className="whitespace-pre-wrap break-words">{error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={onRefresh}
            className="mt-2"
          >
            <RefreshCwIcon className="size-3.5" />
            Refresh conflict
          </Button>
          <p className="mt-1">Or retry Accept.</p>
        </div>
      )}
      {active && hasPendingReview && (
        <p role="alert" className="px-3 text-sm">
          Review pending AI suggestions before accepting a version.
        </p>
      )}
      {active && unsupported && (
        <p role="alert" className="px-3 text-destructive text-sm">
          This conflict involves a symbolic link, submodule or related rename
          paths. Whole-file resolution is unavailable for this conflict.
        </p>
      )}

      {children({
        current: (
          <div className="flex h-full min-h-0 flex-col gap-2">
            {file?.ancestor !== undefined && (
              <div className="min-h-0 flex-1 overflow-hidden rounded border border-slate-500/40">
                {renderPane("ancestor")}
              </div>
            )}
            <div className="min-h-0 flex-1">{renderPane("current")}</div>
          </div>
        ),
        incoming: renderPane("incoming"),
      })}
    </section>
  );
}
