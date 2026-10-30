import { PRODUCT_NAME } from "../../../branding";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  HISTORY_CLEAR_DESCRIPTION,
  HISTORY_CLEAR_WARNING,
  HISTORY_CLEAR_PRESERVED,
} from "@/lib/history-confirmation";
import {
  ChevronDownIcon,
  CircleHelpIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  Hint,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ButtonGroup } from "@/components/ui/button-group";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/project-store";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { invoke } from "@/lib/desktop/core";
import { listen } from "@/lib/desktop/event";
import { SettingsGroup, SettingsRow } from "./settings-layout";
import type {
  StorageInventory,
  StoredProject,
  StorageAction,
} from "../../../main/managed-storage";

export function formatStorageBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
const CLEAR_BUTTON_CLASS = "h-6 rounded-lg px-2 font-mono text-[11px]";

const ACTIONS: Record<
  StorageAction | "browser",
  { label: string; explanation: string }
> = {
  browser: {
    label: "Clear browser cache",
    explanation:
      "Remove cached app resources and JavaScript code. Settings, sign-ins, saved sessions, and project history are preserved. Resources will be cached again as you use " +
      PRODUCT_NAME +
      ".",
  },
  cache: {
    label: "Clear cache",
    explanation:
      "Remove compiled previews and temporary project cache. " +
      PRODUCT_NAME +
      " will rebuild them when needed. History and saved sessions are preserved.",
  },
  history: {
    label: "Clear history",
    explanation: HISTORY_CLEAR_DESCRIPTION,
  },
  agent: {
    label: "Clear agent data",
    explanation:
      "Permanently remove this project's saved session files and draft workspaces stored by " +
      PRODUCT_NAME +
      ". Existing agent sessions may no longer resume.",
  },
  all: {
    label: "Remove stored data",
    explanation: "Permanently remove:",
  },
};

export function StorageSettings() {
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const recentProjects = useProjectStore((state) => state.recentProjects);
  const [filter, setFilter] = useState("All");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  const closeSearch = () => {
    setQuery("");
    setSearchOpen(false);
    searchTrigger.current?.focus();
  };
  const [query, setQuery] = useState("");
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const [focusedCategory, setFocusedCategory] = useState<string | null>(null);
  const activeCategory = hoveredCategory ?? focusedCategory;
  const categoryColor = (part: { label: string; color: string }) =>
    activeCategory && activeCategory !== part.label
      ? "color-mix(in oklab, var(--muted-foreground) 40%, var(--background))"
      : part.color;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{
    project?: StoredProject;
    action: StorageAction | "browser";
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const result = await invoke<StorageInventory>("desktop:storage:list", {
        recentPaths: recentProjects.map((project) => project.path),
      });
      if (request === generation.current) {
        setInventory(result);
        setError(null);
      }
    } catch (cause) {
      if (request === generation.current) setError(String(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [recentProjects]);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const stop = listen("project-ownership-changed", onFocus);
    return () => {
      generation.current++;
      window.removeEventListener("focus", onFocus);
      void stop.then((unlisten) => unlisten());
    };
  }, [refresh]);

  async function action(
    command: string,
    args: Record<string, unknown>,
    message: string,
  ) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await invoke(command, args);
      setConfirmation(null);
      setNotice(message);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }
  const projects =
    inventory?.projects.filter((project) => {
      const category = !project.sourceAvailable
        ? "Unavailable"
        : project.isRecent
          ? "Active"
          : "Inactive";
      return (
        (filter === "All" || filter === category) &&
        `${project.name} ${project.paths.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase())
      );
    }) ?? [];
  const composition = inventory
    ? [
        {
          label: "Stored projects",
          bytes: inventory.projects.reduce(
            (sum, project) => sum + project.totalBytes,
            0,
          ),
          color: "oklch(0.74 0.16 16)",
        },
        {
          label: "Shared app data",
          bytes: inventory.sharedBytes,
          color: "oklch(0.74 0.16 39)",
        },
        {
          label: "Settings and local data",
          bytes: inventory.profileBytes,
          color: "oklch(0.74 0.16 62)",
        },
        {
          label: "Browser cache",
          bytes: inventory.browserCacheBytes,
          color: "oklch(0.74 0.16 85)",
        },
      ]
    : [];
  let cumulativeBytes = 0;
  const donutStops = composition.map((part) => {
    const start = cumulativeBytes;
    cumulativeBytes += part.bytes;
    const total = inventory?.totalBytes || 1;
    return `${categoryColor(part)} ${(start / total) * 100}% ${(cumulativeBytes / total) * 100}%`;
  });
  return (
    <section aria-label="Storage settings">
      <SettingsGroup
        title="Storage usage"
        titleAction={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Show storage folder"
            onClick={() =>
              void invoke("desktop:storage:reveal").catch((cause) =>
                setError(String(cause)),
              )
            }
          >
            <FolderOpenIcon className="size-3.5" />
          </Button>
        }
      >
        <figure
          aria-label="Storage composition"
          className="flex items-center gap-6 py-4"
        >
          <div
            className="relative size-28 shrink-0"
            onPointerMove={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = event.clientX - bounds.left - bounds.width / 2;
              const y = event.clientY - bounds.top - bounds.height / 2;
              const radius = Math.hypot(x, y);
              const outerRadius = bounds.width / 2;
              if (
                !inventory?.totalBytes ||
                radius > outerRadius ||
                radius < outerRadius - 16
              ) {
                setHoveredCategory(null);
                return;
              }
              // Conic gradients start at twelve o'clock and advance clockwise.
              const fraction =
                ((Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) %
                  (Math.PI * 2)) /
                (Math.PI * 2);
              let end = 0;
              const part = composition.find((category) => {
                end += category.bytes / inventory.totalBytes;
                return fraction < end;
              });
              setHoveredCategory(part?.label ?? null);
            }}
            onPointerLeave={() => setHoveredCategory(null)}
          >
            <div
              role="img"
              aria-label={`Storage composition: ${composition.map((part) => `${part.label} ${formatStorageBytes(part.bytes)}`).join(", ")}`}
              data-testid="storage-composition-donut"
              className="size-28 shrink-0 rounded-full bg-muted"
              style={{
                background:
                  inventory && inventory.totalBytes > 0
                    ? `conic-gradient(${donutStops.join(", ")})`
                    : undefined,
                maskImage:
                  "radial-gradient(farthest-side, transparent calc(100% - 16px), black calc(100% - 15px))",
              }}
            />
            <div className="absolute inset-4 flex flex-col items-center justify-center gap-1">
              <span className="text-center font-medium text-xs tabular-nums">
                <span className="sr-only">Total storage used: </span>
                {inventory
                  ? formatStorageBytes(inventory.totalBytes)
                  : "Calculating…"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 rounded-full"
                aria-label="Refresh storage"
                disabled={loading || busy}
                onClick={() => void refresh()}
              >
                <RefreshCwIcon
                  className={loading ? "size-3 animate-spin" : "size-3"}
                />
              </Button>
            </div>
          </div>
          <figcaption className="grid min-w-0 flex-1 sm:max-w-sm">
            {composition.map((part) => (
              <div
                key={part.label}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-xs data-[active=true]:bg-accent"
                data-active={activeCategory === part.label}
                onPointerEnter={() => setHoveredCategory(part.label)}
                onPointerLeave={() => setHoveredCategory(null)}
                onFocusCapture={() => setFocusedCategory(part.label)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setFocusedCategory(null);
                }}
              >
                <Button
                  variant="ghost"
                  className="h-6 min-w-0 flex-1 justify-start gap-2 p-0 font-normal text-xs hover:bg-transparent dark:hover:bg-transparent"
                  aria-label={`${part.label} ${formatStorageBytes(part.bytes)}`}
                  data-active={activeCategory === part.label}
                >
                  <span
                    aria-hidden="true"
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: categoryColor(part) }}
                  />
                  <span className="text-muted-foreground">{part.label}</span>
                </Button>
                {part.label === "Browser cache" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className={CLEAR_BUTTON_CLASS}
                    aria-label="Clear browser cache"
                    disabled={busy || loading || !inventory}
                    onClick={() => {
                      setError(null);
                      setConfirmation({ action: "browser" });
                    }}
                  >
                    Clear
                  </Button>
                )}
                <span className="shrink-0 pl-2 tabular-nums">
                  {formatStorageBytes(part.bytes)}
                </span>
              </div>
            ))}
          </figcaption>
        </figure>
      </SettingsGroup>
      <SettingsGroup
        title="Stored projects"
        titleAction={
          <div className="flex h-7 items-center gap-1">
            {searchOpen && (
              <Input
                ref={searchInput}
                aria-label="Find stored projects"
                placeholder="Name or path…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeSearch();
                  }
                }}
                className="h-7 w-44 max-w-[40vw] rounded-lg font-normal text-xs shadow-none focus-visible:border-foreground/40 focus-visible:ring-0"
              />
            )}
            <Button
              ref={searchTrigger}
              variant="ghost"
              size="icon-xs"
              aria-label={
                searchOpen ? "Close project search" : "Search stored projects"
              }
              aria-expanded={searchOpen}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            >
              {searchOpen ? (
                <XIcon className="size-3.5" />
              ) : (
                <SearchIcon className="size-3.5" />
              )}
            </Button>
          </div>
        }
      >
        <div
          data-settings-row-id="storage-projects"
          className="flex justify-start py-3"
        >
          <ButtonGroup
            aria-label="Filter stored projects"
            className="flex h-8 w-80 max-w-full items-center"
          >
            {["All", "Active", "Inactive", "Unavailable"].map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={filter === option}
                className={cn(
                  "flex h-6 flex-1 items-center justify-center rounded-md font-medium text-xs transition-colors focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring",
                  filter === option
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/70 hover:text-foreground",
                )}
                onClick={() => setFilter(option)}
              >
                {option}
              </button>
            ))}
          </ButtonGroup>
        </div>
        {notice && (
          <p role="status" className="py-2 text-sm">
            {notice}
          </p>
        )}
        {error && !confirmation && (
          <p role="alert" className="py-2 text-destructive text-sm">
            {error}
          </p>
        )}
        {!loading && inventory && projects.length === 0 && (
          <p className="py-6 text-center text-muted-foreground text-sm">
            {query || filter !== "All"
              ? "No matching projects."
              : "No stored projects yet."}
          </p>
        )}
        {projects.map((project) => {
          const isExpanded = expanded === project.id;
          const disabled = busy || project.isOpen;
          const budgetOptions = [
            ...new Set(
              [100, 250, 500, 1024]
                .map((size) => size * 1024 ** 2)
                .concat(project.historyLimitBytes),
            ),
          ].sort((a, b) => a - b);
          return (
            <div
              key={project.id}
              className="border-border/45 border-t"
              data-testid={`stored-project-${project.id}`}
            >
              <div className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1 px-1 py-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="truncate font-medium">{project.name}</span>
                    {project.isOpen ? (
                      <Badge variant="secondary">Open</Badge>
                    ) : !project.sourceAvailable ? (
                      <Badge variant="outline">Folder unavailable</Badge>
                    ) : null}
                  </div>
                  <Hint content={project.paths[0]}>
                    <div className="mt-1 truncate text-muted-foreground text-xs">
                      {project.paths[0] ?? "Source folder unknown"}
                    </div>
                  </Hint>
                </div>
                <Button
                  variant="ghost"
                  className="h-8 shrink-0 gap-2 rounded-lg px-1 font-normal"
                  aria-label={`Storage details for ${project.name}`}
                  aria-expanded={isExpanded}
                  aria-controls={`storage-details-${project.id}`}
                  onClick={() => setExpanded(isExpanded ? null : project.id)}
                >
                  <span className="w-[8ch] shrink-0 text-right font-mono text-xs tabular-nums">
                    {formatStorageBytes(project.totalBytes)}
                  </span>
                  <ChevronDownIcon
                    className={`size-3.5 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                  />
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      aria-label="Show stored files"
                      onClick={() =>
                        void invoke("desktop:storage:reveal", {
                          projectId: project.id,
                        }).catch((cause) => setError(String(cause)))
                      }
                    >
                      <FolderOpenIcon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Show stored files</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-xs"
                      aria-label="Remove stored data…"
                      className="text-destructive hover:text-destructive"
                      disabled={disabled}
                      onClick={() => {
                        setError(null);
                        setConfirmation({ project, action: "all" });
                      }}
                    >
                      <Trash2Icon className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove stored data</TooltipContent>
                </Tooltip>
              </div>
              {isExpanded && (
                <div id={`storage-details-${project.id}`} className="pb-3 pl-2">
                  <SettingsRow
                    title="History budget"
                    contentClassName="flex-wrap gap-2"
                    titleAction={
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`About history budget for ${project.name}`}
                            className="size-5 rounded-full text-muted-foreground"
                          >
                            <CircleHelpIcon className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64 text-xs">
                          The budget applies to this project's history. The
                          latest 50 checkpoints and labeled versions are
                          retained, so usage can exceed it.
                        </TooltipContent>
                      </Tooltip>
                    }
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      className={CLEAR_BUTTON_CLASS}
                      aria-label="Clear history"
                      disabled={disabled || project.historyBytes === 0}
                      onClick={() => {
                        setError(null);
                        setConfirmation({ project, action: "history" });
                      }}
                    >
                      Clear
                    </Button>
                    <span className="whitespace-nowrap text-xs">
                      {formatStorageBytes(project.historyBytes)} used
                    </span>
                    <span aria-hidden="true" className="text-muted-foreground">
                      /
                    </span>
                    <Select
                      value={String(project.historyLimitBytes)}
                      disabled={disabled}
                      onValueChange={(value) =>
                        void action(
                          "desktop:storage:limit",
                          { projectId: project.id, bytes: Number(value) },
                          "History budget saved. Cleanup runs when the project is reopened.",
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={`History budget for ${project.name}`}
                        className="h-8 w-auto rounded-lg border-transparent bg-transparent px-2 font-mono shadow-none"
                      >
                        {formatStorageBytes(project.historyLimitBytes)}
                      </SelectTrigger>
                      <SelectContent
                        position="popper"
                        align="end"
                        className="rounded-xl"
                      >
                        {budgetOptions.map((bytes) => (
                          <SelectItem key={bytes} value={String(bytes)}>
                            {formatStorageBytes(bytes)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsRow>
                  <div className="pb-3">
                    <Progress
                      aria-label={`History storage for ${project.name}`}
                      value={Math.min(
                        100,
                        Math.max(
                          0,
                          (project.historyBytes /
                            Math.max(1, project.historyLimitBytes)) *
                            100,
                        ),
                      )}
                      aria-valuetext={`${formatStorageBytes(project.historyBytes)} used of ${formatStorageBytes(project.historyLimitBytes)} budget`}
                      className="h-1.5 bg-muted [&_[data-slot=progress-indicator]]:bg-orange-400 [&_[data-slot=progress-indicator]]:transition-none"
                    />
                    {project.historyBytes > project.historyLimitBytes && (
                      <p className="pt-1 text-right text-muted-foreground text-xs">
                        {formatStorageBytes(
                          project.historyBytes - project.historyLimitBytes,
                        )}{" "}
                        over budget
                      </p>
                    )}
                  </div>

                  {(
                    [
                      ["agent", "Agent data", project.agentBytes],
                      ["cache", "Cache", project.cacheBytes],
                    ] as const
                  ).map(([key, label, bytes]) => (
                    <SettingsRow
                      title={label}
                      key={key}
                      contentClassName="gap-2"
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className={CLEAR_BUTTON_CLASS}
                        aria-label={ACTIONS[key].label}
                        disabled={disabled || bytes === 0}
                        onClick={() => {
                          setError(null);
                          setConfirmation({ project, action: key });
                        }}
                      >
                        Clear
                      </Button>
                      <span>{formatStorageBytes(bytes)}</span>
                    </SettingsRow>
                  ))}
                  <SettingsRow title="Other project data">
                    {formatStorageBytes(project.otherBytes)}
                  </SettingsRow>
                </div>
              )}
            </div>
          );
        })}
      </SettingsGroup>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setConfirmation(null);
            setError(null);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {confirmation
                ? `${ACTIONS[confirmation.action].label}?`
                : "Manage stored data"}
            </DialogTitle>
            <DialogDescription asChild>
              <div>
                {confirmation && (
                  <>
                    <span className="block font-medium text-foreground">
                      {confirmation.project?.name ??
                        "All " + PRODUCT_NAME + " windows"}
                    </span>
                    <span className="mt-2 block">
                      {ACTIONS[confirmation.action].explanation}
                      {confirmation.action === "history" && (
                        <>
                          {" "}
                          <strong className="font-semibold text-foreground">
                            {HISTORY_CLEAR_WARNING}
                          </strong>
                        </>
                      )}
                    </span>
                    {confirmation.action === "all" && (
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        <li>Human and agent comments</li>
                        <li>Automatic history</li>
                        <li>Saved sessions and draft workspaces</li>
                        <li>Cache</li>
                      </ul>
                    )}
                    {confirmation.action === "all" ? (
                      <>
                        <span className="mt-2 block">Will not be deleted:</span>
                        <ul className="mt-2 list-disc space-y-1 pl-5">
                          <li>Source files</li>
                          <li>Project Git repository</li>
                        </ul>
                      </>
                    ) : (
                      <span className="mt-2 block">
                        {confirmation.action === "history"
                          ? HISTORY_CLEAR_PRESERVED
                          : "Your source files and project Git repository will not be changed."}
                      </span>
                    )}
                  </>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmation(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !confirmation}
              onClick={() =>
                confirmation &&
                void action(
                  confirmation.action === "browser"
                    ? "desktop:storage:clear-browser-cache"
                    : "desktop:storage:clear",
                  {
                    projectId: confirmation.project?.id,
                    action: confirmation.action,
                  },
                  confirmation.action === "browser"
                    ? "Browser cache cleared. Some cache may be recreated while " +
                        PRODUCT_NAME +
                        " is running."
                    : `${ACTIONS[confirmation.action].label} completed for ${confirmation.project?.name}.`,
                )
              }
            >
              {busy
                ? "Working…"
                : confirmation
                  ? ACTIONS[confirmation.action].label
                  : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
