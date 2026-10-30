import { Hint } from "@/components/ui/tooltip";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import { GitCommitHorizontalIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDocumentStore } from "@/stores/document-store";
import { cn } from "@/lib/utils";

interface GitHistoryEntry {
  hash: string;
  subject: string;
  author: string;
  refs: string[];
  is_head: boolean;
}

interface GitBranchInfo {
  name: string;
  is_current: boolean;
}

interface GitHistoryDialogProps {
  projectPath: string;
  branch: string | null;
  onClose: () => void;
  onBranchChanged: () => Promise<void>;
  branchSwitchDisabled: boolean;
}

const HISTORY_LIMIT = 100;

export function GitHistoryDialog({
  projectPath,
  branch,
  onClose,
  onBranchChanged,
  branchSwitchDisabled,
}: GitHistoryDialogProps) {
  const [entries, setEntries] = useState<GitHistoryEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const isGitOperationRunning = useDocumentStore(
    (s) => s.isGitOperationRunning,
  );
  const currentBranch =
    branches.find((item) => item.is_current)?.name ?? branch ?? "";

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const [history, nextBranches] = await Promise.all([
        invoke<GitHistoryEntry[]>("git_panel_history", {
          projectRoot: projectPath,
          limit: HISTORY_LIMIT,
        }),
        invoke<GitBranchInfo[]>("git_panel_branches", {
          projectRoot: projectPath,
        }),
      ]);
      if (id !== requestId.current) return;
      setEntries(history);
      setBranches(nextBranches);
      setHasLoaded(true);
    } catch (cause) {
      if (id === requestId.current) setError(String(cause));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void refresh();
    const handleRefresh = () => {
      void refresh();
    };
    window.addEventListener("catalex:git-stats-refresh", handleRefresh);
    return () => {
      requestId.current += 1;
      window.removeEventListener("catalex:git-stats-refresh", handleRefresh);
    };
  }, [refresh]);

  const switchBranch = async (name: string) => {
    if (
      branchSwitchDisabled ||
      isGitOperationRunning ||
      loading ||
      switching ||
      !name ||
      name === currentBranch
    )
      return;
    setSwitching(true);
    setError(null);
    try {
      const result = await useDocumentStore
        .getState()
        .runGitOperation(
          projectPath,
          { history: { label: "switch branch", before: true } },
          () =>
            invoke<{ success: boolean; message: string }>(
              "git_panel_checkout_branch",
              { projectRoot: projectPath, branch: name },
            ),
        );
      if (!result.success) throw new Error(result.message);
      await onBranchChanged();
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="h-[min(32rem,calc(100svh-2rem))] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
      >
        <DialogHeader className="space-y-3">
          <DialogIconHeader>
            <GitCommitHorizontalIcon
              className="text-muted-foreground"
              aria-hidden="true"
            />
          </DialogIconHeader>
          <DialogTitle>Git history</DialogTitle>
          <DialogDescription className="sr-only">
            Browse Git commits and switch branches.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2">
          <label
            htmlFor="git-history-branch"
            className="text-muted-foreground text-xs"
          >
            Branch
          </label>
          <Select
            value={currentBranch || undefined}
            disabled={
              branchSwitchDisabled ||
              isGitOperationRunning ||
              loading ||
              switching ||
              branches.length === 0
            }
            onValueChange={(value) => {
              void switchBranch(value);
            }}
          >
            <Hint
              content={
                branchSwitchDisabled
                  ? "Finish AI review or the current Git operation before switching branches"
                  : "Switch branch"
              }
            >
              <SelectTrigger
                id="git-history-branch"
                size="sm"
                className="min-w-0 flex-1 rounded-lg border-border/70 bg-background px-2 shadow-none dark:bg-background dark:hover:bg-background"
              >
                <SelectValue placeholder="Detached HEAD" />
              </SelectTrigger>
            </Hint>
            <SelectContent position="popper" align="end" className="rounded-xl">
              {currentBranch &&
                !branches.some((item) => item.name === currentBranch) && (
                  <SelectItem value={currentBranch}>{currentBranch}</SelectItem>
                )}
              {branches.map((item) => (
                <SelectItem
                  key={item.name}
                  value={item.name}
                  className="rounded-lg"
                >
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Refresh Git history"
            disabled={loading || switching}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCwIcon
              className={cn("size-4", loading && "animate-spin")}
            />
          </Button>
        </div>
        <div
          className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted/30"
          aria-busy={loading || switching}
        >
          {error && (
            <p
              role="alert"
              className="shrink-0 break-words bg-destructive/10 p-3 text-destructive text-sm"
            >
              {error}
            </p>
          )}
          <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
            {!hasLoaded && loading ? (
              <p
                role="status"
                className="py-8 text-center text-muted-foreground text-sm"
              >
                Loading commits…
              </p>
            ) : !hasLoaded ? null : entries.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground text-sm">
                No commits yet.
              </p>
            ) : (
              <>
                <ol className="divide-y divide-border/60">
                  {entries.map((entry) => (
                    <li key={entry.hash} className="flex gap-3 p-3">
                      <GitCommitHorizontalIcon
                        className={cn(
                          "mt-0.5 size-4 shrink-0",
                          entry.is_head
                            ? "text-blue-500"
                            : "text-muted-foreground",
                        )}
                      />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="break-words text-sm">{entry.subject}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
                          <span className="select-text font-mono">
                            {entry.hash}
                          </span>
                          <span className="break-words">{entry.author}</span>
                          {entry.refs.map((ref) => (
                            <span
                              key={ref}
                              className="max-w-full break-words rounded-md border border-border/70 bg-muted px-1.5 py-0.5 text-[10px]"
                            >
                              {ref}
                            </span>
                          ))}
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                {entries.length === HISTORY_LIMIT && (
                  <p className="pt-2 text-center text-muted-foreground text-xs">
                    Showing the latest {HISTORY_LIMIT} commits.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
