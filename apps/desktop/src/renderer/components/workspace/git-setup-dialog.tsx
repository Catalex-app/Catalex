import { CheckboxIndicator } from "@/components/ui/checkbox";
import { Hint } from "@/components/ui/tooltip";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@/lib/desktop/core";
import { open as openExternal } from "@/lib/desktop/shell";
import {
  ArrowRightIcon,
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  CloudIcon,
  ExternalLinkIcon,
  GithubIcon,
  GitBranchIcon,
  LaptopIcon,
  Loader2Icon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  formatGitCommand,
  GitCommandDisclosure,
} from "./git-command-disclosure";

interface GitCommandResult {
  success: boolean;
  message: string;
}

interface GitRemoteEntry {
  name: string;
  url: string;
  local_branch: string | null;
  remote_branch: string | null;
}

interface GitRemoteConfiguration {
  remotes: GitRemoteEntry[];
  local_branches: string[];
  current_branch: string | null;
}

interface GitRemoteInspection {
  branches: string[];
}

interface DraftRemoteEntry extends GitRemoteEntry {
  draftId: string;
  originalName: string | null;
  changed: boolean;
  deleted: boolean;
}

interface InitialRemoteDraft {
  name: string;
  url: string;
  localBranch: string;
  upstreamBranch: string | null;
}

interface GitSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath: string;
  hasRepository: boolean;
  showGitCommand: boolean;
  onShowGitCommandChange: (expanded: boolean) => void;
  onRepositoryReady: () => Promise<void>;
}

type RemoteAction = "apply" | "discard";
type RemoteEditorTarget =
  | { kind: "existing"; id: string }
  | { kind: "new" }
  | null;

function formatError(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return "Git setup failed.";
}

function preferredRemoteBranch(
  branches: string[],
  preferredBranch?: string | null,
): string {
  if (preferredBranch && branches.includes(preferredBranch)) {
    return preferredBranch;
  }
  return (
    branches.find((branch) => branch === "master") ??
    branches.find((branch) => branch === "main") ??
    branches[0] ??
    ""
  );
}

const DEFAULT_GITIGNORE = `# Editor and OS files
.DS_Store
Thumbs.db

# LaTeX build files
*.aux
*.bbl
*.blg
*.fdb_latexmk
*.fls
*.log
*.out
*.synctex.gz
*.toc`;

export function GitSetupDialog({
  open,
  onOpenChange,
  projectPath,
  hasRepository,
  showGitCommand,
  onShowGitCommandChange,
  onRepositoryReady,
}: GitSetupDialogProps) {
  const [remoteEditorTarget, setRemoteEditorTarget] =
    useState<RemoteEditorTarget>(null);
  const [remoteConfiguration, setRemoteConfiguration] =
    useState<GitRemoteConfiguration | null>(null);
  const [draftRemotes, setDraftRemotes] = useState<DraftRemoteEntry[]>([]);
  const [selectedRemoteIds, setSelectedRemoteIds] = useState<string[]>([]);
  const [remoteAction, setRemoteAction] = useState<RemoteAction>("apply");
  const [isLoadingRemotes, setIsLoadingRemotes] = useState(false);
  const [originalRemoteName, setOriginalRemoteName] = useState<string | null>(
    null,
  );
  const [remoteName, setRemoteName] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [selectedLocalBranch, setSelectedLocalBranch] = useState("");
  const [selectedRemoteBranch, setSelectedRemoteBranch] = useState("");
  const [remoteInspection, setRemoteInspection] =
    useState<GitRemoteInspection | null>(null);
  const [isInspectingRemote, setIsInspectingRemote] = useState(false);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [includeGitignore, setIncludeGitignore] = useState(true);
  const [gitignoreContent, setGitignoreContent] = useState(DEFAULT_GITIGNORE);
  const [initialRemoteDraft, setInitialRemoteDraft] =
    useState<InitialRemoteDraft | null>(null);
  const inspectRequestIdRef = useRef(0);
  const draftRemoteIdRef = useRef(0);

  const clearRemoteInspection = useCallback(() => {
    inspectRequestIdRef.current += 1;
    setRemoteInspection(null);
    setSelectedRemoteBranch("");
    setInspectionError(null);
    setIsInspectingRemote(false);
  }, []);

  const loadRemoteConfiguration = useCallback(async () => {
    setIsLoadingRemotes(true);
    try {
      const configuration = await invoke<GitRemoteConfiguration>(
        "git_project_remote_configuration",
        { projectRoot: projectPath },
      );
      setRemoteConfiguration(configuration);
      setDraftRemotes(
        configuration.remotes.map((remote) => ({
          ...remote,
          draftId: remote.name,
          originalName: remote.name,
          changed: false,
          deleted: false,
        })),
      );
      setSelectedRemoteIds([]);
      return configuration;
    } finally {
      setIsLoadingRemotes(false);
    }
  }, [projectPath]);

  const inspectRemote = useCallback(
    async (nextRemoteUrl: string, preferredBranch?: string | null) => {
      const trimmedRemoteUrl = nextRemoteUrl.trim();
      if (!trimmedRemoteUrl) return;
      const requestId = ++inspectRequestIdRef.current;
      setIsInspectingRemote(true);
      setInspectionError(null);
      if (!preferredBranch) {
        setRemoteInspection(null);
      }
      setSelectedRemoteBranch(preferredBranch ?? "");
      try {
        const inspection = await invoke<GitRemoteInspection>(
          "git_remote_inspect",
          { remoteUrl: trimmedRemoteUrl },
        );
        if (inspectRequestIdRef.current !== requestId) return;
        setRemoteInspection(inspection);
        setSelectedRemoteBranch(
          inspection.branches.length > 0
            ? preferredRemoteBranch(inspection.branches, preferredBranch)
            : hasRepository
              ? ""
              : "main",
        );
      } catch (error) {
        if (inspectRequestIdRef.current !== requestId) return;
        setInspectionError(formatError(error));
      } finally {
        if (inspectRequestIdRef.current === requestId) {
          setIsInspectingRemote(false);
        }
      }
    },
    [hasRepository],
  );

  const showRemoteForm = useCallback(
    (remote?: DraftRemoteEntry) => {
      clearRemoteInspection();
      setOriginalRemoteName(remote?.name ?? null);
      setRemoteName(remote?.name ?? (hasRepository ? "" : "origin"));
      setRemoteUrl(remote?.url ?? "");
      setSelectedLocalBranch(
        remote?.local_branch ??
          remoteConfiguration?.current_branch ??
          remoteConfiguration?.local_branches[0] ??
          (hasRepository ? "" : "main"),
      );
      setSelectedRemoteBranch(remote?.remote_branch ?? "");
      setRemoteInspection(
        remote?.remote_branch ? { branches: [remote.remote_branch] } : null,
      );
      setRemoteEditorTarget(
        remote ? { kind: "existing", id: remote.draftId } : { kind: "new" },
      );
      if (remote?.url) {
        const inspectionGeneration = inspectRequestIdRef.current;
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            if (inspectRequestIdRef.current !== inspectionGeneration) return;
            void inspectRemote(remote.url, remote.remote_branch);
          });
        });
      }
    },
    [clearRemoteInspection, hasRepository, inspectRemote, remoteConfiguration],
  );

  useEffect(() => {
    if (!open) return;
    setRemoteEditorTarget(null);
    setRemoteConfiguration(null);
    setDraftRemotes([]);
    setSelectedRemoteIds([]);
    setRemoteAction("apply");
    setOriginalRemoteName(null);
    setRemoteName(hasRepository ? "" : "origin");
    setRemoteUrl("");
    setSelectedLocalBranch(hasRepository ? "" : "main");
    setIncludeGitignore(true);
    setGitignoreContent(DEFAULT_GITIGNORE);
    setInitialRemoteDraft(null);
    clearRemoteInspection();
    if (!hasRepository) {
      setIsLoadingRemotes(false);
      return;
    }

    let cancelled = false;
    void loadRemoteConfiguration().catch((error) => {
      if (!cancelled) toast.error(formatError(error));
    });
    return () => {
      cancelled = true;
    };
  }, [clearRemoteInspection, hasRepository, loadRemoteConfiguration, open]);

  const saveRemote = useCallback(async () => {
    const nextRemoteName = remoteName.trim();
    const nextRemoteUrl = remoteUrl.trim();
    if (
      !nextRemoteName ||
      !nextRemoteUrl ||
      isWorking ||
      !remoteInspection ||
      !selectedLocalBranch ||
      !selectedRemoteBranch
    ) {
      return;
    }
    if (hasRepository) {
      const nextRemote: GitRemoteEntry = {
        name: nextRemoteName,
        url: nextRemoteUrl,
        local_branch: selectedLocalBranch,
        remote_branch: selectedRemoteBranch,
      };
      if (remoteEditorTarget?.kind === "existing") {
        const currentRemote = draftRemotes.find(
          (remote) => remote.draftId === remoteEditorTarget.id,
        );
        if (!currentRemote) return;
        const original = currentRemote.originalName
          ? remoteConfiguration?.remotes.find(
              (entry) => entry.name === currentRemote.originalName,
            )
          : null;
        const changed =
          !original ||
          original.name !== nextRemote.name ||
          original.url !== nextRemote.url ||
          original.local_branch !== nextRemote.local_branch ||
          original.remote_branch !== nextRemote.remote_branch;
        setDraftRemotes((current) =>
          current.map((remote) =>
            remote.draftId === remoteEditorTarget.id
              ? {
                  ...nextRemote,
                  draftId: remote.draftId,
                  originalName: remote.originalName,
                  changed,
                  deleted: false,
                }
              : remote,
          ),
        );
        setSelectedRemoteIds((current) =>
          changed
            ? current.includes(currentRemote.draftId)
              ? current
              : [...current, currentRemote.draftId]
            : current.filter((id) => id !== currentRemote.draftId),
        );
      } else {
        draftRemoteIdRef.current += 1;
        const draftId = `new-${draftRemoteIdRef.current}`;
        setDraftRemotes((current) => [
          ...current,
          {
            ...nextRemote,
            draftId,
            originalName: null,
            changed: true,
            deleted: false,
          },
        ]);
        setSelectedRemoteIds((current) => [...current, draftId]);
      }
      setRemoteEditorTarget(null);
      clearRemoteInspection();
      return;
    }

    setInitialRemoteDraft({
      name: nextRemoteName,
      url: nextRemoteUrl,
      localBranch: selectedLocalBranch,
      upstreamBranch:
        remoteInspection.branches.length > 0 ? selectedRemoteBranch : null,
    });
    setRemoteEditorTarget(null);
    setOriginalRemoteName(null);
    clearRemoteInspection();
  }, [
    clearRemoteInspection,
    draftRemotes,
    hasRepository,
    isWorking,
    remoteConfiguration,
    remoteEditorTarget,
    remoteInspection,
    remoteName,
    remoteUrl,
    selectedLocalBranch,
    selectedRemoteBranch,
  ]);

  const pendingRemotes = draftRemotes.filter((remote) => remote.changed);
  const selectedPendingCount = pendingRemotes.filter((remote) =>
    selectedRemoteIds.includes(remote.draftId),
  ).length;
  const selectedPendingRemotes = pendingRemotes.filter((remote) =>
    selectedRemoteIds.includes(remote.draftId),
  );
  const remoteActionCommands =
    remoteAction === "discard"
      ? []
      : selectedPendingRemotes.flatMap((remote) => {
          if (remote.deleted) {
            return [
              formatGitCommand([
                "remote",
                "remove",
                remote.originalName ?? remote.name,
              ]),
            ];
          }

          const commands: string[] = [];
          if (!remote.originalName) {
            commands.push(
              formatGitCommand(["remote", "add", remote.name, remote.url]),
            );
          } else {
            if (remote.originalName !== remote.name) {
              commands.push(
                formatGitCommand([
                  "remote",
                  "rename",
                  remote.originalName,
                  remote.name,
                ]),
              );
            }
            commands.push(
              formatGitCommand(["remote", "set-url", remote.name, remote.url]),
            );
          }
          if (remote.local_branch && remote.remote_branch) {
            commands.push(
              formatGitCommand([
                "fetch",
                remote.name,
                `refs/heads/${remote.remote_branch}:refs/remotes/${remote.name}/${remote.remote_branch}`,
              ]),
              formatGitCommand([
                "branch",
                "--set-upstream-to",
                `${remote.name}/${remote.remote_branch}`,
                remote.local_branch,
              ]),
            );
          }
          return commands;
        });
  const initialSetupCommands = [
    formatGitCommand(["init", "-b", "main"]),
    ...(initialRemoteDraft
      ? [
          formatGitCommand([
            "remote",
            "add",
            initialRemoteDraft.name,
            initialRemoteDraft.url,
          ]),
          ...(initialRemoteDraft.upstreamBranch
            ? [
                formatGitCommand([
                  "fetch",
                  initialRemoteDraft.name,
                  `refs/heads/${initialRemoteDraft.upstreamBranch}:refs/remotes/${initialRemoteDraft.name}/${initialRemoteDraft.upstreamBranch}`,
                ]),
                formatGitCommand([
                  "branch",
                  "--set-upstream-to",
                  `${initialRemoteDraft.name}/${initialRemoteDraft.upstreamBranch}`,
                  initialRemoteDraft.localBranch,
                ]),
              ]
            : []),
        ]
      : []),
  ];

  const deleteRemoteDraft = useCallback(
    (remoteToDelete: DraftRemoteEntry) => {
      if (!remoteToDelete.originalName) {
        setSelectedRemoteIds((selected) =>
          selected.filter((id) => id !== remoteToDelete.draftId),
        );
      }
      if (remoteToDelete.originalName) {
        setSelectedRemoteIds((selected) =>
          selected.includes(remoteToDelete.draftId)
            ? selected
            : [...selected, remoteToDelete.draftId],
        );
      }
      setDraftRemotes((current) => {
        const target = current.find(
          (remote) => remote.draftId === remoteToDelete.draftId,
        );
        if (!target) return current;
        if (!target.originalName) {
          return current.filter(
            (remote) => remote.draftId !== remoteToDelete.draftId,
          );
        }
        return current.map((remote) =>
          remote.draftId === remoteToDelete.draftId
            ? { ...remote, changed: true, deleted: true }
            : remote,
        );
      });
      setRemoteEditorTarget(null);
      clearRemoteInspection();
    },
    [clearRemoteInspection],
  );

  const restoreRemoteDraft = useCallback(
    (remoteToRestore: DraftRemoteEntry) => {
      const original = remoteToRestore.originalName
        ? remoteConfiguration?.remotes.find(
            (entry) => entry.name === remoteToRestore.originalName,
          )
        : null;
      const changed =
        !original ||
        original.name !== remoteToRestore.name ||
        original.url !== remoteToRestore.url ||
        original.local_branch !== remoteToRestore.local_branch ||
        original.remote_branch !== remoteToRestore.remote_branch;
      setDraftRemotes((current) =>
        current.map((remote) =>
          remote.draftId === remoteToRestore.draftId
            ? { ...remote, deleted: false, changed }
            : remote,
        ),
      );
      setSelectedRemoteIds((current) =>
        changed
          ? current.includes(remoteToRestore.draftId)
            ? current
            : [...current, remoteToRestore.draftId]
          : current.filter((id) => id !== remoteToRestore.draftId),
      );
    },
    [remoteConfiguration],
  );

  const continueRemoteAction = useCallback(async () => {
    const selectedPendingRemotes = pendingRemotes.filter((remote) =>
      selectedRemoteIds.includes(remote.draftId),
    );
    if (
      isWorking ||
      remoteEditorTarget ||
      selectedPendingRemotes.length === 0
    ) {
      return;
    }
    if (remoteAction === "discard") {
      const discardedRemoteIds = new Set(
        selectedPendingRemotes.map((remote) => remote.draftId),
      );
      setDraftRemotes((current) =>
        current.flatMap((remote) => {
          if (!selectedRemoteIds.includes(remote.draftId) || !remote.changed) {
            return [remote];
          }
          if (!remote.originalName) return [];
          const original = remoteConfiguration?.remotes.find(
            (entry) => entry.name === remote.originalName,
          );
          return original
            ? [
                {
                  ...original,
                  draftId: remote.draftId,
                  originalName: original.name,
                  changed: false,
                  deleted: false,
                },
              ]
            : [];
        }),
      );
      setSelectedRemoteIds((current) =>
        current.filter((id) => !discardedRemoteIds.has(id)),
      );
      if (pendingRemotes.length === selectedPendingRemotes.length) {
        onOpenChange(false);
      }
      return;
    }

    setIsWorking(true);
    try {
      const orderedRemotes = [...selectedPendingRemotes].sort(
        (left, right) => Number(right.deleted) - Number(left.deleted),
      );
      for (const remote of orderedRemotes) {
        if (remote.deleted) {
          await invoke<GitCommandResult>("git_project_delete_remote", {
            projectRoot: projectPath,
            remoteName: remote.originalName ?? remote.name,
          });
          setDraftRemotes((current) =>
            current.filter((entry) => entry.draftId !== remote.draftId),
          );
          setSelectedRemoteIds((current) =>
            current.filter((id) => id !== remote.draftId),
          );
          setRemoteConfiguration((current) =>
            current
              ? {
                  ...current,
                  remotes: current.remotes.filter(
                    (entry) => entry.name !== remote.originalName,
                  ),
                }
              : current,
          );
          continue;
        }

        await invoke<GitCommandResult>("git_project_save_remote", {
          projectRoot: projectPath,
          originalRemoteName: remote.originalName,
          remoteName: remote.name,
          remoteUrl: remote.url,
          localBranch: remote.local_branch,
          upstreamBranch: remote.remote_branch,
        });
        setDraftRemotes((current) =>
          current.map((entry) =>
            entry.draftId === remote.draftId
              ? {
                  ...entry,
                  originalName: entry.name,
                  changed: false,
                }
              : entry,
          ),
        );
        setSelectedRemoteIds((current) =>
          current.filter((id) => id !== remote.draftId),
        );
        setRemoteConfiguration((current) => {
          if (!current) return current;
          const appliedRemote: GitRemoteEntry = {
            name: remote.name,
            url: remote.url,
            local_branch: remote.local_branch,
            remote_branch: remote.remote_branch,
          };
          const hasOriginal = remote.originalName
            ? current.remotes.some(
                (entry) => entry.name === remote.originalName,
              )
            : false;
          return {
            ...current,
            remotes: hasOriginal
              ? current.remotes.map((entry) =>
                  entry.name === remote.originalName ? appliedRemote : entry,
                )
              : [...current.remotes, appliedRemote],
          };
        });
      }
      await onRepositoryReady();
      toast.success(
        selectedPendingRemotes.length === 1
          ? "Git remote change applied"
          : `${selectedPendingRemotes.length} Git remote changes applied`,
      );
      if (pendingRemotes.length === selectedPendingRemotes.length) {
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setIsWorking(false);
    }
  }, [
    isWorking,
    onOpenChange,
    onRepositoryReady,
    pendingRemotes,
    projectPath,
    remoteAction,
    remoteConfiguration,
    remoteEditorTarget,
    selectedRemoteIds,
  ]);

  const openGithubNewRepository = useCallback(async () => {
    try {
      await openExternal("https://github.com/new");
    } catch (error) {
      toast.error(formatError(error));
    }
  }, []);

  const cancelRemoteEdit = useCallback(() => {
    clearRemoteInspection();
    setRemoteEditorTarget(null);
  }, [clearRemoteInspection]);

  const showInitialRemoteForm = useCallback(() => {
    if (!initialRemoteDraft) {
      showRemoteForm();
      return;
    }
    showRemoteForm({
      name: initialRemoteDraft.name,
      url: initialRemoteDraft.url,
      local_branch: initialRemoteDraft.localBranch,
      remote_branch: initialRemoteDraft.upstreamBranch ?? "main",
      draftId: "initial-remote",
      originalName: initialRemoteDraft.name,
      changed: true,
      deleted: false,
    });
  }, [initialRemoteDraft, showRemoteForm]);

  const canSaveRemote =
    Boolean(remoteName.trim()) &&
    Boolean(remoteUrl.trim()) &&
    !isWorking &&
    Boolean(remoteInspection) &&
    Boolean(selectedLocalBranch) &&
    Boolean(selectedRemoteBranch) &&
    !isInspectingRemote;

  const completeInitialSetup = useCallback(async () => {
    if (isWorking) return;
    setIsWorking(true);
    try {
      await invoke<GitCommandResult>("git_project_complete_setup", {
        projectRoot: projectPath,
        gitignoreContent: includeGitignore
          ? gitignoreContent.trim() || DEFAULT_GITIGNORE
          : null,
      });
      if (initialRemoteDraft) {
        await invoke<GitCommandResult>("git_project_connect_remote", {
          projectRoot: projectPath,
          remoteUrl: initialRemoteDraft.url,
          remoteName: initialRemoteDraft.name,
          upstreamBranch: initialRemoteDraft.upstreamBranch,
        });
      }
      onOpenChange(false);
      await onRepositoryReady();
      toast.success(
        initialRemoteDraft
          ? `Git repository initialized and connected to ${initialRemoteDraft.name}`
          : "Git repository initialized on main",
      );
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setIsWorking(false);
    }
  }, [
    gitignoreContent,
    includeGitignore,
    initialRemoteDraft,
    isWorking,
    onOpenChange,
    onRepositoryReady,
    projectPath,
  ]);

  const remoteEditorContent = (
    <div
      className="space-y-2"
      data-testid={
        originalRemoteName
          ? `git-remote-editor-${originalRemoteName}`
          : "git-remote-editor-new"
      }
    >
      <div className="flex items-center gap-2">
        <label
          htmlFor="git-remote-name"
          className="w-12 shrink-0 font-semibold text-foreground text-sm"
        >
          Name:
        </label>
        <Input
          id="git-remote-name"
          value={remoteName}
          onChange={(event) => setRemoteName(event.target.value)}
          placeholder="origin"
          className="h-8 min-w-0 flex-1 rounded-lg bg-background dark:bg-muted"
          disabled={isWorking}
          autoFocus={hasRepository && !originalRemoteName}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <label
            htmlFor="git-remote-url"
            className="w-12 shrink-0 font-semibold text-foreground text-sm"
          >
            URL:
          </label>
          <div className="relative min-w-0 flex-1">
            <Input
              id="git-remote-url"
              value={remoteUrl}
              onChange={(event) => {
                setRemoteUrl(event.target.value);
                clearRemoteInspection();
              }}
              placeholder="https://github.com/you/project.git"
              className="h-8 rounded-lg bg-background pr-10 dark:bg-muted"
              disabled={isWorking}
              autoFocus={!hasRepository}
              onBlur={() => {
                if (!remoteInspection && !isInspectingRemote) {
                  void inspectRemote(remoteUrl);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void inspectRemote(remoteUrl);
                }
              }}
            />
            {remoteUrl.trim() ? (
              <span
                role="status"
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center"
                aria-label={
                  isInspectingRemote
                    ? "Verifying remote"
                    : inspectionError
                      ? "Remote verification failed"
                      : remoteInspection
                        ? "Remote verified"
                        : undefined
                }
              >
                {isInspectingRemote ? (
                  <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
                ) : inspectionError ? (
                  <CircleXIcon className="size-4 text-destructive" />
                ) : remoteInspection ? (
                  <CircleCheckIcon className="size-4 text-emerald-600" />
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
        {inspectionError ? (
          <div className="pl-14 text-destructive text-xs">
            {inspectionError}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <LaptopIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {hasRepository ? (
            <Select
              value={selectedLocalBranch || undefined}
              onValueChange={setSelectedLocalBranch}
              disabled={!remoteConfiguration?.local_branches.length}
            >
              <SelectTrigger
                aria-label="Local branch"
                className="h-8 w-full rounded-lg bg-background shadow-none dark:bg-muted"
              >
                <SelectValue placeholder="Local branch" />
              </SelectTrigger>
              <SelectContent className="rounded-xl" position="popper">
                {remoteConfiguration?.local_branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>
                    {branch}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              aria-label="Local branch"
              value="main"
              disabled
              className="h-8 w-full rounded-lg bg-muted-foreground/10 font-mono text-muted-foreground shadow-none"
            />
          )}
        </div>
        <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <CloudIcon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <Select
            value={selectedRemoteBranch || undefined}
            onValueChange={setSelectedRemoteBranch}
            disabled={!remoteInspection || isInspectingRemote}
          >
            <SelectTrigger
              aria-label="Remote branch"
              className="h-8 w-full rounded-lg bg-background shadow-none dark:bg-muted"
            >
              <SelectValue
                placeholder={
                  isInspectingRemote
                    ? "Verifying..."
                    : remoteInspection
                      ? "Remote branch"
                      : "No remote branches"
                }
              />
            </SelectTrigger>
            <SelectContent position="popper" align="end" className="rounded-xl">
              {(remoteInspection?.branches.length
                ? remoteInspection.branches
                : remoteInspection && !hasRepository
                  ? ["main"]
                  : []
              ).map((branch) => (
                <SelectItem key={branch} value={branch}>
                  {branch}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );

  const remoteEditorActions = (
    <>
      <Hint content={originalRemoteName ? "Save changes" : "Add remote"}>
        <button
          type="button"
          aria-label={originalRemoteName ? "Save changes" : "Add remote"}
          className="flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => void saveRemote()}
          disabled={!canSaveRemote}
        >
          <SaveIcon className="size-3.5" />
        </button>
      </Hint>
      <Hint content="Cancel">
        <button
          type="button"
          aria-label="Cancel"
          className="flex size-6 shrink-0 items-center justify-center border-muted-foreground/10 border-t text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          onClick={cancelRemoteEdit}
          disabled={isWorking}
        >
          <XIcon className="size-3.5" />
        </button>
      </Hint>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 rounded-[20px] bg-muted p-4 shadow-2xl sm:max-w-[480px] dark:bg-background"
        overlayClassName="bg-black/10"
        showCloseButton={false}
        data-testid="git-setup-dialog"
      >
        <DialogHeader className="space-y-3">
          <DialogIconHeader closeDisabled={isWorking}>
            <GitBranchIcon />
          </DialogIconHeader>
          <DialogTitle>
            {hasRepository ? "Git remote configuration" : "Set up Git"}
          </DialogTitle>
        </DialogHeader>

        {hasRepository ? (
          <div className="app-scrollbar min-h-0 min-w-0 space-y-4 overflow-y-auto pt-3 pr-1">
            <RemoteList
              remotes={draftRemotes}
              isLoading={isLoadingRemotes}
              onEdit={showRemoteForm}
              onDelete={deleteRemoteDraft}
              onRestore={restoreRemoteDraft}
              selectedRemoteIds={selectedRemoteIds}
              onSelectionChange={setSelectedRemoteIds}
              onAdd={() => showRemoteForm()}
              onCreateGithub={openGithubNewRepository}
              editorTarget={remoteEditorTarget}
              editor={remoteEditorContent}
              editorActions={remoteEditorActions}
            />
            <RemoteActionSelector
              value={remoteAction}
              onChange={setRemoteAction}
              selectedCount={selectedRemoteIds.length}
              disabled={
                pendingRemotes.length === 0 || selectedRemoteIds.length === 0
              }
              commands={remoteActionCommands}
              showGitCommand={showGitCommand}
              onShowGitCommandChange={onShowGitCommandChange}
            />
          </div>
        ) : (
          <div className="app-scrollbar min-h-0 min-w-0 overflow-y-auto pr-1">
            <div className="space-y-1.5 border-sidebar-border border-b pb-4">
              <button
                type="button"
                role="checkbox"
                aria-checked={includeGitignore}
                className="flex w-full items-center gap-2 py-2 text-left font-medium text-sm"
                onClick={() =>
                  setIncludeGitignore((current) => {
                    if (!current && !gitignoreContent) {
                      setGitignoreContent(DEFAULT_GITIGNORE);
                    }
                    return !current;
                  })
                }
                disabled={isWorking}
              >
                <CheckboxIndicator checked={includeGitignore} />
                <span>Create .gitignore</span>
              </button>
              {includeGitignore ? (
                <Textarea
                  aria-label=".gitignore content"
                  value={gitignoreContent}
                  onChange={(event) => setGitignoreContent(event.target.value)}
                  className="field-sizing-fixed h-56 min-h-32 resize-y rounded-xl bg-background font-mono text-xs leading-relaxed dark:bg-muted"
                  disabled={isWorking}
                />
              ) : null}
            </div>
            <div className="-ml-1 overflow-visible pl-1">
              {remoteEditorTarget !== null ? (
                <div
                  className="flex items-start gap-3 py-3"
                  data-testid="git-remote-new-row"
                >
                  <RemoteRowActionRail actionLabel="New remote actions">
                    {remoteEditorActions}
                  </RemoteRowActionRail>
                  <div className="min-w-0 flex-1">{remoteEditorContent}</div>
                </div>
              ) : (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 py-3 text-left font-medium text-sm transition-colors hover:text-foreground disabled:opacity-50"
                  onClick={showInitialRemoteForm}
                  disabled={isWorking}
                >
                  <PlusIcon className="size-4 text-muted-foreground" />
                  Add remote
                </button>
              )}
              <GithubNewRepositoryButton onClick={openGithubNewRepository} />
            </div>
            <div className="space-y-1.5 border-sidebar-border border-t pt-4">
              <div className="font-semibold text-foreground text-sm">
                Action
              </div>
              <div className="flex items-center justify-between rounded-xl border border-border/70 bg-background py-2 pr-3 pl-2 text-sm dark:bg-muted">
                <span className="inline-flex items-center gap-2">
                  <GitBranchIcon className="size-3.5 text-muted-foreground" />
                  <span>Initialize repository</span>
                </span>
                <CheckIcon className="size-4 text-foreground" />
              </div>
              <GitCommandDisclosure
                commands={initialSetupCommands}
                expanded={showGitCommand}
                onExpandedChange={onShowGitCommandChange}
              />
            </div>
          </div>
        )}

        {hasRepository ? (
          <DialogFooter>
            <Button
              type="button"
              className="rounded-lg"
              onClick={() => void continueRemoteAction()}
              disabled={
                isWorking ||
                remoteEditorTarget !== null ||
                selectedPendingCount === 0
              }
            >
              {isWorking ? "Applying..." : "Continue"}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <Button
              type="button"
              className="rounded-lg"
              onClick={() => void completeInitialSetup()}
              disabled={isWorking || remoteEditorTarget !== null}
            >
              {isWorking ? "Initializing..." : "Initialize"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RemoteList({
  remotes,
  isLoading,
  onEdit,
  onDelete,
  onRestore,
  selectedRemoteIds,
  onSelectionChange,
  onAdd,
  onCreateGithub,
  editorTarget,
  editor,
  editorActions,
}: {
  remotes: DraftRemoteEntry[];
  isLoading: boolean;
  onEdit: (remote: DraftRemoteEntry) => void;
  onDelete: (remote: DraftRemoteEntry) => void;
  onRestore: (remote: DraftRemoteEntry) => void;
  selectedRemoteIds: string[];
  onSelectionChange: (ids: string[]) => void;
  onAdd: () => void;
  onCreateGithub: () => Promise<void>;
  editorTarget: RemoteEditorTarget;
  editor: ReactNode;
  editorActions: ReactNode;
}) {
  const configuredRemotes = remotes.filter((remote) => !remote.changed);
  const modifiedRemotes = remotes.filter((remote) => remote.changed);
  const orderedRemotes = [...configuredRemotes, ...modifiedRemotes];
  const showConfiguredHeading =
    configuredRemotes.length > 0 || modifiedRemotes.length === 0;
  const allSelected =
    modifiedRemotes.length > 0 &&
    selectedRemoteIds.length === modifiedRemotes.length;
  const toggleAll = () => {
    onSelectionChange(
      allSelected ? [] : modifiedRemotes.map((remote) => remote.draftId),
    );
  };

  return (
    <div className="min-w-0 space-y-1.5">
      {showConfiguredHeading ? (
        <div className="font-semibold text-foreground text-sm">
          Configured Remote
        </div>
      ) : null}
      <div className="-ml-1 max-h-[calc(100vh-23rem)] overflow-y-auto pl-1">
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            Loading remotes...
          </div>
        ) : (
          orderedRemotes.map((remote, index) => {
            const isEditing =
              editorTarget?.kind === "existing" &&
              editorTarget.id === remote.draftId;
            const isSelected = selectedRemoteIds.includes(remote.draftId);
            const isFirstModified =
              remote.changed &&
              (index === 0 || !orderedRemotes[index - 1]?.changed);
            return (
              <Fragment key={remote.draftId}>
                {isFirstModified ? (
                  <>
                    <div
                      className={`flex items-center justify-between ${
                        configuredRemotes.length > 0 ? "mt-4" : ""
                      }`}
                    >
                      <div className="font-semibold text-foreground text-sm">
                        Modified Remote
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {selectedRemoteIds.length}/{modifiedRemotes.length}{" "}
                        selected
                      </div>
                    </div>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 border-sidebar-border border-b py-2 text-left text-sm transition-colors"
                      onClick={toggleAll}
                    >
                      <CheckboxIndicator checked={allSelected} />
                      <span className="min-w-0 flex-1 truncate">
                        Select All
                      </span>
                    </button>
                  </>
                ) : null}
                <div
                  className="border-sidebar-border border-b py-3"
                  data-testid={`git-remote-row-${remote.name}`}
                  data-pending-change={remote.changed ? "true" : undefined}
                  data-pending-delete={remote.deleted ? "true" : undefined}
                >
                  <div className="flex items-start gap-3">
                    <RemoteRowActionRail
                      actionLabel={
                        isEditing
                          ? `Edit remote ${remote.name} actions`
                          : `Remote ${remote.name} actions`
                      }
                      checkboxLabel={
                        remote.changed
                          ? `Select remote ${remote.name}`
                          : undefined
                      }
                      selected={isSelected}
                      onSelectedChange={() =>
                        onSelectionChange(
                          isSelected
                            ? selectedRemoteIds.filter(
                                (id) => id !== remote.draftId,
                              )
                            : [...selectedRemoteIds, remote.draftId],
                        )
                      }
                      showCheckbox={remote.changed && !isEditing}
                    >
                      {isEditing ? (
                        editorActions
                      ) : (
                        <>
                          <Hint content={`Edit remote ${remote.name}`}>
                            <button
                              type="button"
                              aria-label={`Edit remote ${remote.name}`}
                              className="flex size-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
                              onClick={() => onEdit(remote)}
                            >
                              <PencilIcon className="size-3.5" />
                            </button>
                          </Hint>
                          <Hint
                            content={
                              remote.deleted
                                ? `Undo delete remote ${remote.name}`
                                : `Delete remote ${remote.name}`
                            }
                          >
                            <button
                              type="button"
                              aria-label={
                                remote.deleted
                                  ? `Undo delete remote ${remote.name}`
                                  : `Delete remote ${remote.name}`
                              }
                              className={`flex size-6 shrink-0 items-center justify-center border-muted-foreground/10 border-t transition-colors hover:bg-orange-500/15 hover:text-orange-400 ${
                                remote.deleted
                                  ? "text-orange-400"
                                  : "text-muted-foreground"
                              }`}
                              onClick={() =>
                                remote.deleted
                                  ? onRestore(remote)
                                  : onDelete(remote)
                              }
                            >
                              {remote.deleted ? (
                                <RotateCcwIcon className="size-3.5" />
                              ) : (
                                <Trash2Icon className="size-3.5" />
                              )}
                            </button>
                          </Hint>
                        </>
                      )}
                    </RemoteRowActionRail>
                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        editor
                      ) : (
                        <div
                          className={`min-w-0 flex-1 space-y-2 ${
                            remote.deleted
                              ? "line-through decoration-2 decoration-orange-400"
                              : ""
                          }`}
                        >
                          <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
                            <span className="shrink-0 font-semibold text-foreground">
                              Name:
                            </span>
                            <span
                              className={
                                remote.changed
                                  ? "truncate text-orange-400"
                                  : "truncate text-foreground"
                              }
                            >
                              {remote.name}
                            </span>
                          </div>
                          <div className="flex min-w-0 items-start gap-1.5 text-sm">
                            <span className="shrink-0 font-semibold text-foreground">
                              URL:
                            </span>
                            <Hint content={remote.url}>
                              <span className="min-w-0 break-all font-mono text-muted-foreground text-xs leading-relaxed">
                                {remote.url}
                              </span>
                            </Hint>
                          </div>
                          <div className="flex min-w-0 items-center gap-2">
                            <BranchBadge
                              icon={LaptopIcon}
                              label="Local branch"
                              value={remote.local_branch ?? "Not configured"}
                            />
                            <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                            <BranchBadge
                              icon={CloudIcon}
                              label="Remote branch"
                              value={remote.remote_branch ?? "Not configured"}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </Fragment>
            );
          })
        )}
        {editorTarget?.kind === "new" ? (
          <div
            className="flex items-start gap-3 py-3"
            data-testid="git-remote-new-row"
          >
            <RemoteRowActionRail actionLabel="New remote actions">
              {editorActions}
            </RemoteRowActionRail>
            <div className="min-w-0 flex-1">{editor}</div>
          </div>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 py-3 text-left font-medium text-sm transition-colors hover:text-foreground disabled:opacity-50"
            onClick={onAdd}
            disabled={isLoading || editorTarget !== null}
          >
            <PlusIcon className="size-4 text-muted-foreground" />
            New remote
          </button>
        )}
        <GithubNewRepositoryButton onClick={onCreateGithub} />
      </div>
    </div>
  );
}

function RemoteRowActionRail({
  actionLabel,
  checkboxLabel,
  selected = false,
  onSelectedChange,
  showCheckbox = false,
  children,
}: {
  actionLabel?: string;
  checkboxLabel?: string;
  selected?: boolean;
  onSelectedChange?: () => void;
  showCheckbox?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-6 shrink-0 flex-col items-center gap-2">
      {showCheckbox ? (
        <button
          type="button"
          aria-label={checkboxLabel}
          aria-pressed={selected}
          className="mt-0.5"
          onClick={onSelectedChange}
        >
          <CheckboxIndicator checked={selected} />
        </button>
      ) : null}
      {children ? (
        <div
          role="group"
          aria-label={actionLabel}
          className="w-6 shrink-0 overflow-hidden rounded-md bg-muted-foreground/10"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function RemoteActionSelector({
  value,
  onChange,
  selectedCount,
  disabled,
  commands,
  showGitCommand,
  onShowGitCommandChange,
}: {
  value: RemoteAction;
  onChange: (value: RemoteAction) => void;
  selectedCount: number;
  disabled: boolean;
  commands: string[];
  showGitCommand: boolean;
  onShowGitCommandChange: (expanded: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="font-semibold text-foreground text-sm">Action</div>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-background dark:bg-muted">
        <button
          type="button"
          className="flex w-full items-center justify-between border-sidebar-border border-b py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => onChange("apply")}
          disabled={disabled}
        >
          <span className="inline-flex items-center gap-2">
            <SaveIcon className="size-3.5 text-muted-foreground" />
            <span>Apply Selected ({selectedCount})</span>
          </span>
          {value === "apply" ? (
            <CheckIcon className="size-4 text-foreground" />
          ) : null}
        </button>
        <button
          type="button"
          className="flex w-full items-center justify-between py-2 pr-3 pl-2 text-left text-sm transition-colors hover:bg-muted/35 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={() => onChange("discard")}
          disabled={disabled}
        >
          <span className="inline-flex items-center gap-2">
            <RotateCcwIcon className="size-3.5 text-muted-foreground" />
            <span>Discard Selected ({selectedCount})</span>
          </span>
          {value === "discard" ? (
            <CheckIcon className="size-4 text-foreground" />
          ) : null}
        </button>
      </div>
      <GitCommandDisclosure
        commands={commands}
        expanded={showGitCommand}
        onExpandedChange={onShowGitCommandChange}
      />
    </div>
  );
}

function GithubNewRepositoryButton({
  onClick,
}: {
  onClick: () => Promise<void>;
}) {
  return (
    <button
      type="button"
      className="mt-1 flex w-full items-center gap-2 rounded-xl border border-border/70 bg-background px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/35 dark:bg-muted"
      onClick={() => void onClick()}
    >
      <GithubIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 font-medium">
        Create a new repository on GitHub
      </span>
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

function BranchBadge({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof LaptopIcon;
  label: string;
  value: string;
}) {
  return (
    <Hint content={label}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate rounded-md bg-muted-foreground/10 px-2 py-1 font-mono text-muted-foreground text-xs">
          {value}
        </span>
      </div>
    </Hint>
  );
}
