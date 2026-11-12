import { openRecentProject } from "@/hooks/use-project-actions";
import { Hint } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { invoke } from "@/lib/desktop/core";
import { useProjectOwnership } from "@/hooks/use-project-ownership";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDesktop } from "@/lib/desktop/bridge";
import { getCurrentWebview } from "@/lib/desktop/webview";
import { stat } from "@/lib/desktop/fs";
import { open } from "@/lib/desktop/dialog";
import { LatexInstallationControl } from "./latex-installation";
import {
  ArrowUpIcon,
  ArrowDownIcon,
  FileTextIcon,
  FolderOpenIcon,
  LeafIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
  Trash2Icon,
  CheckCircle2Icon,
  CircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useSettingsStore } from "@/stores/settings-store";
import { useProjectStore } from "@/stores/project-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TemplateGallery } from "./template-gallery";
import { ProjectTrashDialog } from "./project-trash-dialog";
import { BlankProjectDialog } from "./blank-project-dialog";
import { OverleafCloneDialog } from "./overleaf-clone-dialog";
import { ClaudeSetup } from "./claude-setup";
import { CodexSetup } from "./codex-setup";
import {
  CollapsibleSectionBody,
  HANDWRITTEN_CAT_FONT,
  Sidebar,
} from "./workspace/sidebar";
import { cn } from "@/lib/utils";
import { getElementFromNativeDropPosition } from "@/lib/desktop/native-drop";
import { detectTexlive, type TexliveStatus } from "@/lib/latex-compiler";

function formatRecentProjectTimestamp(lastOpened: number) {
  const date = new Date(lastOpened);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function EmptyRecentProjects() {
  return (
    <div
      className="relative h-full min-h-[260px] overflow-hidden"
      data-testid="welcome-empty-projects"
    >
      <div className="absolute top-[94px] left-[14px] h-[42px] w-[280px] origin-left rotate-[2deg]">
        <svg
          viewBox="0 0 60 36"
          className="h-[34px] w-[52px] overflow-visible text-foreground/75"
          fill="none"
          aria-hidden="true"
          data-testid="welcome-empty-project-arrow"
        >
          <g
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path
              d="M2 11.5C14 10.8 24 13.2 28 17.6C32 22.4 29.4 29.3 24 30C19.1 30.7 16.4 27.3 17.6 23.4C18.8 19.4 23.9 17.8 29 18.7C38.5 20.4 46 24.1 53 28.8"
              pathLength="1"
              className="welcome-empty-arrow-stroke"
              data-testid="welcome-empty-project-arrow-stroke"
            />
            <path
              d="M2 11.5L10.5 4.6"
              pathLength="1"
              className="welcome-empty-arrow-head welcome-empty-arrow-head-upper"
              data-testid="welcome-empty-project-arrow-head-upper"
            />
            <path
              d="M2 11.5L9.7 17.4"
              pathLength="1"
              className="welcome-empty-arrow-head welcome-empty-arrow-head-lower"
              data-testid="welcome-empty-project-arrow-head-lower"
            />
          </g>
        </svg>
        <p
          className="absolute top-5 left-[57px] whitespace-nowrap font-semibold text-foreground/75 text-sm leading-snug"
          style={{ fontFamily: HANDWRITTEN_CAT_FONT }}
          data-testid="welcome-empty-project-note"
        >
          <span
            className="welcome-empty-note-line welcome-empty-note-line-first"
            data-testid="welcome-empty-project-note-line-first"
          >
            Start a new project
          </span>
          <span
            className="welcome-empty-note-line welcome-empty-note-line-second"
            data-testid="welcome-empty-project-note-line-second"
          >
            from here
          </span>
        </p>
      </div>
    </div>
  );
}

// Retain the last setup guidance through checking and the collapse animation.
function useSetupGuidance<T extends string>(status: T) {
  const [lastUnavailable, setLastUnavailable] = useState<T | undefined>(
    undefined,
  );
  useEffect(() => {
    if (status !== "checking" && status !== "ready" && status !== "disabled")
      setLastUnavailable(status);
  }, [status]);
  return {
    status: lastUnavailable,
    expanded:
      status !== "ready" &&
      status !== "disabled" &&
      lastUnavailable !== undefined,
  };
}

export function ProjectPicker() {
  const [trashProject, setTrashProject] = useState<{
    name: string;
    path: string;
  } | null>(null);
  const [showBlankProjectDialog, setShowBlankProjectDialog] = useState(false);
  const [showOverleafCloneDialog, setShowOverleafCloneDialog] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);

  const projectOwners = useProjectOwnership();
  const recentProjects = useProjectStore((s) => s.recentProjects);
  const [projectSort, setProjectSort] = useState<{
    column: "name" | "lastOpened";
    direction: "ascending" | "descending";
  }>({ column: "lastOpened", direction: "descending" });
  const sortedProjects = [...recentProjects].sort((a, b) => {
    const comparison =
      projectSort.column === "name"
        ? a.name.localeCompare(b.name, undefined, {
            numeric: true,
            sensitivity: "base",
          })
        : a.lastOpened - b.lastOpened;
    return (
      (comparison || a.path.localeCompare(b.path)) *
      (projectSort.direction === "ascending" ? 1 : -1)
    );
  });
  const toggleProjectSort = (column: "name" | "lastOpened") => {
    setProjectSort((current) => ({
      column,
      direction:
        current.column === column
          ? current.direction === "ascending"
            ? "descending"
            : "ascending"
          : column === "name"
            ? "ascending"
            : "descending",
    }));
  };
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const dropAreaRef = useRef<HTMLDivElement>(null);
  const sidebarDropRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    setIsDragOver(false);
    if (!isDesktop()) return;
    if (
      showTemplateGallery ||
      showBlankProjectDialog ||
      showOverleafCloneDialog
    )
      return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent(async ({ payload }) => {
        if (cancelled) return;
        if (payload.type === "leave") {
          setIsDragOver(false);
          return;
        }
        const inside = [dropAreaRef.current, sidebarDropRef.current].some(
          (area) => {
            const target = getElementFromNativeDropPosition(payload.position, {
              root: area,
            });
            return Boolean(area && target && area.contains(target));
          },
        );
        setIsDragOver(payload.type !== "drop" && inside);
        if (payload.type !== "drop" || !inside) return;
        const paths = [...new Set(payload.paths)];
        const results = await Promise.allSettled(
          paths.map(async (path) => (await stat(path)).isDirectory),
        );
        if (cancelled) return;
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled" && result.value) {
            addRecentProject(paths[index]);
          }
        }
      })
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch((error) =>
        console.warn("Project folder drop unavailable:", error),
      );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [
    showTemplateGallery,
    showBlankProjectDialog,
    showOverleafCloneDialog,
    addRecentProject,
  ]);

  const enabledProviders = useSettingsStore((s) => s.enabledProviders);
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const checkClaudeStatus = useClaudeSetupStore((s) => s.checkStatus);
  const codexStatus = useCodexSetupStore((s) => s.status);
  const checkCodexStatus = useCodexSetupStore((s) => s.checkStatus);
  const piStatus = usePiSetupStore((s) => s.status);
  const checkPiStatus = usePiSetupStore((s) => s.checkStatus);
  const claudeGuidance = useSetupGuidance(claudeStatus);
  const codexGuidance = useSetupGuidance(codexStatus);

  const [texliveStatus, setTexliveStatus] = useState<TexliveStatus | null>(
    null,
  );
  const savedLatexInstallation = useSettingsStore((s) => s.latexInstallation);
  const setLatexInstallation = useSettingsStore((s) => s.setLatexInstallation);
  const installations = texliveStatus?.installations;
  const selectedLatex = installations?.find(
    (i) => i.id === savedLatexInstallation,
  );
  const effectiveLatex = selectedLatex
    ? {
        ...texliveStatus,
        ...selectedLatex,
        latexmkAvailable: Boolean(selectedLatex.binaryPaths.latexmk),
      }
    : savedLatexInstallation && texliveStatus
      ? {
          ...texliveStatus,
          available: false,
          latexmkAvailable: false,
          engines: [],
          version: null,
        }
      : texliveStatus;
  useEffect(() => {
    if (!savedLatexInstallation && installations?.length) {
      setLatexInstallation(
        (installations.find((i) => i.available) ?? installations[0]).id,
      );
    }
  }, [savedLatexInstallation, installations, setLatexInstallation]);
  const [texliveCheckFailed, setTexliveCheckFailed] = useState(false);
  const [environmentChecking, setEnvironmentChecking] = useState(true);
  const environmentCheckInFlight = useRef(false);
  const refreshEnvironment = useCallback(async () => {
    if (environmentCheckInFlight.current) return;
    environmentCheckInFlight.current = true;
    setEnvironmentChecking(true);
    setTexliveCheckFailed(false);
    const enabled = useSettingsStore.getState().enabledProviders;
    try {
      await Promise.allSettled([
        ...(enabled.claude ? [checkClaudeStatus()] : []),
        ...(enabled.codex ? [checkCodexStatus()] : []),
        ...(enabled.pi ? [checkPiStatus()] : []),
        detectTexlive()
          .then(setTexliveStatus)
          .catch(() => {
            setTexliveStatus(null);
            setTexliveCheckFailed(true);
          }),
      ]);
    } finally {
      environmentCheckInFlight.current = false;
      setEnvironmentChecking(false);
    }
  }, [checkClaudeStatus, checkCodexStatus, checkPiStatus]);
  const [latexGuidance, setLatexGuidance] = useState<TexliveStatus | null>(
    null,
  );
  useEffect(() => {
    if (
      !environmentChecking &&
      !texliveCheckFailed &&
      effectiveLatex &&
      !effectiveLatex.available
    ) {
      setLatexGuidance(effectiveLatex);
    }
  }, [
    environmentChecking,
    texliveCheckFailed,
    texliveStatus,
    savedLatexInstallation,
  ]);
  const showLatexGuidance = Boolean(
    latexGuidance &&
      (environmentChecking || texliveCheckFailed || !effectiveLatex?.available),
  );
  const environmentBusy =
    environmentChecking ||
    (enabledProviders.claude && claudeStatus === "checking") ||
    (enabledProviders.codex && codexStatus === "checking") ||
    (enabledProviders.pi && piStatus === "checking");

  useEffect(() => {
    void refreshEnvironment();
  }, [refreshEnvironment]);

  useEffect(() => {
    useAgentChatStore.getState().applyAgentDefaults();
  }, []);

  const handleOpenFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Open Project Folder",
    });
    if (selected) {
      await handleOpenRecent(selected);
    }
  };

  const handleOpenRecent = openRecentProject;

  if (showTemplateGallery) {
    return (
      <TemplateGallery
        onBack={() => setShowTemplateGallery(false)}
        onOpenFolder={handleOpenFolder}
      />
    );
  }

  return (
    <div className="flex h-full pt-0 pr-2 pl-3" data-testid="welcome-layout">
      <aside
        className="h-full w-60 shrink-0"
        data-testid="welcome-sidebar-panel"
      >
        <Sidebar
          wizardOnly
          wizardPanelTitle="Environment"
          wizardPanelActions={
            <Hint content="Check again">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label="Check again"
                aria-busy={environmentBusy}
                disabled={environmentBusy}
                onClick={() => void refreshEnvironment()}
              >
                <RefreshCwIcon
                  className={cn("size-3.5", environmentBusy && "animate-spin")}
                />
              </Button>
            </Hint>
          }
          wizardPrimaryAction={
            <div
              ref={sidebarDropRef}
              className="w-full"
              data-testid="welcome-sidebar-drop-area"
            >
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    className="w-full gap-2 font-semibold text-xs"
                    data-testid="welcome-new-project-menu-trigger"
                  >
                    <PlusIcon className="size-4 shrink-0" />
                    <span className="truncate">New Project</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  sideOffset={6}
                  className="w-[var(--radix-dropdown-menu-trigger-width)]"
                >
                  <DropdownMenuItem onSelect={() => void handleOpenFolder()}>
                    <FolderOpenIcon className="size-4" />
                    Open Folder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mx-2 my-1.5" />
                  <DropdownMenuItem
                    onSelect={() => setShowOverleafCloneDialog(true)}
                  >
                    <LeafIcon className="size-4" />
                    Import from Overleaf
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mx-2 my-1.5" />
                  <DropdownMenuItem
                    onSelect={() => setShowBlankProjectDialog(true)}
                  >
                    <FileTextIcon className="size-4" />
                    Blank Document
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="mx-2 my-1.5" />
                  <DropdownMenuItem
                    onSelect={() => setShowTemplateGallery(true)}
                  >
                    <SparklesIcon className="size-4" />
                    Choose Template
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <div
                role="status"
                style={{ fontFamily: HANDWRITTEN_CAT_FONT }}
                className={cn(
                  "mt-1 text-center text-[11px] leading-relaxed transition-colors",
                  isDragOver
                    ? "text-orange-600 dark:text-orange-300"
                    : "text-muted-foreground",
                )}
              >
                {isDragOver ? "drop to add the project" : "or drag and drop"}
              </div>
            </div>
          }
          wizardPanel={
            <>
              <EnvironmentStatus
                texliveStatus={effectiveLatex}
                installationName={selectedLatex?.name}
                savedInstallationMissing={Boolean(
                  savedLatexInstallation && texliveStatus && !selectedLatex,
                )}
                texliveCheckFailed={texliveCheckFailed}
                texliveChecking={environmentChecking}
              />
              <CollapsibleSectionBody expanded={showLatexGuidance}>
                <div className="pt-3">
                  <LatexInstallationControl
                    status={latexGuidance}
                    recommendationOnly
                    actions={
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={environmentBusy}
                        onClick={() => void refreshEnvironment()}
                      >
                        <RefreshCwIcon
                          className={cn(
                            "size-4",
                            environmentBusy && "animate-spin",
                          )}
                        />
                        {environmentBusy ? "Checking…" : "Recheck"}
                      </Button>
                    }
                  />
                </div>
              </CollapsibleSectionBody>
              <CollapsibleSectionBody
                expanded={enabledProviders.claude && claudeGuidance.expanded}
              >
                <div className="pt-2" inert={environmentBusy}>
                  {enabledProviders.claude && claudeGuidance.status && (
                    <ClaudeSetup statusOverride={claudeGuidance.status} />
                  )}
                </div>
              </CollapsibleSectionBody>
              <CollapsibleSectionBody
                expanded={enabledProviders.codex && codexGuidance.expanded}
              >
                <div className="pt-2" inert={environmentBusy}>
                  {enabledProviders.codex && codexGuidance.status && (
                    <CodexSetup
                      checkOnMount={false}
                      statusOverride={codexGuidance.status}
                    />
                  )}
                </div>
              </CollapsibleSectionBody>
            </>
          }
        />
      </aside>

      <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col pb-2 pl-3">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 overflow-hidden px-2">
            <div
              data-welcome-header-drag-region="true"
              data-window-drag-region
              className="min-w-0 flex-1 truncate font-semibold text-foreground text-sm"
            >
              <span className="pointer-events-none">Recent Projects</span>
            </div>
          </div>

          <div className="mt-0 min-h-0 flex-1">
            <div
              ref={dropAreaRef}
              data-testid="welcome-project-drop-area"
              className={cn(
                "relative flex h-full min-h-0 flex-col overflow-hidden rounded-panel border transition-colors",
                isDragOver
                  ? "border-orange-400 bg-orange-400/10"
                  : "border-border/70 bg-muted/25",
              )}
            >
              <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
                {recentProjects.length === 0 ? (
                  <EmptyRecentProjects />
                ) : (
                  <table className="grid w-full grid-cols-[minmax(0,1fr)_min(calc(30%_-_1.95rem),18rem)_max-content] gap-y-1 px-3 text-sm">
                    <thead className="sticky top-0 z-10 col-span-3 grid grid-cols-subgrid bg-transparent">
                      <tr className="col-span-3 grid grid-cols-subgrid text-muted-foreground">
                        {(
                          [
                            ["name", "Title"],
                            ["lastOpened", "Last Modified"],
                          ] as const
                        ).map(([column, label]) => (
                          <th
                            key={column}
                            scope="col"
                            aria-sort={
                              projectSort.column === column
                                ? projectSort.direction
                                : "none"
                            }
                            className="px-5 py-3 text-left font-medium"
                          >
                            <button
                              type="button"
                              onClick={() => toggleProjectSort(column)}
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                projectSort.column === column &&
                                  "text-foreground",
                              )}
                            >
                              {label}
                              {projectSort.column === column &&
                                (projectSort.direction === "ascending" ? (
                                  <ArrowUpIcon
                                    className="size-3"
                                    strokeWidth={3}
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <ArrowDownIcon
                                    className="size-3"
                                    strokeWidth={3}
                                    aria-hidden="true"
                                  />
                                ))}
                            </button>
                          </th>
                        ))}
                        <th className="whitespace-nowrap px-5 py-3 text-center font-medium">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody className="contents">
                      {sortedProjects.map((project) => {
                        const occupied =
                          !!projectOwners[project.path] &&
                          projectOwners[project.path] !==
                            window.catalex?.windowId;
                        return (
                          <tr
                            key={project.path}
                            className="group col-span-3 grid grid-cols-subgrid"
                            data-project-path={project.path}
                            data-occupied={occupied}
                          >
                            <td className="min-w-0 rounded-l-xl border border-transparent border-r-0 bg-background px-5 py-3 align-middle transition-colors group-hover:border-border/60 group-hover:border-r-0">
                              <Hint
                                content={occupied ? "Go to window" : undefined}
                              >
                                <button
                                  className="flex w-full flex-col items-start text-left"
                                  aria-label={
                                    occupied ? "Go to window" : undefined
                                  }
                                  onClick={() => {
                                    if (!occupied) {
                                      void handleOpenRecent(project.path);
                                      return;
                                    }
                                    void invoke<boolean>(
                                      "desktop:project:focus",
                                      { path: project.path },
                                    )
                                      .then((focused) => {
                                        if (!focused)
                                          toast.info(
                                            "This project is no longer open in another window.",
                                          );
                                      })
                                      .catch((error) =>
                                        toast.error(String(error)),
                                      );
                                  }}
                                >
                                  <span className="max-w-full truncate font-medium transition-colors group-hover:text-orange-400">
                                    {project.name}
                                  </span>
                                  <span className="max-w-full truncate text-muted-foreground text-xs">
                                    {project.path}
                                  </span>
                                </button>
                              </Hint>
                            </td>
                            <td className="border-transparent border-y bg-background px-5 py-3 text-muted-foreground transition-colors group-hover:border-border/60">
                              {occupied ? (
                                <span className="text-orange-600 dark:text-orange-400">
                                  Currently open
                                </span>
                              ) : (
                                <>
                                  <span data-project-opened-at>
                                    {formatRecentProjectTimestamp(
                                      project.lastOpened,
                                    )}
                                  </span>
                                  <span data-project-opening-label>
                                    Opening…
                                  </span>
                                </>
                              )}
                            </td>
                            <td className="whitespace-nowrap rounded-r-xl border border-transparent border-l-0 bg-background px-5 py-3 text-center transition-colors group-hover:border-border/60 group-hover:border-l-0">
                              <Hint content="Remove from recent projects">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={occupied}
                                  className="opacity-70 transition-opacity disabled:opacity-30 enabled:group-hover:opacity-100"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeRecentProject(project.path);
                                  }}
                                  aria-label={`Remove ${project.name}`}
                                >
                                  <XIcon className="size-4" />
                                </Button>
                              </Hint>
                              <Hint content="Move project to Trash">
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={occupied}
                                  aria-label={`Move ${project.name} to Trash`}
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={() => setTrashProject(project)}
                                >
                                  <Trash2Icon className="size-4" />
                                </Button>
                              </Hint>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <ProjectTrashDialog
        project={trashProject}
        onClose={() => setTrashProject(null)}
        onTrashed={removeRecentProject}
      />
      <BlankProjectDialog
        open={showBlankProjectDialog}
        onOpenChange={setShowBlankProjectDialog}
      />
      <OverleafCloneDialog
        open={showOverleafCloneDialog}
        onOpenChange={setShowOverleafCloneDialog}
      />
    </div>
  );
}

// ─── Environment Status ───

function EnvironmentStatus({
  installationName,
  savedInstallationMissing,
  texliveStatus,
  texliveCheckFailed,
  texliveChecking,
}: {
  installationName?: string;
  savedInstallationMissing: boolean;
  texliveStatus: TexliveStatus | null;
  texliveCheckFailed: boolean;
  texliveChecking: boolean;
}) {
  const enabledProviders = useSettingsStore((s) => s.enabledProviders);
  const claudeVersion = useClaudeSetupStore((s) => s.version);
  const claudeEmail = useClaudeSetupStore((s) => s.accountEmail);
  const claudeStatus = useClaudeSetupStore((s) => s.status);
  const claudeReady = claudeStatus === "ready";
  const codexVersion = useCodexSetupStore((s) => s.version);
  const codexAccount = useCodexSetupStore((s) => s.accountLabel);
  const codexStatus = useCodexSetupStore((s) => s.status);
  const codexReady = codexStatus === "ready";
  const piVersion = usePiSetupStore((s) => s.version);
  const piStatus = usePiSetupStore((s) => s.status);
  const piReady = piStatus === "ready";

  const texliveReady = Boolean(texliveStatus?.available);
  const texliveDetail = texliveChecking
    ? "Checking"
    : texliveCheckFailed
      ? "Check failed"
      : savedInstallationMissing
        ? "Saved installation unavailable"
        : texliveReady
          ? `${installationName ?? "LaTeXmk"} · ${texliveStatus?.engines.length ?? 0} engines`
          : texliveStatus?.latexmkAvailable
            ? "Missing engines"
            : "Missing latexmk";

  return (
    <div className="flex w-full flex-col gap-2">
      <StatusRow ok={texliveReady} label="LaTeXmk" detail={texliveDetail} />

      {enabledProviders.claude && (
        <StatusRow
          ok={claudeReady}
          label="Claude Code"
          detail={
            claudeReady
              ? [claudeVersion, claudeEmail].filter(Boolean).join(" · ")
              : claudeStatus === "checking"
                ? "Checking"
                : "Unavailable"
          }
        />
      )}
      {enabledProviders.codex && (
        <StatusRow
          ok={codexReady}
          label="Codex"
          detail={
            codexReady
              ? [codexVersion, codexAccount].filter(Boolean).join(" · ")
              : codexStatus === "checking"
                ? "Checking"
                : "Unavailable"
          }
        />
      )}
      {enabledProviders.pi && (
        <StatusRow
          ok={piReady}
          label="Pi"
          detail={
            piReady
              ? (piVersion ?? "Ready")
              : piStatus === "checking"
                ? "Checking"
                : "Unavailable"
          }
        />
      )}
    </div>
  );
}

function StatusRow({
  ok,
  label,
  detail,
}: {
  ok: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {ok ? (
        <CheckCircle2Icon className="size-3.5 shrink-0 text-foreground" />
      ) : (
        <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/40" />
      )}
      <span
        className={cn(
          "shrink-0 text-sm",
          ok ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
        {detail}
      </span>
    </div>
  );
}
