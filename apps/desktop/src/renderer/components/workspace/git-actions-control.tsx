import { PRODUCT_NAME } from "../../../branding";
import { CheckboxIndicator } from "@/components/ui/checkbox";
import { ActionSelector } from "./action-selector";
import { Hint } from "@/components/ui/tooltip";
import { ensureConflictFiles } from "@/lib/git-conflicts";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@/lib/desktop/core";
import {
  ArchiveIcon,
  ArrowUpToLineIcon,
  CheckIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  GithubIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GitMergeIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/document-store";
import {
  useProposedChangesStore,
  assertGitReviewFinished,
} from "@/stores/proposed-changes-store";
import {
  formatGitCommand,
  GitCommandDisclosure,
} from "./git-command-disclosure";
import { GitSetupDialog } from "./git-setup-dialog";
import { GitHistoryDialog } from "./git-history-dialog";

function runRemoteGitAction(command: string, args: Record<string, unknown>) {
  assertGitReviewFinished();
  return invoke<GitCommandResult>(command, args);
}

function runWorkingTreeGitAction(
  command: string,
  args: Record<string, unknown> & { projectRoot: string },
  label: string,
) {
  return useDocumentStore
    .getState()
    .runGitOperation(
      args.projectRoot,
      { history: { label, before: true } },
      () => invoke<GitCommandResult>(command, args),
    );
}

interface GitPanelStatus {
  repo_found: boolean;
  branch: string | null;
  upstream_branch: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  operation: string | null;
  can_push: boolean;
}

interface GitChangedFile {
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

interface GitFileLineStats {
  file_path: string;
  added: number;
  deleted: number;
}

interface GitCommandResult {
  success: boolean;
  message: string;
}

interface GitPullStatus {
  can_pull: boolean;
  behind: number;
  behind_commits: string[];
}

interface GitPushRecoveryPreview {
  remote_name: string;
  remote_branch: string;
  conflicted_files: string[];
}

interface GitGraphCommit {
  hash: string;
  short_hash: string;
  subject: string;
  author: string;
  committed_at: number;
  refs: string[];
  parents: string[];
  is_head: boolean;
}

interface GitGraphNode {
  commit: GitGraphCommit;
  x: number;
  y: number;
}

interface GitGraphEdge {
  child: GitGraphNode;
  parent: GitGraphNode;
}

interface GitStashEntry {
  reference: string;
  message: string;
}

interface RefreshStatusOptions {
  selectAllCommitFiles?: boolean;
  selectAllResetFiles?: boolean;
}

type CommitAncestorRelation = "yes" | "no" | "unknown";

const GIT_STATS_REFRESH_EVENT = "catalex:git-stats-refresh";
const MAX_DISPLAYED_PATH_CHARS = 36;

function formatPushCommand(
  status: GitPanelStatus | null,
  forceWithLease = false,
): string {
  const args = ["push"];
  if (forceWithLease) args.push("--force-with-lease");
  const upstream = status?.upstream_branch;
  const localBranch = status?.branch;
  const separator = upstream?.indexOf("/") ?? -1;
  if (upstream && localBranch && separator > 0) {
    const remoteName = upstream.slice(0, separator);
    const remoteBranch = upstream.slice(separator + 1);
    if (remoteBranch !== localBranch) {
      args.push(remoteName, `HEAD:refs/heads/${remoteBranch}`);
    }
  } else if (localBranch && !upstream) {
    args.push("--set-upstream", "origin", localBranch);
  }
  return formatGitCommand(args);
}

function formatError(value: unknown) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isRemoteAheadPushError(value: unknown): boolean {
  const message = formatError(value).toLowerCase();
  return (
    message.includes("non-fast-forward") ||
    message.includes("fetch first") ||
    message.includes("remote contains work that you do not have locally") ||
    (message.includes("[rejected]") &&
      message.includes("failed to push some refs"))
  );
}

export function truncatePathLabel(
  path: string,
  maxChars = MAX_DISPLAYED_PATH_CHARS,
): string {
  if (path.length <= maxChars) return path;
  const tailLength = Math.max(16, Math.floor(maxChars * 0.45));
  const headLength = Math.max(8, maxChars - tailLength - 3);
  return `${path.slice(0, headLength)}...${path.slice(path.length - tailLength)}`;
}

function layoutGitGraph(commits: GitGraphCommit[]) {
  const xStep = 92;
  const yStep = 40;
  const paddingX = 36;
  const paddingY = 38;
  const displayedHashes = new Set(commits.map((commit) => commit.hash));
  const activeLanes: string[] = [];
  const laneByHash = new Map<string, number>();

  for (const commit of commits) {
    let lane = activeLanes.indexOf(commit.hash);
    if (lane < 0) {
      lane = activeLanes.length;
      activeLanes.push(commit.hash);
    }
    laneByHash.set(commit.hash, lane);
    activeLanes.splice(lane, 1);

    const visibleParents = commit.parents.filter((parent) =>
      displayedHashes.has(parent),
    );
    visibleParents.forEach((parent, index) => {
      if (!activeLanes.includes(parent)) {
        activeLanes.splice(lane + index, 0, parent);
      }
    });
  }

  const nodes = commits.map((commit, index) => ({
    commit,
    x: paddingX + (commits.length - index - 1) * xStep,
    y: paddingY + (laneByHash.get(commit.hash) ?? 0) * yStep,
  }));
  const nodeByHash = new Map(nodes.map((node) => [node.commit.hash, node]));
  const edges: GitGraphEdge[] = [];
  for (const child of nodes) {
    for (const parentHash of child.commit.parents) {
      const parent = nodeByHash.get(parentHash);
      if (parent) edges.push({ child, parent });
    }
  }
  const maxLane = Math.max(
    0,
    ...nodes.map((node) => (node.y - paddingY) / yStep),
  );

  return {
    nodes,
    edges,
    width: Math.max(
      560,
      paddingX * 2 + Math.max(0, commits.length - 1) * xStep,
    ),
    height: Math.max(112, paddingY * 2 + maxLane * yStep),
  };
}

function commitAncestorRelation(
  commits: GitGraphCommit[],
  ancestorHash: string,
  descendantHash: string,
): CommitAncestorRelation {
  if (ancestorHash === descendantHash) return "yes";
  const commitsByHash = new Map(commits.map((commit) => [commit.hash, commit]));
  const pending = [descendantHash];
  const visited = new Set<string>();
  let graphIsIncomplete = false;

  while (pending.length > 0) {
    const hash = pending.pop();
    if (!hash || visited.has(hash)) continue;
    visited.add(hash);
    const commit = commitsByHash.get(hash);
    if (!commit) {
      graphIsIncomplete = true;
      continue;
    }
    for (const parent of commit.parents) {
      if (parent === ancestorHash) return "yes";
      pending.push(parent);
    }
  }

  return graphIsIncomplete ? "unknown" : "no";
}

function rebasePushRecommendation(
  status: GitPanelStatus | null,
  commits: GitGraphCommit[],
  targetHash: string | null,
): "normal" | "force" | null {
  if (!targetHash) return null;
  if (!status?.upstream_branch) return "normal";

  const head = commits.find((commit) => commit.is_head);
  if (!head) return "normal";
  const upstream = commits.find((commit) =>
    commit.refs.some(
      (reference) =>
        reference === status.upstream_branch ||
        reference.replace(/^HEAD -> /, "") === status.upstream_branch,
    ),
  );
  const remoteHash =
    upstream?.hash ??
    ((status.ahead ?? 0) === 0 && (status.behind ?? 0) === 0
      ? head.hash
      : null);
  if (!remoteHash) return "normal";

  const targetAlreadyBasesHead = commitAncestorRelation(
    commits,
    targetHash,
    head.hash,
  );
  if (targetAlreadyBasesHead === "unknown") return "normal";

  const predictedBase =
    targetAlreadyBasesHead === "yes" ? head.hash : targetHash;
  return commitAncestorRelation(commits, remoteHash, predictedBase) === "no"
    ? "force"
    : "normal";
}

function formatGraphCommitTime(timestamp: number, full = false) {
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(
    undefined,
    full
      ? { dateStyle: "medium", timeStyle: "short" }
      : {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        },
  ).format(date);
}

export const GitActionsControl = memo(function GitActionsControl({
  projectPath,
}: {
  projectPath: string | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rebaseGraphScrollRef = useRef<HTMLDivElement | null>(null);
  const files = useDocumentStore((s) => s.files);
  const isGitOperationRunning = useDocumentStore(
    (s) => s.isGitOperationRunning,
  );
  const hasUnresolvedAiSuggestions = useProposedChangesStore(
    (state) => state.changes.length > 0 || !!state.workspaceReview,
  );
  const [status, setStatus] = useState<GitPanelStatus | null>(null);
  const [changedFiles, setChangedFiles] = useState<GitChangedFile[]>([]);
  const [lineStatsByPath, setLineStatsByPath] = useState<
    Record<string, GitFileLineStats>
  >({});
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [resetSelectedFiles, setResetSelectedFiles] = useState<string[]>([]);
  const [isCommitDialogOpen, setIsCommitDialogOpen] = useState(false);
  const [historyProject, setHistoryProject] = useState<string | null>(null);
  const [isStashPullDialogOpen, setIsStashPullDialogOpen] = useState(false);
  const [isStashDialogOpen, setIsStashDialogOpen] = useState(false);
  const [isResetDialogOpen, setIsResetDialogOpen] = useState(false);
  const [isSetupDialogOpen, setIsSetupDialogOpen] = useState(false);
  const [showGitCommand, setShowGitCommand] = useState(false);
  const [isRebaseDialogOpen, setIsRebaseDialogOpen] = useState(false);
  const [rebaseCommits, setRebaseCommits] = useState<GitGraphCommit[]>([]);
  const [selectedRebaseTarget, setSelectedRebaseTarget] = useState<
    string | null
  >(null);
  const [rebasePreviewError, setRebasePreviewError] = useState<string | null>(
    null,
  );
  const [isRebaseLoading, setIsRebaseLoading] = useState(false);
  const [isRebasing, setIsRebasing] = useState(false);
  const [rebaseStep, setRebaseStep] = useState<
    "rebase" | "rebase_and_push" | "rebase_and_force_push"
  >("rebase");
  const [isRemoteUpdateOpen, setIsRemoteUpdateOpen] = useState(false);
  const [isRemoteUpdateRunning, setIsRemoteUpdateRunning] = useState(false);
  const [isPushRecoveryOpen, setIsPushRecoveryOpen] = useState(false);
  const [pushRecoveryPreview, setPushRecoveryPreview] =
    useState<GitPushRecoveryPreview | null>(null);
  const [pushRecoveryPreviewError, setPushRecoveryPreviewError] = useState<
    string | null
  >(null);
  const [isPushRecoveryLoading, setIsPushRecoveryLoading] = useState(false);
  const [isPushRecoveryRunning, setIsPushRecoveryRunning] = useState(false);
  const [pushRecoveryAction, setPushRecoveryAction] = useState<
    "pull" | "pull_push" | "force"
  >("pull");
  const [draftCommit, setDraftCommit] = useState(false);
  const [nextStep, setNextStep] = useState<"commit" | "commit_and_push">(
    "commit",
  );
  const [pullStep, setPullStep] = useState<"pull" | "pull_pop" | "pull_apply">(
    "pull",
  );
  const [stashStep, setStashStep] = useState<"apply" | "pop" | "drop">("apply");
  const [commitMessage, setCommitMessage] = useState("");
  const [stashMessage, setStashMessage] = useState("");
  const [pullStashSelectedFiles, setPullStashSelectedFiles] = useState<
    string[]
  >([]);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [selectedStashRef, setSelectedStashRef] = useState<string | null>(null);
  const [selectedStashFiles, setSelectedStashFiles] = useState<string[]>([]);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [isStashPulling, setIsStashPulling] = useState(false);
  const [isStashRunning, setIsStashRunning] = useState(false);
  const [isStashListLoading, setIsStashListLoading] = useState(false);
  const [isStashFilesLoading, setIsStashFilesLoading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isAbortingOperation, setIsAbortingOperation] = useState(false);
  const [isCheckingPull, setIsCheckingPull] = useState(false);
  const [canPullAvailable, setCanPullAvailable] = useState(false);
  const [pullBehindCount, setPullBehindCount] = useState(0);
  const [pullBehindCommits, setPullBehindCommits] = useState<string[]>([]);
  const [isCompact, setIsCompact] = useState(false);
  const pullCheckRequestIdRef = useRef(0);
  const actionAvailabilityRequestIdRef = useRef(0);

  const hasRepo = Boolean(projectPath) && Boolean(status?.repo_found);
  const hasConflicts = (status?.conflicted ?? 0) > 0;
  const hasOperation = Boolean(status?.operation);
  const canPush =
    hasRepo && (status?.can_push ?? true) && !hasConflicts && !hasOperation;
  const gitStatsRefreshKey = useMemo(
    () =>
      files
        .map((file) => `${file.relativePath}:${file.isDirty ? 1 : 0}`)
        .join("|"),
    [files],
  );

  useEffect(() => {
    if (!projectPath || !status?.conflicted) return;
    let cancelled = false;
    void ensureConflictFiles(projectPath, () => !cancelled).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectPath, status?.conflicted, gitStatsRefreshKey]);

  const refreshActionAvailability = useCallback(async () => {
    const requestId = ++actionAvailabilityRequestIdRef.current;
    if (!projectPath) {
      setStatus(null);
      setChangedFiles([]);
      setSelectedFiles([]);
      setResetSelectedFiles([]);
      setPullStashSelectedFiles([]);
      setStashes([]);
      setSelectedStashRef(null);
      setSelectedStashFiles([]);
      setPullBehindCommits([]);
      return;
    }
    try {
      const [nextStatus, nextChangedFiles] = await Promise.all([
        invoke<GitPanelStatus>("git_panel_status", {
          projectRoot: projectPath,
        }),
        invoke<GitChangedFile[]>("git_panel_changed_files", {
          projectRoot: projectPath,
        }),
      ]);
      const safeChangedFiles = Array.isArray(nextChangedFiles)
        ? nextChangedFiles
        : [];
      if (requestId !== actionAvailabilityRequestIdRef.current) return;
      setStatus(nextStatus);
      setChangedFiles(safeChangedFiles);
      const available = new Set(safeChangedFiles.map((file) => file.path));
      setSelectedFiles((prev) => prev.filter((path) => available.has(path)));
      setResetSelectedFiles((prev) =>
        prev.filter((path) => available.has(path)),
      );
    } catch {
      // Keep this silent; this runs as passive sync tied to file-panel updates.
    }
  }, [projectPath]);

  const refreshStatus = useCallback(
    async (options: RefreshStatusOptions = {}) => {
      if (!projectPath) {
        setStatus(null);
        setChangedFiles([]);
        setLineStatsByPath({});
        setSelectedFiles([]);
        setResetSelectedFiles([]);
        setPullStashSelectedFiles([]);
        setStashes([]);
        setSelectedStashRef(null);
        setSelectedStashFiles([]);
        setPullBehindCommits([]);
        setCanPullAvailable(false);
        setPullBehindCount(0);
        setIsCheckingPull(false);
        return;
      }
      try {
        const [nextStatus, nextChangedFiles, nextLineStats] = await Promise.all(
          [
            invoke<GitPanelStatus>("git_panel_status", {
              projectRoot: projectPath,
            }),
            invoke<GitChangedFile[]>("git_panel_changed_files", {
              projectRoot: projectPath,
            }),
            invoke<GitFileLineStats[]>("git_worktree_file_line_stats", {
              projectRoot: projectPath,
            }),
          ],
        );
        const safeChangedFiles = Array.isArray(nextChangedFiles)
          ? nextChangedFiles
          : [];
        const safeLineStats = Array.isArray(nextLineStats) ? nextLineStats : [];
        setStatus(nextStatus);
        setChangedFiles(safeChangedFiles);
        const lineStatsMap = Object.fromEntries(
          safeLineStats.map((stat) => [
            stat.file_path.replace(/\\/g, "/"),
            stat,
          ]),
        );
        setLineStatsByPath(lineStatsMap);
        const allPaths = safeChangedFiles.map((file) => file.path);
        if (options.selectAllCommitFiles) {
          setSelectedFiles(allPaths);
        } else {
          const available = new Set(safeChangedFiles.map((file) => file.path));
          setSelectedFiles((prev) =>
            prev.filter((path) => available.has(path)),
          );
        }
        if (options.selectAllResetFiles) {
          setResetSelectedFiles(allPaths);
        } else {
          const available = new Set(safeChangedFiles.map((file) => file.path));
          setResetSelectedFiles((prev) =>
            prev.filter((path) => available.has(path)),
          );
        }
      } catch (error) {
        toast.error(formatError(error));
      }
    },
    [projectPath],
  );

  const handleRepositoryReady = useCallback(async () => {
    await useDocumentStore.getState().refreshFiles();
    await refreshStatus();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
    }
  }, [refreshStatus]);

  const refreshRepositoryView = useCallback(
    async (reloadFiles = true) => {
      if (reloadFiles) await useDocumentStore.getState().refreshFiles();
      await refreshStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
      }
    },
    [refreshStatus],
  );

  useEffect(() => {
    void refreshActionAvailability();
  }, [gitStatsRefreshKey, projectPath, refreshActionAvailability]);

  useEffect(() => {
    if (!hasUnresolvedAiSuggestions) return;
    setIsCommitDialogOpen(false);
    setHistoryProject(null);
    setIsStashPullDialogOpen(false);
    setIsStashDialogOpen(false);
    setIsResetDialogOpen(false);
    setIsSetupDialogOpen(false);
    setIsRebaseDialogOpen(false);
    setIsRemoteUpdateOpen(false);
    setIsPushRecoveryOpen(false);
  }, [hasUnresolvedAiSuggestions]);

  useEffect(() => {
    setHistoryProject(null);
    setIsRebaseDialogOpen(false);
    setRebaseCommits([]);
    setSelectedRebaseTarget(null);
    setRebasePreviewError(null);
    setIsRebaseLoading(false);
    setIsRebasing(false);
    setRebaseStep("rebase");
    setIsRemoteUpdateOpen(false);
    setIsRemoteUpdateRunning(false);
    setIsPushRecoveryOpen(false);
    setPushRecoveryPreview(null);
    setPushRecoveryPreviewError(null);
    setIsPushRecoveryLoading(false);
    setIsPushRecoveryRunning(false);
  }, [projectPath]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleGitStatsRefresh = () => {
      void refreshActionAvailability();
    };
    window.addEventListener(GIT_STATS_REFRESH_EVENT, handleGitStatsRefresh);
    return () => {
      window.removeEventListener(
        GIT_STATS_REFRESH_EVENT,
        handleGitStatsRefresh,
      );
    };
  }, [refreshActionAvailability]);

  useEffect(() => {
    if (!isRebaseDialogOpen || isRebaseLoading || rebaseCommits.length === 0)
      return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = rebaseGraphScrollRef.current;
      if (viewport) viewport.scrollLeft = viewport.scrollWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isRebaseDialogOpen, isRebaseLoading, rebaseCommits.length]);

  const recomputeCompactMode = useCallback(() => {
    const rootEl = rootRef.current;
    if (!rootEl) return;
    const compactRoot = rootEl.closest<HTMLElement>(
      "[data-git-actions-compact-root]",
    );
    if (!compactRoot) {
      setIsCompact(false);
      return;
    }
    const containerWidth = compactRoot.clientWidth;
    const thresholdAttr = compactRoot.getAttribute(
      "data-git-actions-compact-threshold",
    );
    const parsedThreshold = thresholdAttr
      ? Number.parseInt(thresholdAttr, 10)
      : NaN;
    const widthThreshold = Number.isFinite(parsedThreshold)
      ? parsedThreshold
      : 620;
    const isOverflowing = compactRoot.scrollWidth > compactRoot.clientWidth + 1;
    const overlapAnchor = compactRoot.querySelector<HTMLElement>(
      "[data-git-actions-overlap-anchor]",
    );
    const anchorCrowded = overlapAnchor
      ? overlapAnchor.scrollWidth > overlapAnchor.clientWidth + 1
      : false;
    setIsCompact(
      containerWidth <= widthThreshold || isOverflowing || anchorCrowded,
    );
  }, []);

  useEffect(() => {
    recomputeCompactMode();
    const rootEl = rootRef.current;
    if (!rootEl) return;
    const compactRoot = rootEl.closest<HTMLElement>(
      "[data-git-actions-compact-root]",
    );
    if (!compactRoot) return;

    if (typeof window !== "undefined") {
      window.addEventListener("resize", recomputeCompactMode);
    }

    if (typeof ResizeObserver === "undefined") {
      return () => {
        if (typeof window !== "undefined") {
          window.removeEventListener("resize", recomputeCompactMode);
        }
      };
    }

    const observer = new ResizeObserver(() => {
      recomputeCompactMode();
    });
    observer.observe(compactRoot);
    observer.observe(rootEl);

    return () => {
      observer.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", recomputeCompactMode);
      }
    };
  }, [recomputeCompactMode, gitStatsRefreshKey, projectPath]);

  const trackedChangedFiles = useMemo(
    () => changedFiles.filter((file) => !file.untracked),
    [changedFiles],
  );
  const conflictedFiles = useMemo(
    () => changedFiles.filter((file) => file.conflicted),
    [changedFiles],
  );

  useEffect(() => {
    if (!isStashPullDialogOpen) return;
    const available = new Set(trackedChangedFiles.map((file) => file.path));
    const trackedPaths = trackedChangedFiles.map((file) => file.path);
    setPullStashSelectedFiles((prev) => {
      const filtered = prev.filter((path) => available.has(path));
      const next =
        filtered.length > 0 || trackedPaths.length === 0
          ? filtered
          : trackedPaths;
      if (
        prev.length === next.length &&
        prev.every((path, idx) => path === next[idx])
      ) {
        return prev;
      }
      return next;
    });
  }, [isStashPullDialogOpen, trackedChangedFiles]);

  useEffect(() => {
    if (!isStashDialogOpen || !selectedStashRef || !projectPath || !hasRepo) {
      setSelectedStashFiles([]);
      return;
    }
    let cancelled = false;
    setIsStashFilesLoading(true);
    void invoke<string[]>("git_panel_stash_files", {
      projectRoot: projectPath,
      stashRef: selectedStashRef,
    })
      .then((nextFiles) => {
        if (cancelled) return;
        setSelectedStashFiles(nextFiles);
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedStashFiles([]);
        toast.error(formatError(error));
      })
      .finally(() => {
        if (cancelled) return;
        setIsStashFilesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hasRepo, isStashDialogOpen, projectPath, selectedStashRef]);

  const totalChanges =
    (status?.staged ?? 0) +
    (status?.unstaged ?? 0) +
    (status?.untracked ?? 0) +
    (status?.conflicted ?? 0);
  const isMergeOperation = status?.operation === "merge";
  const isRebaseOperation = status?.operation === "rebase";
  const isManagedOperation = isMergeOperation || isRebaseOperation;
  const canOpenCommit =
    hasRepo &&
    (totalChanges > 0 || isMergeOperation) &&
    (!status?.operation || status.operation === "merge");
  const canReset = hasRepo && totalChanges > 0;
  const canPull =
    hasRepo &&
    canPullAvailable &&
    !isCheckingPull &&
    !hasConflicts &&
    !hasOperation;
  const isBusy =
    isGitOperationRunning ||
    isCommitting ||
    isPushing ||
    isStashPulling ||
    isResetting ||
    isStashRunning ||
    isAbortingOperation ||
    isRemoteUpdateRunning ||
    isPushRecoveryRunning ||
    isRebasing;
  const selectedCount = selectedFiles.length;
  const allSelected =
    changedFiles.length > 0 && selectedFiles.length === changedFiles.length;
  const resetSelectedCount = resetSelectedFiles.length;
  const allResetSelected =
    changedFiles.length > 0 &&
    resetSelectedFiles.length === changedFiles.length;
  const pullStashSelectedCount = pullStashSelectedFiles.length;
  const hasTrackedFilesToStash = trackedChangedFiles.length > 0;
  const allPullStashSelected =
    trackedChangedFiles.length > 0 &&
    pullStashSelectedFiles.length === trackedChangedFiles.length;
  const canContinuePull = hasRepo && !isStashPulling;
  const canRunStashAction =
    hasRepo &&
    !isStashRunning &&
    Boolean(selectedStashRef) &&
    stashes.length > 0;
  const canContinueCommit =
    hasRepo &&
    (isMergeOperation ? !hasConflicts : selectedCount > 0) &&
    !isBusy;
  const allConflictsSelected = conflictedFiles.every((file) =>
    selectedFiles.includes(file.path),
  );
  const canFinishCommit =
    canContinueCommit && (isMergeOperation || allConflictsSelected);
  const canContinueReset = hasRepo && resetSelectedCount > 0 && !isBusy;
  const canStartRebase =
    hasRepo && totalChanges === 0 && !hasOperation && !isBusy;
  const isAbortManagedOperationAction = isManagedOperation && hasConflicts;
  const isAbortMergeAction = isMergeOperation && hasConflicts;
  const abortOperationSurfaceClass = isMergeOperation
    ? "bg-[#ef4444] text-white"
    : "bg-red-100 text-red-700 dark:bg-red-600/20 dark:text-red-300";
  const abortOperationButtonClass = isMergeOperation
    ? "text-white hover:bg-[#dc3e3e] hover:text-white focus-visible:ring-red-300/60 dark:text-white dark:focus-visible:ring-red-400/40 dark:hover:bg-[#dc3e3e] dark:hover:text-white"
    : "text-red-700 hover:bg-red-200 hover:text-red-700 focus-visible:ring-red-300/60 dark:text-red-300 dark:focus-visible:ring-red-400/40 dark:hover:bg-red-600/30 dark:hover:text-red-300";
  const canFinishMerge = isMergeOperation && !hasConflicts && canOpenCommit;
  const canContinueRebase = isRebaseOperation && !hasConflicts;
  const needsRemoteUpdate =
    (status?.ahead ?? 0) > 0 &&
    (status?.behind ?? 0) > 0 &&
    Boolean(status?.upstream_branch);
  const showPrimaryPushAction =
    hasRepo && !isManagedOperation && !canOpenCommit && canPush;
  const canRunPrimaryAction = hasRepo
    ? isMergeOperation
      ? hasConflicts || canFinishMerge
      : isRebaseOperation
        ? hasConflicts || canContinueRebase
        : showPrimaryPushAction
          ? canPush
          : canOpenCommit
    : Boolean(projectPath) && status !== null;
  const primaryActionLabel = !hasRepo
    ? "Set up Git"
    : isMergeOperation
      ? hasConflicts
        ? "Abort merge"
        : "Finish merge"
      : isRebaseOperation
        ? hasConflicts
          ? "Abort rebase"
          : "Continue rebase"
        : showPrimaryPushAction
          ? needsRemoteUpdate
            ? "Update remote"
            : "Push"
          : "Commit";

  const generatedCommitMessage = useMemo(() => {
    if (status?.operation) return `Complete ${status.operation}`;
    const count = selectedCount || totalChanges;
    if (!hasRepo || count <= 0) return "chore: update workspace";
    const noun = count === 1 ? "file" : "files";
    const prefix = draftCommit ? "draft" : "chore";
    return `${prefix}: update ${count} ${noun}`;
  }, [draftCommit, hasRepo, selectedCount, status?.operation, totalChanges]);

  const rebaseGraph = useMemo(
    () => layoutGitGraph(rebaseCommits),
    [rebaseCommits],
  );
  const selectedRebaseCommit = useMemo(
    () =>
      rebaseCommits.find((commit) => commit.hash === selectedRebaseTarget) ??
      null,
    [rebaseCommits, selectedRebaseTarget],
  );
  const recommendedRebasePush = useMemo(
    () => rebasePushRecommendation(status, rebaseCommits, selectedRebaseTarget),
    [rebaseCommits, selectedRebaseTarget, status],
  );

  const filesToCommit = isMergeOperation
    ? changedFiles.map((file) => file.path)
    : selectedFiles;
  const effectiveCommitMessage = commitMessage.trim() || generatedCommitMessage;
  const commitCommands = [
    ...(filesToCommit.length > 0
      ? [formatGitCommand(["add", "--", ...filesToCommit])]
      : []),
    formatGitCommand([
      "commit",
      "-m",
      effectiveCommitMessage,
      ...(isMergeOperation ? ["--allow-empty"] : ["--", ...filesToCommit]),
    ]),
    ...(nextStep === "commit_and_push" ? [formatPushCommand(status)] : []),
  ];
  const rebaseCommands = [
    selectedRebaseTarget
      ? formatGitCommand(["rebase", selectedRebaseTarget])
      : "git rebase <selected-commit>",
    ...(rebaseStep === "rebase_and_push"
      ? [formatPushCommand(status)]
      : rebaseStep === "rebase_and_force_push"
        ? [
            formatGitCommand([
              "fetch",
              status?.upstream_branch?.split("/")[0] ?? "origin",
            ]),
            formatPushCommand(status, true),
          ]
        : []),
  ];
  const remoteName = status?.upstream_branch?.split("/")[0] ?? "origin";
  const forcePushCommands = [
    formatGitCommand(["fetch", remoteName]),
    formatPushCommand(status, true),
  ];
  const canPullMergePush =
    !isPushRecoveryLoading &&
    !pushRecoveryPreviewError &&
    pushRecoveryPreview !== null &&
    pushRecoveryPreview.conflicted_files.length === 0;
  const pushRecoveryCommands =
    pushRecoveryAction === "force"
      ? [
          formatGitCommand([
            "fetch",
            pushRecoveryPreview?.remote_name ?? remoteName,
          ]),
          formatPushCommand(status, true),
        ]
      : [
          formatGitCommand(["pull", "--no-rebase"]),
          ...(pushRecoveryAction === "pull_push"
            ? [formatPushCommand(status)]
            : []),
        ];
  const pullCommands = [
    ...(pullStashSelectedFiles.length > 0
      ? [
          formatGitCommand([
            "stash",
            "push",
            ...(stashMessage.trim() ? ["-m", stashMessage.trim()] : []),
            "--",
            ...pullStashSelectedFiles,
          ]),
        ]
      : []),
    formatGitCommand(["pull", "--no-rebase"]),
    ...(pullStashSelectedFiles.length > 0 && pullStep !== "pull"
      ? [
          formatGitCommand([
            "stash",
            pullStep === "pull_pop" ? "pop" : "apply",
            "stash@{0}",
          ]),
        ]
      : []),
  ];
  const stashCommands = selectedStashRef
    ? [formatGitCommand(["stash", stashStep, selectedStashRef])]
    : [];
  const resetTrackedFiles = changedFiles
    .filter((file) => resetSelectedFiles.includes(file.path) && !file.untracked)
    .map((file) => file.path);
  const resetUntrackedFiles = changedFiles
    .filter((file) => resetSelectedFiles.includes(file.path) && file.untracked)
    .map((file) => file.path);
  const resetCommands = [
    ...(resetTrackedFiles.length > 0
      ? [
          formatGitCommand([
            "restore",
            "--source=HEAD",
            "--staged",
            "--worktree",
            "--",
            ...resetTrackedFiles,
          ]),
        ]
      : []),
    ...(resetUntrackedFiles.length > 0
      ? [formatGitCommand(["clean", "-fd", "--", ...resetUntrackedFiles])]
      : []),
  ];

  const openCommitDialog = useCallback(() => {
    setNextStep("commit");
    setIsCommitDialogOpen(true);
    void refreshStatus({ selectAllCommitFiles: true });
  }, [refreshStatus]);

  const toggleFileSelection = useCallback((path: string) => {
    setSelectedFiles((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedFiles((prev) =>
      prev.length === changedFiles.length
        ? []
        : changedFiles.map((file) => file.path),
    );
  }, [changedFiles]);

  const openResetDialog = useCallback(() => {
    setIsResetDialogOpen(true);
    void refreshStatus({ selectAllResetFiles: true });
  }, [refreshStatus]);

  const toggleResetFileSelection = useCallback((path: string) => {
    setResetSelectedFiles((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  const toggleResetSelectAll = useCallback(() => {
    setResetSelectedFiles((prev) =>
      prev.length === changedFiles.length
        ? []
        : changedFiles.map((file) => file.path),
    );
  }, [changedFiles]);

  const openPullDialog = useCallback(() => {
    setPullStep("pull");
    setIsStashPullDialogOpen(true);
    setPullStashSelectedFiles(trackedChangedFiles.map((file) => file.path));
    void refreshStatus();
  }, [refreshStatus, trackedChangedFiles]);

  const togglePullStashFileSelection = useCallback((path: string) => {
    setPullStashSelectedFiles((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path],
    );
  }, []);

  const togglePullStashSelectAll = useCallback(() => {
    setPullStashSelectedFiles((prev) =>
      prev.length === trackedChangedFiles.length
        ? []
        : trackedChangedFiles.map((file) => file.path),
    );
  }, [trackedChangedFiles]);

  const refreshStashList = useCallback(async () => {
    if (!projectPath || !hasRepo) {
      setStashes([]);
      setSelectedStashRef(null);
      setSelectedStashFiles([]);
      return;
    }
    setIsStashListLoading(true);
    try {
      const nextStashes = await invoke<GitStashEntry[]>(
        "git_panel_stash_list",
        {
          projectRoot: projectPath,
        },
      );
      setStashes(nextStashes);
      setSelectedStashRef((prev) => {
        if (nextStashes.length === 0) return null;
        if (prev && nextStashes.some((stash) => stash.reference === prev))
          return prev;
        return nextStashes[0]?.reference ?? null;
      });
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setIsStashListLoading(false);
    }
  }, [hasRepo, projectPath]);

  const openStashDialog = useCallback(() => {
    setStashStep("apply");
    setIsStashDialogOpen(true);
    void refreshStashList();
  }, [refreshStashList]);

  const openRebaseDialog = useCallback(async () => {
    if (!projectPath || !hasRepo) return;
    setRebaseCommits([]);
    setSelectedRebaseTarget(null);
    setRebasePreviewError(null);
    setRebaseStep("rebase");
    setIsRebaseDialogOpen(true);
    setIsRebaseLoading(true);
    try {
      const commits = await invoke<GitGraphCommit[]>("git_panel_graph", {
        projectRoot: projectPath,
        limit: 40,
      });
      setRebaseCommits(Array.isArray(commits) ? commits : []);
    } catch (error) {
      setRebasePreviewError(formatError(error));
    } finally {
      setIsRebaseLoading(false);
    }
  }, [hasRepo, projectPath]);

  const runRebase = useCallback(async () => {
    if (!projectPath || !selectedRebaseTarget || isRebaseLoading || isRebasing)
      return;
    setIsRebasing(true);
    try {
      const result = await runWorkingTreeGitAction(
        "git_panel_rebase_onto",
        {
          projectRoot: projectPath,
          targetCommit: selectedRebaseTarget,
        },
        "rebase",
      );
      setIsRebaseDialogOpen(false);
      if (result.success) {
        if (
          rebaseStep === "rebase_and_push" ||
          rebaseStep === "rebase_and_force_push"
        ) {
          try {
            const pushResult = await runRemoteGitAction(
              rebaseStep === "rebase_and_force_push"
                ? "git_panel_force_push"
                : "git_panel_push",
              { projectRoot: projectPath },
            );
            toast.success(`${result.message}. ${pushResult.message}`);
          } catch (error) {
            toast.error(
              `${result.message}. Push failed: ${formatError(error)}`,
              { duration: 10_000 },
            );
          }
        } else {
          toast.success(result.message);
        }
      } else {
        toast.error(result.message, { duration: 10_000 });
      }
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsRebasing(false);
    }
  }, [
    isRebaseLoading,
    isRebasing,
    projectPath,
    rebaseStep,
    refreshRepositoryView,
    selectedRebaseTarget,
  ]);

  const runContinueRebase = useCallback(async () => {
    if (!projectPath || !isRebaseOperation || hasConflicts || isBusy) return;
    setIsRebasing(true);
    try {
      const result = await runWorkingTreeGitAction(
        "git_panel_continue_rebase",
        { projectRoot: projectPath },
        "continue rebase",
      );
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message, { duration: 10_000 });
      }
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsRebasing(false);
    }
  }, [
    hasConflicts,
    isBusy,
    isRebaseOperation,
    projectPath,
    refreshRepositoryView,
  ]);

  const openPushRecovery = useCallback(async () => {
    if (!projectPath) return;
    setPushRecoveryPreview(null);
    setPushRecoveryPreviewError(null);
    setPushRecoveryAction("pull");
    setIsPushRecoveryOpen(true);
    setIsPushRecoveryLoading(true);
    try {
      const preview = await invoke<GitPushRecoveryPreview>(
        "git_panel_push_recovery_preview",
        { projectRoot: projectPath },
      );
      setPushRecoveryPreview(preview);
      setPushRecoveryAction(
        preview.conflicted_files.length === 0 ? "pull_push" : "pull",
      );
    } catch {
      setPushRecoveryPreviewError(
        "The conflict preview is unavailable. You can still pull and merge, or cancel and try again.",
      );
    } finally {
      setIsPushRecoveryLoading(false);
    }
  }, [projectPath]);

  const runPushRecoveryPull = useCallback(
    async (pushAfterPull: boolean) => {
      if (!projectPath || isPushRecoveryLoading || isPushRecoveryRunning)
        return;
      if (pushAfterPull && !canPullMergePush) return;
      setIsPushRecoveryRunning(true);
      let pulled = false;
      try {
        const result = await runWorkingTreeGitAction(
          "git_panel_pull",
          {
            projectRoot: projectPath,
          },
          "pull",
        );
        setIsPushRecoveryOpen(false);
        if (result.success) {
          if (pushAfterPull) {
            pulled = true;
            const pushResult = await runRemoteGitAction("git_panel_push", {
              projectRoot: projectPath,
            });
            toast.success(`${result.message}. ${pushResult.message}`);
          } else {
            toast.success(result.message);
          }
        } else {
          toast.error(result.message, { duration: 10_000 });
        }
        await refreshRepositoryView();
      } catch (error) {
        if (pulled && isRemoteAheadPushError(error)) {
          await openPushRecovery();
        } else {
          toast.error(
            pulled
              ? `Pull and merge completed, but push failed: ${formatError(error)}`
              : formatError(error),
            { duration: 10_000 },
          );
        }
        await refreshRepositoryView();
      } finally {
        setIsPushRecoveryRunning(false);
      }
    },
    [
      canPullMergePush,
      isPushRecoveryLoading,
      isPushRecoveryRunning,
      openPushRecovery,
      projectPath,
      refreshRepositoryView,
    ],
  );

  const runPushRecoveryForce = useCallback(async () => {
    if (!projectPath || isPushRecoveryLoading || isPushRecoveryRunning) return;
    setIsPushRecoveryRunning(true);
    try {
      const result = await runRemoteGitAction("git_panel_force_push", {
        projectRoot: projectPath,
      });
      toast.success(result.message);
      setIsPushRecoveryOpen(false);
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setIsPushRecoveryRunning(false);
    }
  }, [
    isPushRecoveryLoading,
    isPushRecoveryRunning,
    projectPath,
    refreshRepositoryView,
  ]);

  const runUpdateRemote = useCallback(async () => {
    if (!projectPath || !needsRemoteUpdate || isBusy) return;
    setIsRemoteUpdateRunning(true);
    try {
      await runRemoteGitAction("git_panel_force_push", {
        projectRoot: projectPath,
      });
      toast.success("Remote updated");
      setIsRemoteUpdateOpen(false);
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsRemoteUpdateRunning(false);
    }
  }, [isBusy, needsRemoteUpdate, projectPath, refreshRepositoryView]);

  const runPush = useCallback(async () => {
    if (!projectPath || !canPush || needsRemoteUpdate || isBusy) return;
    setIsPushing(true);
    try {
      const result = await runRemoteGitAction("git_panel_push", {
        projectRoot: projectPath,
      });
      toast.success(result.message);
      await useDocumentStore.getState().refreshFiles();
      await refreshStatus();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(GIT_STATS_REFRESH_EVENT));
      }
    } catch (error) {
      if (isRemoteAheadPushError(error)) {
        await openPushRecovery();
      } else {
        toast.error(formatError(error));
      }
    } finally {
      setIsPushing(false);
    }
  }, [
    canPush,
    isBusy,
    needsRemoteUpdate,
    openPushRecovery,
    projectPath,
    refreshStatus,
  ]);

  const checkPullAvailability = useCallback(async () => {
    const requestId = ++pullCheckRequestIdRef.current;
    if (!projectPath || hasConflicts || hasOperation) {
      setCanPullAvailable(false);
      setPullBehindCount(0);
      setPullBehindCommits([]);
      return;
    }

    setIsCheckingPull(true);
    try {
      const result = await invoke<GitPullStatus>("git_panel_pull_status", {
        projectRoot: projectPath,
      });
      if (pullCheckRequestIdRef.current !== requestId) return;
      setCanPullAvailable(result.can_pull);
      setPullBehindCount(result.behind);
      setPullBehindCommits(result.behind_commits ?? []);
    } catch (error) {
      if (pullCheckRequestIdRef.current !== requestId) return;
      setCanPullAvailable(false);
      setPullBehindCount(0);
      setPullBehindCommits([]);
      toast.error(formatError(error));
    } finally {
      if (pullCheckRequestIdRef.current === requestId) {
        setIsCheckingPull(false);
      }
    }
  }, [hasConflicts, hasOperation, projectPath]);

  const runCommit = useCallback(
    async (pushAfterCommit: boolean) => {
      if (
        !projectPath ||
        !hasRepo ||
        isBusy ||
        (selectedFiles.length === 0 && !isMergeOperation)
      )
        return;
      const filesToCommit = isMergeOperation
        ? changedFiles.map((file) => file.path)
        : selectedFiles;
      const message = commitMessage.trim() || generatedCommitMessage;
      setIsCommitting(true);
      let committed = false;
      try {
        const commitResult = await useDocumentStore
          .getState()
          .runGitOperation(
            projectPath,
            { saveFiles: filesToCommit, history: { label: "commit" } },
            () =>
              invoke<GitCommandResult>("git_panel_commit_selected", {
                projectRoot: projectPath,
                message,
                selectedFiles: filesToCommit,
              }),
          );
        committed = true;
        if (commitResult.message !== "Nothing to commit") {
          useProposedChangesStore
            .getState()
            .resolveChangesForFiles(filesToCommit);
        }
        // The local commit is complete even if the following push fails.
        setCommitMessage("");
        setIsCommitDialogOpen(false);
        if (pushAfterCommit) {
          const pushResult = await runRemoteGitAction("git_panel_push", {
            projectRoot: projectPath,
          });
          toast.success(`${commitResult.message}. ${pushResult.message}`);
        } else {
          toast.success(commitResult.message);
        }
        await refreshRepositoryView(false);
      } catch (error) {
        if (committed && pushAfterCommit && isRemoteAheadPushError(error)) {
          await openPushRecovery();
        } else {
          toast.error(
            committed && pushAfterCommit
              ? `Commit completed, but push failed: ${formatError(error)}`
              : formatError(error),
            { duration: 10_000 },
          );
        }
        await refreshRepositoryView(false);
      } finally {
        setIsCommitting(false);
      }
    },
    [
      changedFiles,
      commitMessage,
      generatedCommitMessage,
      hasRepo,
      isBusy,
      isMergeOperation,
      openPushRecovery,
      projectPath,
      refreshRepositoryView,
      selectedFiles,
    ],
  );

  const runPullFlow = useCallback(async () => {
    if (!projectPath || !hasRepo || isBusy) return;
    setIsStashPulling(true);
    try {
      const reapplyMode =
        pullStep === "pull_pop"
          ? "pop"
          : pullStep === "pull_apply"
            ? "apply"
            : "none";
      const result = await runWorkingTreeGitAction(
        "git_panel_pull_flow",
        {
          projectRoot: projectPath,
          message: stashMessage.trim() ? stashMessage.trim() : null,
          stashSelectedFiles: pullStashSelectedFiles,
          reapplyMode,
        },
        "stash and pull",
      );
      if (result.success) {
        toast.success(result.message);
        setStashMessage("");
      } else {
        toast.error(result.message, { duration: 10_000 });
      }
      setIsStashPullDialogOpen(false);
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsStashPulling(false);
    }
  }, [
    hasRepo,
    isBusy,
    projectPath,
    pullStashSelectedFiles,
    pullStep,
    refreshRepositoryView,
    stashMessage,
  ]);

  const runReset = useCallback(async () => {
    if (!projectPath || !hasRepo || isBusy || resetSelectedFiles.length === 0)
      return;
    const selectedUntrackedFiles = changedFiles
      .filter(
        (file) => resetSelectedFiles.includes(file.path) && file.untracked,
      )
      .map((file) => file.path);
    setIsResetting(true);
    try {
      const result = await useDocumentStore.getState().runGitOperation(
        projectPath,
        {
          saveFiles: [],
          discardFiles: resetSelectedFiles,
          history: { label: "reset", before: true },
        },
        () =>
          invoke<GitCommandResult>("git_panel_reset_selected", {
            projectRoot: projectPath,
            selectedFiles: resetSelectedFiles,
            untrackedFiles: selectedUntrackedFiles,
          }),
      );
      toast.success(result.message);
      setIsResetDialogOpen(false);
      await refreshRepositoryView(false);
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView(false);
    } finally {
      setIsResetting(false);
    }
  }, [
    changedFiles,
    hasRepo,
    isBusy,
    projectPath,
    refreshRepositoryView,
    resetSelectedFiles,
  ]);

  const runStashAction = useCallback(async () => {
    if (!projectPath || !hasRepo || !selectedStashRef || isBusy) return;
    setIsStashRunning(true);
    try {
      const command =
        stashStep === "apply"
          ? "git_panel_stash_apply"
          : stashStep === "pop"
            ? "git_panel_stash_pop"
            : "git_panel_stash_drop";
      const args = { projectRoot: projectPath, stashRef: selectedStashRef };
      const result =
        stashStep === "drop"
          ? await runRemoteGitAction(command, args)
          : await runWorkingTreeGitAction(command, args, `stash ${stashStep}`);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message, { duration: 10_000 });
      }
      if (stashStep !== "apply" && result.success) {
        await refreshStashList();
      }
      if (stashStep !== "drop") {
        await refreshRepositoryView();
      }
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsStashRunning(false);
    }
  }, [
    hasRepo,
    isBusy,
    projectPath,
    refreshRepositoryView,
    refreshStashList,
    selectedStashRef,
    stashStep,
  ]);

  const runAbortOperation = useCallback(async () => {
    if (!projectPath || !status?.operation || isBusy) return;
    const operation = status.operation;
    const confirmed = window.confirm(
      `Abort the current ${operation}? Git will restore the repository to its state before the ${operation} began.`,
    );
    if (!confirmed) return;

    setIsAbortingOperation(true);
    try {
      const result = await runWorkingTreeGitAction(
        "git_panel_abort_operation",
        { projectRoot: projectPath },
        "abort Git operation",
      );
      toast.success(result.message);
      await refreshRepositoryView();
    } catch (error) {
      toast.error(formatError(error));
      await refreshRepositoryView();
    } finally {
      setIsAbortingOperation(false);
    }
  }, [isBusy, projectPath, refreshRepositoryView, status?.operation]);

  return (
    <>
      <div
        ref={rootRef}
        data-git-actions-control
        data-git-actions-compact={isCompact ? "true" : "false"}
        data-git-actions-standard={
          !isManagedOperation || isAbortMergeAction ? "true" : undefined
        }
        data-git-actions-abort-merge={isAbortMergeAction ? "true" : undefined}
        data-merge-actions={isMergeOperation ? "true" : undefined}
        data-rebase-actions={isRebaseOperation ? "true" : undefined}
        data-ai-review-blocked={hasUnresolvedAiSuggestions ? "true" : undefined}
        className={cn(
          "git-actions-control flex h-8 shrink-0 items-center rounded-lg transition-opacity",
          isManagedOperation
            ? isAbortManagedOperationAction
              ? abortOperationSurfaceClass
              : "bg-indigo-600 text-white shadow-sm dark:bg-violet-600"
            : "border border-border/70 bg-muted/50",
        )}
      >
        <Hint
          content={
            hasUnresolvedAiSuggestions
              ? "Finish agent review to use Git actions"
              : hasRepo
                ? isMergeOperation
                  ? hasConflicts
                    ? "Abort the in-progress merge"
                    : canFinishMerge
                      ? "Review and finish the merge"
                      : "No merge changes to commit"
                  : isRebaseOperation
                    ? hasConflicts
                      ? "Abort the in-progress rebase"
                      : "Continue the in-progress rebase"
                    : showPrimaryPushAction
                      ? needsRemoteUpdate
                        ? "Safely replace the remote branch with the rebased history"
                        : "Push commits"
                      : canOpenCommit
                        ? "Commit changes"
                        : "No changes to commit"
                : status === null
                  ? "Checking Git repository"
                  : "Set up version control"
          }
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={primaryActionLabel}
            className={cn(
              "git-actions-primary h-8 rounded-lg",
              isCompact && !isManagedOperation
                ? "w-8 gap-0 px-0 text-xs has-[>svg]:px-0"
                : "gap-1 px-2 text-xs",
              isAbortManagedOperationAction
                ? abortOperationButtonClass
                : isManagedOperation &&
                    "text-white hover:bg-indigo-700 hover:text-white focus-visible:ring-indigo-300/60 dark:text-white dark:focus-visible:ring-violet-300/60 dark:hover:bg-violet-500 dark:hover:text-white",
            )}
            onClick={() => {
              if (!hasRepo) {
                setIsSetupDialogOpen(true);
                return;
              }
              if (isMergeOperation) {
                if (hasConflicts) {
                  void runAbortOperation();
                } else {
                  openCommitDialog();
                }
                return;
              }
              if (isRebaseOperation) {
                if (hasConflicts) {
                  void runAbortOperation();
                } else {
                  void runContinueRebase();
                }
                return;
              }
              if (showPrimaryPushAction) {
                if (needsRemoteUpdate) {
                  setIsRemoteUpdateOpen(true);
                } else {
                  void runPush();
                }
                return;
              }
              openCommitDialog();
            }}
            disabled={
              hasUnresolvedAiSuggestions || !canRunPrimaryAction || isBusy
            }
          >
            {!hasRepo ? (
              <GitBranchIcon
                className={cn(isCompact ? "size-4" : "size-3.5")}
              />
            ) : isManagedOperation && hasConflicts ? (
              <Undo2Icon className={cn(isCompact ? "size-4" : "size-3.5")} />
            ) : isManagedOperation ? (
              <GitMergeIcon className={cn(isCompact ? "size-4" : "size-3.5")} />
            ) : showPrimaryPushAction ? (
              <ArrowUpToLineIcon
                className={cn(isCompact ? "size-4" : "size-3.5")}
              />
            ) : (
              <GitCommitHorizontalIcon
                className={cn(isCompact ? "size-4" : "size-3.5")}
              />
            )}
            {!isCompact || isManagedOperation ? (
              <span className="git-actions-label">
                {!hasRepo
                  ? "Set up Git"
                  : isMergeOperation
                    ? hasConflicts
                      ? isAbortingOperation
                        ? "Aborting..."
                        : "Abort merge"
                      : "Finish merge"
                    : isRebaseOperation
                      ? hasConflicts
                        ? isAbortingOperation
                          ? "Aborting..."
                          : "Abort rebase"
                        : isRebasing
                          ? "Continuing..."
                          : "Continue rebase"
                      : showPrimaryPushAction
                        ? needsRemoteUpdate
                          ? "Update remote"
                          : isPushing
                            ? "Pushing..."
                            : "Push"
                        : isCommitting
                          ? "Committing..."
                          : "Commit"}
              </span>
            ) : null}
          </Button>
        </Hint>
        <DropdownMenu
          key={hasUnresolvedAiSuggestions ? "review" : "editing"}
          open={hasUnresolvedAiSuggestions ? false : undefined}
          onOpenChange={(open) => {
            if (open) {
              void refreshActionAvailability();
              if (typeof window !== "undefined") {
                window.requestAnimationFrame(() => {
                  void checkPullAvailability();
                });
              } else {
                void checkPullAvailability();
              }
            } else {
              pullCheckRequestIdRef.current += 1;
              setIsCheckingPull(false);
              setPullBehindCommits([]);
            }
          }}
        >
          <Hint
            content={
              hasUnresolvedAiSuggestions
                ? "Finish agent review to use Git actions"
                : isMergeOperation
                  ? "Git merge actions"
                  : isRebaseOperation
                    ? "Git rebase actions"
                    : "Git actions"
            }
          >
            <DropdownMenuTrigger
              asChild
              disabled={!hasRepo || hasUnresolvedAiSuggestions}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="More git actions"
                className={cn(
                  "git-actions-menu -ml-0.5 h-8 w-6 rounded-lg",
                  isAbortManagedOperationAction
                    ? abortOperationButtonClass
                    : isManagedOperation &&
                        "text-white hover:bg-indigo-700 hover:text-white focus-visible:ring-indigo-300/60 dark:text-white dark:focus-visible:ring-violet-300/60 dark:hover:bg-violet-500 dark:hover:text-white",
                )}
                disabled={!hasRepo || hasUnresolvedAiSuggestions}
              >
                <ChevronDownIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent
            align="end"
            alignOffset={-4}
            sideOffset={6}
            className={isManagedOperation ? "w-52" : "w-44"}
          >
            <DropdownMenuLabel>
              <span className="inline-flex items-center gap-1.5">
                {isManagedOperation ? (
                  <GitMergeIcon className="size-3.5 text-indigo-600 dark:text-violet-300" />
                ) : (
                  <GithubIcon className="size-3.5 text-muted-foreground" />
                )}
                <span>
                  {isMergeOperation
                    ? "Git merge actions"
                    : isRebaseOperation
                      ? "Git rebase actions"
                      : "Git actions"}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="mx-2" />
            {hasUnresolvedAiSuggestions || isBusy ? (
              <DropdownMenuItem disabled className="whitespace-normal text-xs">
                {hasUnresolvedAiSuggestions
                  ? "Finish AI review to use Git actions"
                  : "Git operation in progress…"}
              </DropdownMenuItem>
            ) : isMergeOperation ? (
              <>
                <DropdownMenuItem
                  data-testid="finish-merge-action"
                  disabled={!canFinishMerge}
                  onClick={openCommitDialog}
                  className={
                    !canFinishMerge ? "text-muted-foreground" : undefined
                  }
                >
                  <GitMergeIcon className="mr-2 size-4 text-indigo-600 dark:text-violet-300" />
                  <span>Finish merge</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void runAbortOperation()}
                  variant="destructive"
                >
                  <Undo2Icon className="mr-2 size-4" />
                  Abort merge
                </DropdownMenuItem>
              </>
            ) : isRebaseOperation ? (
              <>
                <DropdownMenuItem
                  data-testid="continue-rebase-action"
                  disabled={!canContinueRebase}
                  onClick={() => void runContinueRebase()}
                  className={
                    !canContinueRebase ? "text-muted-foreground" : undefined
                  }
                >
                  <GitMergeIcon className="mr-2 size-4 text-indigo-600 dark:text-violet-300" />
                  <span>Continue rebase</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void runAbortOperation()}
                  variant="destructive"
                >
                  <Undo2Icon className="mr-2 size-4" />
                  Abort rebase
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  disabled={!canOpenCommit}
                  onClick={openCommitDialog}
                >
                  <GitCommitHorizontalIcon className="mr-2 size-4" />
                  Commit
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canPush}
                  onClick={() => {
                    if (needsRemoteUpdate) {
                      setIsRemoteUpdateOpen(true);
                    } else {
                      void runPush();
                    }
                  }}
                >
                  <ArrowUpToLineIcon className="mr-2 size-4" />
                  {needsRemoteUpdate ? "Update remote" : "Push"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canPull}
                  onClick={() => {
                    openPullDialog();
                  }}
                >
                  <RefreshCwIcon
                    className={cn(
                      "mr-2 size-4",
                      isCheckingPull && "animate-spin text-muted-foreground",
                    )}
                  />
                  <span>Pull</span>
                  {pullBehindCount > 0 && !isCheckingPull ? (
                    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-muted px-1.5 py-0.5 font-semibold text-[10px] tabular-nums">
                      {pullBehindCount}
                    </span>
                  ) : null}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasRepo || hasConflicts || hasOperation}
                  onClick={openStashDialog}
                >
                  <ArchiveIcon className="mr-2 size-4" />
                  Stash
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canStartRebase}
                  onClick={() => void openRebaseDialog()}
                >
                  <GitMergeIcon className="mr-2 size-4" />
                  Rebase
                </DropdownMenuItem>
                {status?.operation ? (
                  <DropdownMenuItem
                    onClick={() => void runAbortOperation()}
                    className="text-destructive focus:text-destructive"
                  >
                    <Undo2Icon className="mr-2 size-4" />
                    Abort {status.operation}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={!canReset}
                  onClick={openResetDialog}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2Icon className="mr-2 size-4" />
                  Reset
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator className="mx-2" />
            <DropdownMenuItem onClick={() => setHistoryProject(projectPath)}>
              <GitCommitHorizontalIcon className="mr-2 size-4" />
              Git history…
            </DropdownMenuItem>
            {!isManagedOperation && (
              <DropdownMenuItem
                disabled={hasUnresolvedAiSuggestions || isBusy}
                onClick={() => setIsSetupDialogOpen(true)}
              >
                <GitBranchIcon className="mr-2 size-4" />
                Git Remote
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {historyProject && historyProject === projectPath && (
        <GitHistoryDialog
          key={historyProject}
          projectPath={historyProject}
          branch={status?.branch ?? null}
          onClose={() => setHistoryProject(null)}
          onBranchChanged={refreshRepositoryView}
          branchSwitchDisabled={
            hasUnresolvedAiSuggestions || isBusy || hasConflicts || hasOperation
          }
        />
      )}

      {projectPath ? (
        <GitSetupDialog
          open={isSetupDialogOpen}
          onOpenChange={setIsSetupDialogOpen}
          projectPath={projectPath}
          hasRepository={hasRepo}
          showGitCommand={showGitCommand}
          onShowGitCommandChange={setShowGitCommand}
          onRepositoryReady={handleRepositoryReady}
        />
      ) : null}

      <Dialog open={isCommitDialogOpen} onOpenChange={setIsCommitDialogOpen}>
        <DialogContent
          className="rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader>
              <GitCommitHorizontalIcon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {status?.branch ?? "detached"}
              </span>
            </DialogIconHeader>
            <DialogTitle>
              {status?.operation
                ? `Finish ${status.operation}`
                : "Commit your changes"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {isMergeOperation
                ? "Review the files included in the merge and create the merge commit."
                : "Select files and create a Git commit."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {hasConflicts || (status?.operation && !isMergeOperation) ? (
              <div
                data-testid="git-conflict-guidance"
                className="flex gap-2 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-amber-950 text-xs dark:text-amber-100"
              >
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
                <div>
                  {hasConflicts && status?.operation === "merge" ? (
                    <>
                      Resolve every conflicted file in the editor, then keep all
                      conflict files selected. {PRODUCT_NAME} will finish the
                      merge with those resolutions.
                    </>
                  ) : hasConflicts ? (
                    <>
                      Resolve every conflicted file in the editor, then keep all
                      conflict files selected. {PRODUCT_NAME} will commit the
                      resolved files.
                    </>
                  ) : (
                    `All conflicts are resolved. Commit the staged changes to finish the ${status?.operation}.`
                  )}
                </div>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground text-sm">
                  Modified files
                </div>
                <div className="text-muted-foreground text-xs">
                  {isMergeOperation
                    ? `${changedFiles.length} ${changedFiles.length === 1 ? "file" : "files"} included`
                    : `${selectedCount}/${changedFiles.length} selected`}
                </div>
              </div>
              <div className="app-scrollbar max-h-44 overflow-y-auto">
                {!isMergeOperation ? (
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    disabled={changedFiles.length === 0}
                    className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <CheckboxIndicator checked={allSelected} />
                    <span className="min-w-0 flex-1 truncate">Select All</span>
                  </button>
                ) : null}
                {changedFiles.length === 0 ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    No modified files.
                  </div>
                ) : (
                  changedFiles.map((file) => {
                    const selected = selectedFiles.includes(file.path);
                    const stats = lineStatsByPath[file.path] ?? {
                      file_path: file.path,
                      added: 0,
                      deleted: 0,
                    };
                    const content = (
                      <>
                        {isMergeOperation ? (
                          <span
                            data-merge-required-indicator="true"
                            aria-hidden="true"
                            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground text-xs"
                          >
                            -
                          </span>
                        ) : (
                          <CheckboxIndicator checked={selected} />
                        )}
                        <Hint content={file.path}>
                          <span
                            className={cn(
                              "min-w-0 max-w-[60%] flex-1 truncate",
                              isMergeOperation || selected
                                ? "text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {truncatePathLabel(file.path)}
                          </span>
                        </Hint>
                        <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                          {stats.added > 0 ? (
                            <span className="font-medium text-[10px] text-emerald-600">
                              +{stats.added}
                            </span>
                          ) : null}
                          {stats.deleted > 0 ? (
                            <span className="font-medium text-[10px] text-rose-600">
                              -{stats.deleted}
                            </span>
                          ) : null}
                          {file.staged ? (
                            <span className="whitespace-nowrap rounded border border-sidebar-border px-1.5 py-0.5 text-[10px]">
                              staged
                            </span>
                          ) : null}
                          {file.unstaged ? (
                            <span className="whitespace-nowrap rounded border border-sidebar-border px-1.5 py-0.5 text-[10px]">
                              unstaged
                            </span>
                          ) : null}
                          {file.untracked ? (
                            <span className="whitespace-nowrap rounded border border-sidebar-border px-1.5 py-0.5 text-[10px]">
                              untracked
                            </span>
                          ) : null}
                          {file.conflicted ? (
                            <span className="whitespace-nowrap rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                              conflict
                            </span>
                          ) : null}
                        </div>
                      </>
                    );
                    const rowClassName = cn(
                      "flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm last:border-b-0",
                      !isMergeOperation &&
                        "transition-colors hover:text-foreground",
                    );

                    return isMergeOperation ? (
                      <div
                        key={file.path}
                        data-merge-touched-file={file.path}
                        className={rowClassName}
                      >
                        {content}
                      </div>
                    ) : (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => toggleFileSelection(file.path)}
                        className={rowClassName}
                      >
                        {content}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Commit message
              </div>
              <Textarea
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                placeholder="Leave blank to autogenerate a commit message"
                rows={2}
                className="min-h-16 resize-none rounded-xl bg-background shadow-none transition-colors duration-150 focus-visible:border-ring focus-visible:shadow-none focus-visible:ring-0 dark:bg-muted"
              />
              <div className="text-muted-foreground text-xs">
                Auto message:{" "}
                <span className="font-mono">{generatedCommitMessage}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <ActionSelector
                value={nextStep}
                onChange={setNextStep}
                options={[
                  {
                    value: "commit",
                    label: isMergeOperation ? "Finish merge" : "Commit",
                    icon: GitCommitHorizontalIcon,
                  },
                  {
                    value: "commit_and_push",
                    label: isMergeOperation
                      ? "Finish merge & push"
                      : "Commit & push",
                    icon: ArrowUpToLineIcon,
                  },
                ]}
              />
              <GitCommandDisclosure
                commands={commitCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:items-center sm:justify-between">
            <button
              type="button"
              aria-pressed={draftCommit}
              onClick={() => setDraftCommit(!draftCommit)}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors hover:bg-muted/35"
            >
              <CheckboxIndicator checked={draftCommit} />
              <span>Draft</span>
            </button>
            <div className="flex items-center gap-2">
              <Hint
                content={
                  !allConflictsSelected
                    ? "Select every conflict file before committing"
                    : undefined
                }
              >
                <Button
                  type="button"
                  data-testid="git-commit-submit"
                  className="rounded-lg"
                  onClick={() => void runCommit(nextStep === "commit_and_push")}
                  disabled={!canFinishCommit || isCommitting}
                  aria-label={
                    !allConflictsSelected
                      ? "Select every conflict file before committing"
                      : undefined
                  }
                >
                  {isCommitting
                    ? isMergeOperation
                      ? nextStep === "commit_and_push"
                        ? "Finishing merge & pushing..."
                        : "Creating merge commit..."
                      : "Committing..."
                    : isMergeOperation
                      ? nextStep === "commit_and_push"
                        ? "Finish merge & push"
                        : "Create merge commit"
                      : "Continue"}
                </Button>
              </Hint>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRebaseDialogOpen}
        onOpenChange={(open) => {
          if (!isRebasing) setIsRebaseDialogOpen(open);
        }}
      >
        <DialogContent
          data-testid="rebase-dialog"
          className="max-h-[calc(100svh-2rem)] rounded-[20px] bg-muted p-4 shadow-2xl sm:max-w-[720px] dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader closeDisabled={isRebasing}>
              <GitBranchIcon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {status?.branch ?? "detached"}
              </span>
            </DialogIconHeader>
            <DialogTitle>Rebase branch</DialogTitle>
            <DialogDescription>
              Select the commit that should become the new base of your current
              branch.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground text-sm">
                  Commit graph
                </div>
                <div className="text-muted-foreground text-xs">
                  {isRebaseLoading
                    ? "Loading..."
                    : `${rebaseCommits.length} ${rebaseCommits.length === 1 ? "commit" : "commits"}`}
                </div>
              </div>
              <div
                ref={rebaseGraphScrollRef}
                data-testid="rebase-commit-graph"
                className="app-scrollbar max-h-52 min-h-[132px] overflow-auto rounded-xl border border-border/70 bg-background dark:bg-muted"
              >
                {isRebaseLoading ? (
                  <div className="flex min-h-28 items-center justify-center gap-2 text-muted-foreground text-xs">
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                    Loading commit graph...
                  </div>
                ) : rebasePreviewError ? (
                  <div className="flex min-h-28 items-center justify-center px-4 text-center text-amber-700 text-xs dark:text-amber-300">
                    {rebasePreviewError}
                  </div>
                ) : rebaseCommits.length === 0 ? (
                  <div className="flex min-h-28 items-center justify-center text-muted-foreground text-xs">
                    No commits available.
                  </div>
                ) : (
                  <div
                    className="relative text-blue-500"
                    style={{
                      width: rebaseGraph.width,
                      height: rebaseGraph.height,
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      className="absolute inset-0"
                      width={rebaseGraph.width}
                      height={rebaseGraph.height}
                    >
                      {rebaseGraph.edges.map(({ child, parent }) => {
                        const midpoint = (child.x + parent.x) / 2;
                        const selected =
                          child.commit.hash === selectedRebaseTarget ||
                          parent.commit.hash === selectedRebaseTarget;
                        return (
                          <path
                            key={`${child.commit.hash}-${parent.commit.hash}`}
                            d={`M ${child.x} ${child.y} C ${midpoint} ${child.y}, ${midpoint} ${parent.y}, ${parent.x} ${parent.y}`}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={selected ? 2.5 : 2}
                            className={cn(
                              selected
                                ? "text-violet-600 dark:text-violet-400"
                                : "text-blue-400/80 dark:text-blue-400/65",
                            )}
                          />
                        );
                      })}
                    </svg>
                    {rebaseGraph.nodes.map((node) => {
                      const selected =
                        node.commit.hash === selectedRebaseTarget;
                      const rawRef =
                        node.commit.refs.find(
                          (reference) => !reference.startsWith("tag:"),
                        ) ?? node.commit.refs[0];
                      const refLabel = rawRef
                        ?.replace(/^HEAD -> /, "")
                        .replace(/^tag: /, "");
                      return (
                        <div key={node.commit.hash}>
                          {refLabel ? (
                            <Hint content={rawRef}>
                              <span
                                className="absolute max-w-24 -translate-x-1/2 truncate rounded bg-foreground px-1.5 py-0.5 font-medium text-[9px] text-background"
                                style={{ left: node.x, top: node.y - 30 }}
                              >
                                {refLabel}
                              </span>
                            </Hint>
                          ) : null}
                          <Hint
                            content={
                              node.commit.is_head
                                ? `${node.commit.short_hash} is the current HEAD`
                                : `${node.commit.short_hash} — ${node.commit.subject}`
                            }
                          >
                            <button
                              type="button"
                              aria-label={`Select ${node.commit.short_hash}: ${node.commit.subject}`}
                              aria-pressed={selected}
                              disabled={node.commit.is_head || isRebasing}
                              onClick={() =>
                                setSelectedRebaseTarget(node.commit.hash)
                              }
                              className="absolute flex size-7 items-center justify-center rounded-full disabled:cursor-not-allowed"
                              style={{ left: node.x - 14, top: node.y - 14 }}
                            >
                              <span
                                className={cn(
                                  "size-3 rounded-full border-2 transition-transform",
                                  node.commit.is_head
                                    ? "border-foreground bg-foreground"
                                    : selected
                                      ? "scale-125 border-violet-600 bg-violet-600 ring-4 ring-violet-500/20 dark:border-violet-400 dark:bg-violet-400"
                                      : "border-blue-500 bg-background hover:scale-125 dark:bg-muted",
                                )}
                              />
                            </button>
                          </Hint>
                          <span
                            data-testid={`rebase-commit-time-${node.commit.short_hash}`}
                            className="absolute flex -translate-x-1/2 flex-col items-center whitespace-nowrap text-muted-foreground"
                            style={{ left: node.x, top: node.y + 13 }}
                          >
                            <span className="font-mono text-[9px]">
                              {node.commit.short_hash}
                            </span>
                            <span className="text-[8px]">
                              {formatGraphCommitTime(node.commit.committed_at)}
                            </span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Selected target
              </div>
              <div className="rounded-xl border border-border/70 bg-background px-3 py-2 dark:bg-muted">
                {selectedRebaseCommit ? (
                  <div className="flex items-start gap-3">
                    <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-violet-600 dark:bg-violet-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-sm">
                        {selectedRebaseCommit.subject}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs leading-4">
                        <span className="font-mono">
                          {selectedRebaseCommit.short_hash}
                        </span>
                        <span data-testid="selected-rebase-author">
                          {selectedRebaseCommit.author}
                        </span>
                        <span>
                          {formatGraphCommitTime(
                            selectedRebaseCommit.committed_at,
                            true,
                          )}
                        </span>
                        {selectedRebaseCommit.refs.map((reference) => (
                          <span
                            key={reference}
                            className="inline-flex h-4 items-center rounded border border-sidebar-border px-1.5 text-[10px] leading-none"
                          >
                            {reference}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-h-11 items-center text-muted-foreground text-xs">
                    Select a commit node in the graph.
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
                <button
                  type="button"
                  aria-pressed={rebaseStep === "rebase"}
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setRebaseStep("rebase")}
                >
                  <span className="inline-flex items-center gap-2">
                    <GitBranchIcon className="size-3.5 text-muted-foreground" />
                    <span>Rebase</span>
                  </span>
                  {rebaseStep === "rebase" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <button
                  type="button"
                  aria-pressed={rebaseStep === "rebase_and_push"}
                  className="flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setRebaseStep("rebase_and_push")}
                >
                  <span className="inline-flex items-center gap-2">
                    <ArrowUpToLineIcon className="size-3.5 text-muted-foreground" />
                    <span>
                      Rebase and push
                      {recommendedRebasePush === "normal"
                        ? " (Recommended)"
                        : ""}
                    </span>
                  </span>
                  {rebaseStep === "rebase_and_push" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <Hint
                  content={
                    status?.upstream_branch
                      ? undefined
                      : "Set an upstream branch before force pushing"
                  }
                >
                  <button
                    type="button"
                    aria-pressed={rebaseStep === "rebase_and_force_push"}
                    disabled={!status?.upstream_branch}
                    aria-label={
                      status?.upstream_branch
                        ? undefined
                        : "Set an upstream branch before force pushing"
                    }
                    className="flex w-full items-center justify-between border-sidebar-border border-t py-2 pr-3 pl-2 text-left text-red-600 text-sm transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300"
                    onClick={() => setRebaseStep("rebase_and_force_push")}
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArrowUpToLineIcon className="size-3.5" />
                      <span>
                        Rebase and force push
                        {recommendedRebasePush === "force"
                          ? " (Recommended)"
                          : ""}
                      </span>
                    </span>
                    {rebaseStep === "rebase_and_force_push" ? (
                      <CheckIcon className="size-4" />
                    ) : null}
                  </button>
                </Hint>
              </div>
              <GitCommandDisclosure
                commands={rebaseCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              className="rounded-lg"
              onClick={() => void runRebase()}
              disabled={!selectedRebaseTarget || isRebaseLoading || isRebasing}
            >
              {isRebasing
                ? rebaseStep === "rebase_and_push" ||
                  rebaseStep === "rebase_and_force_push"
                  ? "Rebasing and pushing..."
                  : "Rebasing..."
                : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isRemoteUpdateOpen}
        onOpenChange={(open) => {
          if (!isRemoteUpdateRunning) setIsRemoteUpdateOpen(open);
        }}
      >
        <DialogContent
          data-testid="remote-update-dialog"
          className="rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader closeDisabled={isRemoteUpdateRunning}>
              <GitBranchIcon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {status?.upstream_branch ?? "remote branch"}
              </span>
            </DialogIconHeader>
            <DialogTitle>Update remote after rebase</DialogTitle>
            <DialogDescription className="sr-only">
              Confirm the safe force push for the rebased branch.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
              <div className="flex items-center justify-between border-sidebar-border border-b px-3 py-2 text-sm">
                <span className="text-muted-foreground">Local branch</span>
                <span className="font-medium">
                  {status?.branch ?? "detached"} · {status?.ahead ?? 0} ahead
                </span>
              </div>
              <div className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-muted-foreground">Remote branch</span>
                <span className="font-medium">
                  {status?.upstream_branch ?? "remote"} · {status?.behind ?? 0}{" "}
                  replaced
                </span>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <button
                type="button"
                aria-pressed="true"
                disabled={isRemoteUpdateRunning}
                className="flex w-full items-center justify-between rounded-xl border border-border/70 bg-background py-2 pr-3 pl-2 text-left text-sm disabled:opacity-50 dark:bg-muted"
              >
                <span className="inline-flex items-center gap-2">
                  <ArrowUpToLineIcon className="size-3.5 text-red-600 dark:text-red-300" />
                  <span>Force push with lease</span>
                </span>
                <CheckIcon className="size-4 text-foreground" />
              </button>
              <GitCommandDisclosure
                commands={forcePushCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              className="rounded-lg"
              disabled={isRemoteUpdateRunning}
              onClick={() => void runUpdateRemote()}
            >
              {isRemoteUpdateRunning ? "Updating..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isPushRecoveryOpen}
        onOpenChange={(open) => {
          if (!isPushRecoveryRunning) setIsPushRecoveryOpen(open);
        }}
      >
        <DialogContent
          data-testid="push-recovery-dialog"
          className="rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader closeDisabled={isPushRecoveryRunning}>
              <GitBranchIcon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {pushRecoveryPreview
                  ? `${pushRecoveryPreview.remote_name}/${pushRecoveryPreview.remote_branch}`
                  : (status?.branch ?? "remote")}
              </span>
            </DialogIconHeader>
            <DialogTitle>Push rejected due to conflicts</DialogTitle>
            <DialogDescription className="sr-only">
              Choose how to recover from the rejected push.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground text-sm">
                  Potential conflicts
                </div>
                <div className="text-muted-foreground text-xs">
                  {isPushRecoveryLoading
                    ? "Checking..."
                    : `${pushRecoveryPreview?.conflicted_files.length ?? 0} ${(pushRecoveryPreview?.conflicted_files.length ?? 0) === 1 ? "file" : "files"}`}
                </div>
              </div>
              <div
                data-testid="push-recovery-file-list"
                className="app-scrollbar max-h-44 overflow-y-auto"
              >
                {isPushRecoveryLoading ? (
                  <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
                    <RefreshCwIcon className="size-3.5 animate-spin" />
                    Checking remote changes...
                  </div>
                ) : pushRecoveryPreviewError ? (
                  <div className="py-3 text-amber-700 text-xs dark:text-amber-300">
                    {pushRecoveryPreviewError}
                  </div>
                ) : (pushRecoveryPreview?.conflicted_files.length ?? 0) ===
                  0 ? (
                  <div className="py-3 text-muted-foreground text-xs">
                    No conflicts expected. Pull, merge & push should complete
                    automatically.
                  </div>
                ) : (
                  pushRecoveryPreview?.conflicted_files.map((path) => (
                    <div
                      key={path}
                      data-push-conflicted-file={path}
                      className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm last:border-b-0"
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground text-xs">
                        -
                      </span>
                      <Hint content={path}>
                        <span className="min-w-0 flex-1 truncate text-foreground">
                          {truncatePathLabel(path)}
                        </span>
                      </Hint>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
                <button
                  type="button"
                  onClick={() => setPushRecoveryAction("pull")}
                  disabled={isPushRecoveryLoading || isPushRecoveryRunning}
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="inline-flex items-center gap-2">
                    <RefreshCwIcon className="size-3.5 text-muted-foreground" />
                    <span>Pull and merge</span>
                  </span>
                  {pushRecoveryAction === "pull" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                {canPullMergePush ? (
                  <button
                    type="button"
                    onClick={() => setPushRecoveryAction("pull_push")}
                    disabled={isPushRecoveryRunning}
                    className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ArrowUpToLineIcon className="size-3.5 text-muted-foreground" />
                      <span>Pull, merge & push</span>
                    </span>
                    {pushRecoveryAction === "pull_push" ? (
                      <CheckIcon className="size-4 text-foreground" />
                    ) : null}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setPushRecoveryAction("force")}
                  disabled={isPushRecoveryLoading || isPushRecoveryRunning}
                  className="flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="inline-flex items-center gap-2 text-red-700 dark:text-red-300">
                    <ArrowUpToLineIcon className="size-3.5" />
                    <span>Force push to override remote</span>
                  </span>
                  {pushRecoveryAction === "force" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
              </div>
              {pushRecoveryAction === "pull" &&
              (pushRecoveryPreview?.conflicted_files.length ?? 0) > 0 ? (
                <p className="text-muted-foreground text-xs">
                  Resolve any conflicts, then finish the merge.
                </p>
              ) : null}
              <GitCommandDisclosure
                commands={pushRecoveryCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              className="rounded-lg"
              disabled={isPushRecoveryLoading || isPushRecoveryRunning}
              onClick={() =>
                void (pushRecoveryAction === "force"
                  ? runPushRecoveryForce()
                  : runPushRecoveryPull(pushRecoveryAction === "pull_push"))
              }
            >
              {isPushRecoveryRunning ? "Running..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={isStashPullDialogOpen}
        onOpenChange={setIsStashPullDialogOpen}
      >
        <DialogContent
          className="rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader>
              <button
                type="button"
                aria-label="Refresh pull status"
                className="flex items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                onClick={() => void checkPullAvailability()}
                disabled={isCheckingPull || !hasRepo}
              >
                <RefreshCwIcon
                  className={cn(isCheckingPull && "animate-spin")}
                />
              </button>
              <span className="font-medium text-foreground text-sm">
                {status?.branch ?? "detached"}
              </span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-[11px] tabular-nums">
                {isCheckingPull ? "checking..." : `${pullBehindCount} behind`}
              </span>
            </DialogIconHeader>
            <DialogTitle>Pull updates</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Incoming commits
              </div>
              <div className="app-scrollbar max-h-28 overflow-y-auto rounded-xl border border-border/70 bg-background px-3 py-2 text-xs dark:bg-muted">
                {isCheckingPull ? (
                  <div className="text-muted-foreground">
                    Checking remote...
                  </div>
                ) : pullBehindCount === 0 ? (
                  <div className="text-muted-foreground">Up to date.</div>
                ) : pullBehindCommits.length === 0 ? (
                  <div className="text-muted-foreground">
                    {pullBehindCount} incoming commit
                    {pullBehindCount === 1 ? "" : "s"}.
                  </div>
                ) : (
                  pullBehindCommits.map((commit) => (
                    <div
                      key={commit}
                      className="border-sidebar-border border-b py-1.5 last:border-b-0"
                    >
                      {commit}
                    </div>
                  ))
                )}
              </div>
            </div>

            {hasTrackedFilesToStash ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-foreground text-sm">
                    Files to stash before pull
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {pullStashSelectedCount}/{trackedChangedFiles.length}{" "}
                    selected
                  </div>
                </div>
                <div className="app-scrollbar max-h-36 overflow-y-auto">
                  <button
                    type="button"
                    onClick={togglePullStashSelectAll}
                    className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm transition-colors"
                  >
                    <CheckboxIndicator checked={allPullStashSelected} />
                    <span className="min-w-0 flex-1 truncate">Select All</span>
                  </button>
                  {trackedChangedFiles.map((file) => {
                    const selected = pullStashSelectedFiles.includes(file.path);
                    const stats = lineStatsByPath[file.path] ?? {
                      file_path: file.path,
                      added: 0,
                      deleted: 0,
                    };
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => togglePullStashFileSelection(file.path)}
                        className={cn(
                          "flex w-full items-center gap-2 py-2 text-left text-sm transition-colors",
                          "border-sidebar-border border-b last:border-b-0",
                          "hover:text-foreground",
                        )}
                      >
                        <CheckboxIndicator checked={selected} />
                        <Hint content={file.path}>
                          <span
                            className={cn(
                              "min-w-0 max-w-[60%] flex-1 truncate",
                              selected
                                ? "text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {truncatePathLabel(file.path)}
                          </span>
                        </Hint>
                        <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                          {stats.added > 0 ? (
                            <span className="font-medium text-[10px] text-emerald-600">
                              +{stats.added}
                            </span>
                          ) : null}
                          {stats.deleted > 0 ? (
                            <span className="font-medium text-[10px] text-rose-600">
                              -{stats.deleted}
                            </span>
                          ) : null}
                          {file.conflicted ? (
                            <span className="whitespace-nowrap rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                              conflict
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {hasTrackedFilesToStash ? (
              <div className="space-y-1.5">
                <div className="font-semibold text-foreground text-sm">
                  Stash message
                </div>
                <Input
                  value={stashMessage}
                  onChange={(event) => setStashMessage(event.target.value)}
                  placeholder="WIP before pull"
                  className="rounded-xl bg-background dark:bg-muted"
                />
                <div className="text-muted-foreground text-xs">
                  Selected untracked files are not included in selective stash.
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setPullStep("pull")}
                >
                  <span className="inline-flex items-center gap-2">
                    <RefreshCwIcon className="size-3.5 text-muted-foreground" />
                    <span>Pull</span>
                  </span>
                  {pullStep === "pull" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setPullStep("pull_pop")}
                >
                  <span className="inline-flex items-center gap-2">
                    <Undo2Icon className="size-3.5 text-muted-foreground" />
                    <span>Pull + pop stash</span>
                  </span>
                  {pullStep === "pull_pop" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setPullStep("pull_apply")}
                >
                  <span className="inline-flex items-center gap-2">
                    <ClipboardCheckIcon className="size-3.5 text-muted-foreground" />
                    <span>Pull + apply stash</span>
                  </span>
                  {pullStep === "pull_apply" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
              </div>
              <GitCommandDisclosure
                commands={pullCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              className="rounded-lg"
              onClick={() => void runPullFlow()}
              disabled={!canContinuePull}
            >
              {isStashPulling ? "Running..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isStashDialogOpen} onOpenChange={setIsStashDialogOpen}>
        <DialogContent
          className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader>
              <ArchiveIcon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {status?.branch ?? "detached"}
              </span>
            </DialogIconHeader>
            <DialogTitle>Stash manager</DialogTitle>
            <DialogDescription className="sr-only">
              Inspect, apply, pop, or drop saved Git stashes for the current
              repository.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground text-sm">
                  Stashes
                </div>
                <button
                  type="button"
                  className="text-muted-foreground text-xs hover:text-foreground"
                  onClick={() => void refreshStashList()}
                  disabled={isStashListLoading}
                >
                  Refresh
                </button>
              </div>
              <div className="app-scrollbar max-h-36 overflow-y-auto">
                {isStashListLoading ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    Loading stashes...
                  </div>
                ) : stashes.length === 0 ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    No stashes found.
                  </div>
                ) : (
                  stashes.map((stash) => {
                    const selected = selectedStashRef === stash.reference;
                    return (
                      <button
                        key={stash.reference}
                        type="button"
                        onClick={() => setSelectedStashRef(stash.reference)}
                        className={cn(
                          "flex w-full items-center gap-2 py-2 text-left text-sm transition-colors",
                          "border-sidebar-border border-b last:border-b-0",
                          "hover:text-foreground",
                        )}
                      >
                        <CheckboxIndicator checked={selected} />
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate",
                            selected
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {stash.reference}: {stash.message || "(no message)"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">Files</div>
              <div className="app-scrollbar max-h-28 overflow-y-auto">
                {isStashFilesLoading ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    Loading stash files...
                  </div>
                ) : selectedStashRef == null ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    Select a stash to inspect files.
                  </div>
                ) : selectedStashFiles.length === 0 ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    No file list available.
                  </div>
                ) : (
                  selectedStashFiles.map((file) => (
                    <div
                      key={file}
                      className="border-sidebar-border border-b py-1.5 text-muted-foreground text-xs last:border-b-0"
                    >
                      {file}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setStashStep("apply")}
                >
                  <span className="inline-flex items-center gap-2">
                    <ClipboardCheckIcon className="size-3.5 text-muted-foreground" />
                    <span>Apply stash</span>
                  </span>
                  {stashStep === "apply" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35"
                  onClick={() => setStashStep("pop")}
                >
                  <span className="inline-flex items-center gap-2">
                    <Undo2Icon className="size-3.5 text-muted-foreground" />
                    <span>Pop stash</span>
                  </span>
                  {stashStep === "pop" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35",
                    stashStep === "drop"
                      ? "text-destructive focus:text-destructive"
                      : "text-foreground",
                  )}
                  onClick={() => setStashStep("drop")}
                >
                  <span className="inline-flex items-center gap-2">
                    <Trash2Icon
                      className={cn(
                        "size-3.5",
                        stashStep === "drop"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    />
                    <span>Drop stash</span>
                  </span>
                  {stashStep === "drop" ? (
                    <CheckIcon className="size-4 text-foreground" />
                  ) : null}
                </button>
              </div>
              <GitCommandDisclosure
                commands={stashCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="shrink-0 gap-2 sm:justify-end">
            <Button
              type="button"
              className="rounded-lg"
              variant={stashStep === "drop" ? "destructive" : "default"}
              onClick={() => void runStashAction()}
              disabled={!canRunStashAction}
            >
              {isStashRunning ? "Running..." : "Continue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={isResetDialogOpen} onOpenChange={setIsResetDialogOpen}>
        <DialogContent
          className="rounded-[20px] bg-muted p-4 shadow-2xl dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader>
              <Trash2Icon className="text-muted-foreground" />
              <span className="font-medium text-foreground text-sm">
                {status?.branch ?? "detached"}
              </span>
            </DialogIconHeader>
            <DialogTitle>Reset selected files</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-foreground text-sm">
                  Modified files
                </div>
                <div className="text-muted-foreground text-xs">
                  {resetSelectedCount}/{changedFiles.length} selected
                </div>
              </div>
              <div className="app-scrollbar max-h-44 overflow-y-auto">
                <button
                  type="button"
                  onClick={toggleResetSelectAll}
                  disabled={changedFiles.length === 0}
                  className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <CheckboxIndicator checked={allResetSelected} />
                  <span className="min-w-0 flex-1 truncate">Select All</span>
                </button>
                {changedFiles.length === 0 ? (
                  <div className="py-1.5 text-muted-foreground text-xs">
                    No modified files.
                  </div>
                ) : (
                  changedFiles.map((file) => {
                    const selected = resetSelectedFiles.includes(file.path);
                    const stats = lineStatsByPath[file.path] ?? {
                      file_path: file.path,
                      added: 0,
                      deleted: 0,
                    };
                    return (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => toggleResetFileSelection(file.path)}
                        className={cn(
                          "flex w-full items-center gap-2 py-2 text-left text-sm transition-colors",
                          "border-sidebar-border border-b last:border-b-0",
                          "hover:text-foreground",
                        )}
                      >
                        <CheckboxIndicator checked={selected} />
                        <Hint content={file.path}>
                          <span
                            className={cn(
                              "min-w-0 max-w-[60%] flex-1 truncate",
                              selected
                                ? "text-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {truncatePathLabel(file.path)}
                          </span>
                        </Hint>
                        <div className="ml-auto flex shrink-0 items-center justify-end gap-1">
                          {stats.added > 0 ? (
                            <span className="font-medium text-[10px] text-emerald-600">
                              +{stats.added}
                            </span>
                          ) : null}
                          {stats.deleted > 0 ? (
                            <span className="font-medium text-[10px] text-rose-600">
                              -{stats.deleted}
                            </span>
                          ) : null}
                          {file.conflicted ? (
                            <span className="whitespace-nowrap rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-200">
                              conflict
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
                <div className="flex items-center justify-between py-2 pr-3 pl-2 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <Trash2Icon className="size-3.5 text-muted-foreground" />
                    <span>Reset selected files</span>
                  </span>
                  <CheckIcon className="size-4 text-foreground" />
                </div>
              </div>
              <div className="text-muted-foreground text-xs">
                Selected tracked files are restored to the last commit, and
                selected untracked files are removed.
              </div>
              <GitCommandDisclosure
                commands={resetCommands}
                expanded={showGitCommand}
                onExpandedChange={setShowGitCommand}
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-end">
            <Button
              type="button"
              variant="destructive"
              className="rounded-lg"
              onClick={() => void runReset()}
              disabled={!canContinueReset || isResetting}
            >
              {isResetting ? "Resetting..." : "Reset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
});
