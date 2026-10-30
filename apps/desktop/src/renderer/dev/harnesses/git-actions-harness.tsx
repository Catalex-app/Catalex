import { Hint } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useAgentEvents } from "@/hooks/use-agent-events";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";
import { useEffect } from "react";
import { useDocumentStore } from "@/stores/document-store";
import { CheckIcon } from "lucide-react";
import { GitActionsControl } from "@/components/workspace/git-actions-control";
import { truncatePathLabel } from "@/components/workspace/git-actions-control";
import { cn } from "@/lib/utils";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

declare global {
  interface Window {
    __gitActionsDocumentStore?: typeof useDocumentStore;
    __setGitActionsPendingReview?: (pending: boolean) => void;
  }
}

const LONG_PATH =
  "supplementary-material/figures/37b682a9-64e9-4f42-a999-03dfaa7ce5b7.json";

function ensureGitActionsHarnessTauriMocks() {
  if (typeof window === "undefined") return;
  window.__gitActionsDocumentStore = useDocumentStore;
  const startsWithoutRepo =
    new URLSearchParams(window.location.search).get("repo") === "none";
  const mergeState = new URLSearchParams(window.location.search).get(
    "conflict",
  );
  const recoveryCase = new URLSearchParams(window.location.search).get(
    "recovery",
  );
  const startsWithConflict = mergeState === "merge" || recoveryCase !== null;
  const startsWithResolvedMerge = mergeState === "resolved";
  const startsWithZeroDiffMerge = mergeState === "resolved-current";
  const startsWithPushRejected =
    new URLSearchParams(window.location.search).get("push") === "rejected";
  const pullResult = new URLSearchParams(window.location.search).get("pull");
  const previewResult = new URLSearchParams(window.location.search).get(
    "preview",
  );
  const retryResult = new URLSearchParams(window.location.search).get("retry");
  const commitFails =
    new URLSearchParams(window.location.search).get("commit") === "failed";
  const rebaseState = new URLSearchParams(window.location.search).get("rebase");
  const startsWithRebase = rebaseState !== null;
  const startsWithRebaseConflict = rebaseState === "conflict";
  const startsWithResolvedRebase = rebaseState === "resolved";
  const win = window as Window & {
    __gitSetupCommands?: Array<{
      command: string;
      args?: Record<string, unknown>;
    }>;
    __resolveGitConflictForHarness?: () => void;
    __reopenGitConflictForHarness?: () => void;
    __TAURI_INTERNALS__?: {
      invoke?: (
        cmd: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
      transformCallback?: (
        callback: (...args: unknown[]) => void,
        once?: boolean,
      ) => number;
      unregisterCallback?: (id: number) => void;
      metadata?: {
        currentWindow?: { label: string };
        currentWebview?: { label: string };
      };
    };
  };

  if (win.__gitSetupCommands) return;
  const existing = win.__TAURI_INTERNALS__ ?? {};
  let callbackId = 1;
  let repoFound = !startsWithoutRepo;
  let mergeActive =
    repoFound &&
    !startsWithRebase &&
    (startsWithConflict || startsWithResolvedMerge || startsWithZeroDiffMerge);
  let rebaseActive =
    repoFound && (startsWithRebaseConflict || startsWithResolvedRebase);
  let rebaseCompleted = false;
  let rebaseNeedsForce = false;
  let remoteUpdated = false;
  let committed = false;
  let conflictActive =
    repoFound && (startsWithConflict || startsWithRebaseConflict);
  const makeSide = (path: string, binary: boolean, text: string | null) => ({
    path,
    binary,
    size: binary ? 4096 : (text?.length ?? 0),
    text,
    preview_url: path.endsWith(".png") ? "/favicon.png" : null,
    supported: true,
  });
  const syntaxWarningText =
    new URLSearchParams(window.location.search).get("syntax") === "warning"
      ? "% This standalone conflicted note intentionally has no document environment.\n".repeat(
          3,
        )
      : "";
  const makeConflict = (
    path: string,
    binary: boolean,
    deleted: "current" | "incoming" | null = null,
  ) => ({
    path,
    document_path: path,
    version: `conflict:${path}`,
    ancestor: new URLSearchParams(window.location.search).has("ancestor")
      ? makeSide(path, binary, binary ? null : "Starting content\n")
      : undefined,
    current:
      deleted === "current"
        ? null
        : makeSide(
            path,
            binary,
            binary ? null : `${syntaxWarningText}Current content\n`,
          ),
    incoming:
      deleted === "incoming"
        ? null
        : makeSide(
            path,
            binary,
            binary ? null : `${syntaxWarningText}Incoming content\n`,
          ),
  });
  let recoveryFiles =
    recoveryCase === "nontext"
      ? [makeConflict("figure.png", true), makeConflict("data.bin", true)]
      : recoveryCase === "mixed"
        ? [
            makeConflict("figure.png", true),
            makeConflict("chapter.tex", false, "current"),
            makeConflict("data.bin", true),
          ]
        : recoveryCase?.startsWith("delete-")
          ? [
              makeConflict(
                "chapter.tex",
                false,
                recoveryCase === "delete-current" ? "current" : "incoming",
              ),
            ]
          : [
              makeConflict(
                recoveryCase === "text" ? "neurips_2026.tex" : "figure.png",
                recoveryCase !== "text",
              ),
            ];
  const resolvedImages = new Set<string>();
  let failResolution = recoveryCase === "fail";
  let rejectPush = startsWithPushRejected;
  win.__resolveGitConflictForHarness ??= () => {
    conflictActive = false;
    window.dispatchEvent(new CustomEvent("catalex:git-stats-refresh"));
  };
  win.__reopenGitConflictForHarness ??= () => {
    conflictActive = true;
    window.dispatchEvent(new CustomEvent("catalex:git-stats-refresh"));
  };
  let upstreamRemoteUrl: string | null = repoFound
    ? "git@github.com:example/current-paper.git"
    : null;
  let configuredRemotes = repoFound
    ? [
        {
          name: "origin",
          url: "git@github.com:example/current-paper.git",
          local_branch: "dev",
          remote_branch: "master",
        },
        {
          name: "overleaf",
          url: "https://git@git.overleaf.com/65539b39f4656f0f8017e6ff",
          local_branch: "master",
          remote_branch: "master",
        },
      ]
    : [];
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  win.__gitSetupCommands = [];

  win.__TAURI_INTERNALS__ = {
    ...existing,
    metadata: existing.metadata ?? {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback:
      existing.transformCallback ??
      ((callback, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (...args: unknown[]) => {
          callback(...args);
          if (once) callbacks.delete(id);
        });
        return id;
      }),
    unregisterCallback:
      existing.unregisterCallback ??
      ((id) => {
        callbacks.delete(id);
      }),
    invoke: async (
      cmd: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (cmd === "save_file_if_unchanged")
        return { written: true, current: args?.content };
      if (cmd === "plugin:fs|read_dir")
        return [...resolvedImages].map((name) => ({
          name,
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        }));
      if (cmd === "git_conflict_file_content" && recoveryCase) {
        const file = conflictActive
          ? recoveryFiles.find((entry) => entry.path === args?.filePath)
          : undefined;
        return {
          conflicted: Boolean(file),
          ancestor_content: file?.ancestor?.text,
          current_content: file?.current?.text ?? null,
          incoming_content: file?.incoming?.text ?? null,
        };
      }
      if (cmd === "git_panel_resolve_conflict" && recoveryCase) {
        win.__gitSetupCommands?.push({ command: cmd, args });
        recoveryFiles = recoveryFiles.filter(
          (entry) => entry.path !== args?.filePath,
        );
        conflictActive = recoveryFiles.length > 0;
        return { success: true, message: "Resolved text conflict" };
      }
      if (cmd === "git_panel_conflicts")
        return {
          rebasing: rebaseActive,
          files: conflictActive ? recoveryFiles : [],
        };
      if (cmd === "git_panel_resolve_conflict_side") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        if (failResolution) {
          failResolution = false;
          throw new Error(
            "Could not lock the Git index. Wait for other Git operations, then retry.",
          );
        }
        const file = recoveryFiles.find(
          (entry) => entry.path === args?.filePath,
        );
        if (!file || file.version !== args?.expectedVersion)
          throw new Error("The conflict changed. Refresh conflicts.");
        if (
          file.path.endsWith(".png") &&
          (args?.choice === "current" ? file.current : file.incoming)
        )
          resolvedImages.add(file.path);
        recoveryFiles = recoveryFiles.filter(
          (entry) => entry.path !== args?.filePath,
        );
        conflictActive = recoveryFiles.length > 0;
        return null;
      }
      if (cmd === "git_panel_status") {
        const hasDivergedRebase = rebaseCompleted && !remoteUpdated;
        const ahead = startsWithRebase
          ? hasDivergedRebase
            ? 2
            : 0
          : remoteUpdated
            ? 0
            : 1;
        return {
          repo_found: repoFound,
          branch: repoFound ? (startsWithRebase ? "dev" : "master") : null,
          upstream_branch: repoFound
            ? startsWithRebase
              ? "origin/dev"
              : "origin/master"
            : null,
          ahead,
          behind: hasDivergedRebase ? 1 : 0,
          staged:
            (mergeActive && !conflictActive && !startsWithZeroDiffMerge) ||
            (rebaseActive && !conflictActive)
              ? 1
              : 0,
          unstaged:
            repoFound &&
            !mergeActive &&
            !rebaseActive &&
            !startsWithPushRejected &&
            !committed &&
            !startsWithRebase
              ? 1
              : 0,
          untracked: 0,
          conflicted: conflictActive
            ? recoveryCase
              ? recoveryFiles.length
              : 1
            : 0,
          operation: mergeActive ? "merge" : rebaseActive ? "rebase" : null,
          can_push: repoFound && ahead > 0,
        };
      }
      if (cmd === "git_panel_changed_files") {
        if (
          ((startsWithPushRejected || committed) && !mergeActive) ||
          (startsWithRebase && !rebaseActive)
        )
          return [];
        return repoFound
          ? [
              {
                path: "neurips_2026.tex",
                staged:
                  (mergeActive || rebaseActive) &&
                  !conflictActive &&
                  !startsWithZeroDiffMerge,
                unstaged: !mergeActive && !rebaseActive,
                untracked: false,
                conflicted: conflictActive,
              },
            ]
          : [];
      }
      if (cmd === "git_worktree_file_line_stats") {
        return repoFound
          ? [{ file_path: "neurips_2026.tex", added: 2, deleted: 0 }]
          : [];
      }
      if (cmd === "git_panel_pull_status") {
        return { can_pull: false, behind: 0, behind_commits: [] };
      }
      if (cmd === "git_panel_history") {
        return [
          {
            hash: "abc1234",
            subject: "Review manuscript draft",
            author: "Writer",
            refs: ["HEAD -> master"],
            is_head: true,
          },
        ];
      }
      if (cmd === "git_panel_branches") {
        return [{ name: "master", is_current: true }];
      }
      if (cmd === "git_panel_graph") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        return [
          {
            hash: "cccccccccccccccccccccccccccccccccccccccc",
            short_hash: "ccccccc",
            parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            subject: "Local draft updates",
            author: "Hunter",
            committed_at: 1787552400,
            refs: ["HEAD -> dev"],
            is_head: true,
          },
          {
            hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            short_hash: "bbbbbbb",
            parents: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
            subject: "Overleaf updates",
            author: "Collaborator",
            committed_at: 1787546400,
            refs: ["main", "overleaf/main"],
            is_head: false,
          },
          {
            hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            short_hash: "aaaaaaa",
            parents: [],
            subject: "Shared base",
            author: "Hunter",
            committed_at: 1787460000,
            refs: [],
            is_head: false,
          },
        ];
      }
      if (cmd === "git_panel_rebase_onto") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        rebaseCompleted = true;
        rebaseNeedsForce =
          args?.targetCommit === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        return { success: true, message: "Rebased dev onto bbbbbbbb" };
      }
      if (cmd === "git_panel_continue_rebase") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        rebaseActive = false;
        conflictActive = false;
        rebaseCompleted = true;
        return { success: true, message: "Rebase completed" };
      }
      if (cmd === "git_panel_push") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        if (!rejectPush && retryResult === "failed") {
          throw new Error("Connection lost while pushing");
        }
        if (
          rejectPush ||
          retryResult === "rejected" ||
          (rebaseCompleted && rebaseNeedsForce)
        ) {
          throw new Error(
            "! [rejected] main -> main (fetch first) error: failed to push some refs hint: Updates were rejected because the remote contains work that you do not have locally.",
          );
        }
        remoteUpdated = true;
        return { success: true, message: "Push complete" };
      }
      if (cmd === "git_panel_push_recovery_preview") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        if (previewResult === "failed") throw new Error("Preview unavailable");
        return {
          remote_name: "overleaf",
          remote_branch: "main",
          conflicted_files:
            previewResult === "clean" || pullResult === "clean"
              ? []
              : ["main.tex", "references.bib"],
        };
      }
      if (cmd === "git_panel_pull") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        if (pullResult === "failed") throw new Error("Pull connection failed");
        rejectPush = false;
        if (pullResult === "clean") {
          return { success: true, message: "Pull complete" };
        }
        mergeActive = true;
        conflictActive = true;
        return {
          success: false,
          message: "Conflict detected. Resolve it to continue.",
        };
      }
      if (cmd === "git_panel_force_push") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        rejectPush = false;
        remoteUpdated = true;
        rebaseNeedsForce = false;
        return { success: true, message: "Force push complete" };
      }
      if (cmd === "git_panel_stash_list") {
        return [
          {
            reference: "stash@{0}",
            message: "WIP on master: 4aca421 Update on Overleaf.",
          },
          {
            reference: "stash@{1}",
            message: "WIP on master: 350c5e8 Update on Overleaf.",
          },
          {
            reference: "stash@{2}",
            message: "WIP on master: f5c61f1 Update on Overleaf.",
          },
          {
            reference: "stash@{3}",
            message: "WIP on master: b958d6f Update on Overleaf.",
          },
        ];
      }
      if (cmd === "git_panel_stash_files") {
        return ["neurips_2026.tex"];
      }
      if (cmd === "git_panel_abort_operation") {
        conflictActive = false;
        mergeActive = false;
        const operation = rebaseActive ? "rebase" : "merge";
        rebaseActive = false;
        return { success: true, message: `Aborted ${operation}` };
      }
      if (cmd === "git_panel_commit_selected") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        if (commitFails) throw new Error("Commit hook failed");
        committed = true;
        mergeActive = false;
        conflictActive = false;
        return { success: true, message: "merge completed" };
      }
      if (cmd === "git_project_init") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        repoFound = true;
        return null;
      }
      if (cmd === "git_project_complete_setup") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        repoFound = true;
        return {
          success: true,
          message: "Git repository initialized on main",
        };
      }
      if (cmd === "git_project_upstream_status") {
        return {
          remote_name: upstreamRemoteUrl ? "origin" : null,
          remote_url: upstreamRemoteUrl,
          upstream_branch: upstreamRemoteUrl ? "origin/master" : null,
          local_branch: "dev",
        };
      }
      if (cmd === "git_project_remote_configuration") {
        return {
          remotes: configuredRemotes,
          local_branches: ["dev", "master"],
          current_branch: "dev",
        };
      }
      if (cmd === "git_remote_inspect") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        await new Promise((resolve) => window.setTimeout(resolve, 150));
        if (String(args?.remoteUrl ?? "").includes("unreachable")) {
          throw new Error("The Git remote could not be reached");
        }
        if (
          String(args?.remoteUrl ?? "").includes("current-paper") ||
          String(args?.remoteUrl ?? "").includes("overleaf")
        ) {
          return { branches: ["master", "release"] };
        }
        return { branches: ["dev", "main", "release"] };
      }
      if (cmd === "git_project_save_remote") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        const originalName = args?.originalRemoteName;
        const nextRemote = {
          name: String(args?.remoteName ?? ""),
          url: String(args?.remoteUrl ?? ""),
          local_branch: String(args?.localBranch ?? ""),
          remote_branch: String(args?.upstreamBranch ?? ""),
        };
        if (typeof originalName === "string") {
          configuredRemotes = configuredRemotes.map((remote) =>
            remote.name === originalName ? nextRemote : remote,
          );
        } else {
          configuredRemotes = [...configuredRemotes, nextRemote];
        }
        return {
          success: true,
          message: `Git remote ${nextRemote.name} saved`,
        };
      }
      if (cmd === "git_project_delete_remote") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        const remoteName = String(args?.remoteName ?? "");
        configuredRemotes = configuredRemotes.filter(
          (remote) => remote.name !== remoteName,
        );
        return {
          success: true,
          message: `Git remote ${remoteName} deleted`,
        };
      }
      if (cmd === "git_project_connect_remote") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        repoFound = true;
        upstreamRemoteUrl = String(args?.remoteUrl ?? "");
        return {
          success: true,
          message: "Git upstream origin configured",
        };
      }
      if (cmd === "plugin:shell|open") {
        win.__gitSetupCommands?.push({ command: cmd, args });
        return null;
      }
      return existing.invoke ? existing.invoke(cmd, args) : null;
    },
  };
}

export function GitActionsHarness() {
  useAgentEvents();
  ensureDesktopBrowserMocks();
  ensureGitActionsHarnessTauriMocks();
  const harnessParams = new URLSearchParams(window.location.search);
  const startsWithPendingReview =
    harnessParams.get("suggestions") === "pending";
  const showStaticCommitExample =
    !harnessParams.has("conflict") &&
    !harnessParams.has("push") &&
    !harnessParams.has("rebase") &&
    !harnessParams.has("recovery");

  useEffect(() => {
    useDocumentStore.setState({
      projectRoot: "/tmp/catalex-git-actions-harness",
      files: [],
      folders: [],
      initialized: true,
    });
    const setPendingReview = (pending: boolean) => {
      useProposedChangesStore.setState({
        changes: pending
          ? [
              {
                id: "git-actions-pending-review",
                filePath: "neurips_2026.tex",
                absolutePath:
                  "/tmp/catalex-git-actions-harness/neurips_2026.tex",
                oldContent: "Original content",
                newContent: "Suggested content",
                toolName: "CodexEdit",
                timestamp: 1,
              },
            ]
          : [],
      });
    };
    setPendingReview(startsWithPendingReview);
    window.__setGitActionsPendingReview = setPendingReview;
    return () => {
      setPendingReview(false);
      delete window.__setGitActionsPendingReview;
    };
  }, [startsWithPendingReview]);

  if (harnessParams.has("workspace"))
    return (
      <div className="h-screen bg-background">
        <WorkspaceLayout />
      </div>
    );

  return (
    <div
      className={cn(
        "flex h-screen flex-col bg-background text-foreground",
        harnessParams.has("recovery") ? "gap-2 p-3" : "items-center gap-8 p-8",
      )}
    >
      <Toaster />
      <div
        data-git-actions-compact-root
        className={
          harnessParams.has("recovery")
            ? "flex w-full shrink-0 justify-end"
            : "flex w-[420px] justify-end"
        }
      >
        <GitActionsControl projectPath="/tmp/catalex-git-actions-harness" />
      </div>
      {showStaticCommitExample ? (
        <div className="w-[420px] rounded-[20px] bg-muted p-4 shadow-2xl">
          <h1 className="mb-4 font-semibold text-xl">Commit your changes</h1>
          <div className="space-y-1.5">
            <div className="font-semibold text-foreground text-sm">
              Modified files
            </div>
            <div className="max-h-44 overflow-y-auto">
              <button
                type="button"
                className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border border-foreground bg-foreground text-background",
                  )}
                >
                  <CheckIcon className="size-3" />
                </span>
                <span className="min-w-0 flex-1 truncate">Select All</span>
              </button>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 py-2 text-left text-sm",
                  "border-sidebar-border border-b last:border-b-0",
                )}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-sm border border-foreground bg-foreground text-background",
                  )}
                >
                  <CheckIcon className="size-3" />
                </span>
                <Hint content={LONG_PATH}>
                  <span
                    data-testid="git-actions-path-label"
                    className="min-w-0 flex-1 truncate text-foreground"
                  >
                    {truncatePathLabel(LONG_PATH)}
                  </span>
                </Hint>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="font-medium text-[10px] text-emerald-600">
                    +2
                  </span>
                  <span className="rounded border border-sidebar-border px-1.5 py-0.5 text-[10px]">
                    unstaged
                  </span>
                </div>
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
