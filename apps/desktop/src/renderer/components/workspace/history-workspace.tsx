import { isComposingKey } from "@/lib/keyboard-events";
import { Hint } from "@/components/ui/tooltip";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  Clock3Icon,
  CopyIcon,
  LoaderIcon,
  HistoryIcon,
  BookmarkIcon,
} from "lucide-react";
import { TrafficLightSafeHeader } from "@/components/window-titlebar";
import { useTrafficLightInset } from "@/hooks/use-traffic-light-inset";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SearchablePicker } from "@/components/ui/searchable-picker";
import { getFileType } from "@/lib/project-files";
import { readTextFile } from "@/lib/desktop/fs";
import { invoke } from "@/lib/desktop/core";
import { cn } from "@/lib/utils";
import { useDocumentStore } from "@/stores/document-store";
import {
  useHistoryStore,
  type FileDiff,
  type SnapshotInfo,
} from "@/stores/history-store";
import { useHistoryWorkspaceStore } from "@/stores/history-workspace-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { HistoryPanel } from "./history-panel";
import { HistorySnapshotContent } from "./history-snapshot-content";
import { SidebarFiles, type SidebarFileTreeNode } from "./sidebar-files";
import {
  HistoryMediaContent,
  HistoryRecordedAsset,
} from "./history-media-content";
import { WorkspacePanel } from "./workspace-panel";
import {
  getHistoryRestoreBlockReason,
  snapshotDate,
  snapshotDisplayLabels,
  snapshotAutomaticLabels,
  snapshotActionName,
  snapshotTitle,
  labelValidationReason,
  snapshotLabelOptions,
} from "./history-workspace-model";
import { useHistoryCardMotion } from "./use-history-card-motion";
import "./history-workspace.css";

function historyTreeStatus(
  node: SidebarFileTreeNode,
  statuses: ReadonlyMap<string, FileDiff["status"]>,
): FileDiff["status"] | undefined {
  if (node.type === "file") return statuses.get(node.relativePath);
  const children = node.children.map((child) =>
    historyTreeStatus(child, statuses),
  );
  if (!children.some(Boolean)) return undefined;
  if (children.every((status) => status === "added")) return "added";
  if (children.every((status) => status === "deleted")) return "deleted";
  // Mixed changes or changes alongside unchanged files modify the folder.
  return "modified";
}

export function HistoryWorkspace({ children }: { children: ReactNode }) {
  const open = useHistoryWorkspaceStore((s) => s.isOpen);
  const setOpen = useHistoryWorkspaceStore((s) => s.setOpen);
  const restoring = useHistoryStore((s) => s.isRestoring);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  useEffect(() => () => setOpen(false), [projectRoot, setOpen]);
  return (
    <div className="history-workspace-root" data-history-open={open}>
      <div
        className="history-live-workspace"
        inert={open}
        aria-hidden={open || undefined}
      >
        {children}
      </div>
      <DialogPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          if (!restoring) setOpen(next);
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="history-stage-backdrop" />
          <DialogPrimitive.Content
            className="history-workspace-overlay"
            aria-describedby="history-workspace-description"
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              const cancel = document.querySelector<HTMLButtonElement>(
                ".history-restore-confirmation:not([inert]) [data-cancel-restore]",
              );
              if (cancel) {
                event.preventDefault();
                cancel.click();
              }
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              document
                .querySelector<HTMLButtonElement>(
                  '.workspace-history-control[aria-label="Rewind"]',
                )
                ?.focus();
            }}
          >
            {projectRoot && (
              <HistoryStage
                key={projectRoot}
                projectRoot={projectRoot}
                onClose={() => setOpen(false)}
              />
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </div>
  );
}

function HistoryStage({
  projectRoot,
  onClose,
}: {
  projectRoot: string;
  onClose: () => void;
}) {
  const snapshots = useHistoryStore((s) => s.snapshots);
  const isRestoring = useHistoryStore((s) => s.isRestoring);
  // Subscribe to safety-relevant state; recheck the same guard at confirmation time.
  const projectFiles = useDocumentStore((s) => s.files);
  const projectFolders = useDocumentStore((s) => s.folders);
  useDocumentStore((s) => s.isGitOperationRunning);
  useDocumentStore((s) => s.isApplyingAgentDraft);
  useDocumentStore((s) => s.agentWorkspaceRoot);
  useDocumentStore((s) => s.isAgentWorkspaceReadOnly);
  useAgentChatStore((s) => s.tabs);
  useProposedChangesStore((s) => s.changes);
  useProposedChangesStore((s) => s.workspaceReview);
  const restoreBlocked = getHistoryRestoreBlockReason();
  const trafficLightInset = useTrafficLightInset();
  const [isPresent, setIsPresent] = useState(false);
  const saveLabel = (value: string) => {
    const text = value.trim();
    if (
      !selected ||
      labelSaving ||
      labelValidationReason(value, selected.labels)
    )
      return;
    setLabelError(null);
    setLabelSaving(true);
    void useHistoryStore
      .getState()
      .addLabel(projectRoot, selected.id, text)
      .then(() => {
        setSelected((current) =>
          current?.id === selected.id
            ? { ...current, labels: [...new Set([...current.labels, text])] }
            : current,
        );
        setLabel("");
      })
      .catch((error) => setLabelError(String(error)))
      .finally(() => setLabelSaving(false));
  };
  const labelCounts = useHistoryStore((state) => state.labelCounts);
  const [selected, setSelected] = useState<SnapshotInfo | null>(null);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [snapshotFiles, setSnapshotFiles] = useState<string[]>([]);
  const [loadedSnapshotId, setLoadedSnapshotId] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [fileResult, setFileResult] = useState<{
    key: string;
    content: string | null;
    error: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [labelOpen, setLabelOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const labelInvalidReason = labelValidationReason(label, selected?.labels);
  const [copied, setCopied] = useState(false);
  const titleBarRef = useRef<HTMLDivElement>(null);
  const inlineDetailsRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);
  useLayoutEffect(() => {
    let cancelled = false;
    let frame = 0;
    if (confirming || wasConfirming.current) {
      frame = requestAnimationFrame(() => {
        const layer = titleBarRef.current?.querySelector<HTMLElement>(
          confirming ? ".history-restore-confirmation" : ".history-card-normal",
        );
        void Promise.allSettled(
          (layer?.getAnimations() ?? []).map((animation) => animation.finished),
        ).then(() => {
          if (!cancelled)
            layer
              ?.querySelector<HTMLButtonElement>(
                confirming
                  ? "[data-cancel-restore]"
                  : ".history-restore-button",
              )
              ?.focus();
        });
      });
    }
    wasConfirming.current = confirming;
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [confirming]);

  const [compactDetails, setCompactDetails] = useState(true);
  useLayoutEffect(() => {
    const bar = titleBarRef.current;
    const details = inlineDetailsRef.current;
    const heading = bar?.querySelector<HTMLElement>(".history-card-heading");
    const restore = bar?.querySelector<HTMLElement>(".history-restore-button");
    if (!bar || !details || !heading || !restore) return;
    const measure = () => {
      const style = getComputedStyle(bar);
      const headingGap = parseFloat(getComputedStyle(heading).columnGap) || 0;
      const headingWidth =
        Array.from(heading.children).reduce(
          (width, child) => width + (child as HTMLElement).scrollWidth,
          0,
        ) +
        Math.max(0, heading.children.length - 1) * headingGap;
      const required =
        headingWidth +
        details.offsetWidth +
        restore.offsetWidth +
        2 * (parseFloat(style.columnGap) || 0) +
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight);
      bar.style.setProperty(
        "--history-restore-width",
        `${restore.offsetWidth}px`,
      );
      setCompactDetails(required > bar.clientWidth);
    };
    const observer = new ResizeObserver(measure);
    [bar, details, heading, restore, ...Array.from(heading.children)].forEach(
      (element) => observer.observe(element),
    );
    measure();
    return () => observer.disconnect();
  }, [selected, isPresent, copied, diffs.length, loading]);

  const [moreLoading, setMoreLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const request = useRef(0);
  const fallbackFile = useRef(
    useDocumentStore
      .getState()
      .files.find(
        (file) => file.id === useDocumentStore.getState().activeFileId,
      )?.relativePath ?? "",
  );
  const snapshotReady =
    isPresent || (!loading && selected?.id === loadedSnapshotId);
  const presentFile = isPresent
    ? projectFiles.find((file) => file.relativePath === path)
    : undefined;
  const contentKey = JSON.stringify([
    isPresent ? "present" : selected?.id,
    path,
    isPresent ? presentFile?.diskModifiedAt : null,
  ]);
  const content =
    isPresent && presentFile?.content !== undefined
      ? presentFile.content
      : fileResult?.key === contentKey
        ? fileResult.content
        : null;
  const contentError =
    isPresent && presentFile?.content !== undefined
      ? null
      : fileResult?.key === contentKey
        ? fileResult.error
        : null;
  const fileStatuses = useMemo(
    () =>
      new Map(
        (isPresent ? [] : diffs).map((diff) => [diff.file_path, diff.status]),
      ),
    [diffs, isPresent],
  );
  const changeClassName = (status: FileDiff["status"] | undefined) =>
    status ? `history-change-${status}` : undefined;
  const folderChangeClassName = (node: SidebarFileTreeNode) =>
    changeClassName(historyTreeStatus(node, fileStatuses));
  const activeDiff = isPresent
    ? null
    : (diffs.find((diff) => diff.file_path === path) ?? null);
  // Unrecorded current assets remain explicit for older snapshots. Never
  // substitute today's contents for a recorded historical file.
  const currentAssets = projectFiles.filter(
    (file) =>
      (file.type === "image" || file.type === "pdf") &&
      (isPresent ||
        (!snapshotFiles.includes(file.relativePath) &&
          !diffs.some((diff) => diff.file_path === file.relativePath))),
  );
  const mediaFile = currentAssets.find((file) => file.relativePath === path);
  const recordedType = getFileType(path);
  const recordedAsset =
    !isPresent &&
    snapshotFiles.includes(path) &&
    (recordedType === "image" ||
      recordedType === "pdf" ||
      recordedType === null ||
      (!!activeDiff &&
        activeDiff.old_content === null &&
        activeDiff.new_content === null));
  const index = isPresent
    ? -1
    : snapshots.findIndex((snapshot) => snapshot.id === selected?.id);
  const frontCardRef = useRef<HTMLElement>(null);
  const prepareCardMotion = useHistoryCardMotion(
    frontCardRef,
    isPresent ? "present" : (selected?.id ?? "loading"),
  );
  const projectName =
    projectRoot.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? "Project";

  async function loadTimeline() {
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    try {
      await useHistoryStore.getState().init(projectRoot);
      await useHistoryStore.getState().loadSnapshots(projectRoot);
      if (generation !== request.current) return;
      const loaded = useHistoryStore.getState().snapshots;
      setHasMore(loaded.length >= 50);
      setBaseline(loaded[0]?.id ?? null);
      setSelected(loaded[0] ?? null);
      setDiffs([]);
      setPath(fallbackFile.current || loaded[0]?.changed_files[0] || "");
    } catch (cause) {
      if (generation === request.current) setError(String(cause));
    } finally {
      if (generation === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void loadTimeline();
    return () => {
      request.current++;
    };
  }, [projectRoot]);

  useEffect(() => {
    if (!baseline || !snapshots.length) return;
    if (
      !snapshots.some((snapshot) => snapshot.id === baseline) ||
      (selected && !snapshots.some((snapshot) => snapshot.id === selected.id))
    ) {
      setConfirming(false);
      setBaseline(snapshots[0].id);
      setSelected(snapshots[0]);
    }
  }, [snapshots, baseline, selected]);

  useEffect(() => {
    if (isPresent || !selected || !baseline) return;
    const generation = ++request.current;
    setLoading(true);
    setError(null);
    setFileResult(null);
    setDiffs([]);
    setConfirming(false);
    const load =
      selected.id === baseline
        ? Promise.resolve([] as FileDiff[])
        : invoke<FileDiff[]>("history_diff", {
            projectRoot,
            fromId: baseline,
            toId: selected.id,
          });
    void Promise.all([
      load,
      invoke<string[]>("history_snapshot_files", {
        projectRoot,
        snapshotId: selected.id,
      }),
    ])
      .then(([result, recordedFiles]) => {
        if (generation !== request.current) return;
        setDiffs(result);
        setSnapshotFiles(recordedFiles);
        setLoadedSnapshotId(selected.id);
        setPath((previous) =>
          recordedFiles.includes(previous) ||
          result.some((diff) => diff.file_path === previous) ||
          useDocumentStore
            .getState()
            .files.some(
              (file) =>
                file.relativePath === previous &&
                (file.type === "image" || file.type === "pdf"),
            )
            ? previous
            : recordedFiles.includes(fallbackFile.current)
              ? fallbackFile.current
              : result[0]?.file_path || recordedFiles[0] || "",
        );
      })
      .catch((cause) => {
        if (generation === request.current)
          setError(`Could not load this snapshot. ${String(cause)}`);
      })
      .finally(() => {
        if (generation === request.current) setLoading(false);
      });
    return () => {
      if (generation === request.current) request.current++;
    };
  }, [projectRoot, selected, baseline, isPresent]);

  useEffect(() => {
    let canceled = false;
    setFileResult(null);
    if (!snapshotReady || !path || activeDiff || mediaFile || recordedAsset)
      return;
    if (
      isPresent &&
      (presentFile?.content !== undefined ||
        !presentFile ||
        presentFile.isBinary)
    )
      return;
    if (!isPresent && !selected) return;
    const read = isPresent
      ? readTextFile(presentFile!.absolutePath)
      : invoke<string>("history_file_at", {
          projectRoot,
          snapshotId: selected!.id,
          filePath: path,
        });
    void read
      .then((text) => {
        if (!canceled)
          setFileResult({ key: contentKey, content: text, error: null });
      })
      .catch(() => {
        if (!canceled)
          setFileResult({
            key: contentKey,
            content: null,
            error: isPresent
              ? "This current file could not be read."
              : "This file is unavailable in the selected snapshot.",
          });
      });
    return () => {
      canceled = true;
    };
  }, [
    projectRoot,
    selected,
    path,
    activeDiff,
    snapshotReady,
    contentKey,
    mediaFile,
    recordedAsset,
    isPresent,
    presentFile,
  ]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function restore() {
    const blocked = getHistoryRestoreBlockReason();
    if (
      isPresent ||
      !selected ||
      !snapshotReady ||
      useHistoryStore.getState().isRestoring ||
      blocked ||
      useDocumentStore.getState().projectRoot !== projectRoot
    ) {
      setError(blocked || "The project changed. Reopen history to continue.");
      return;
    }
    setError(null);
    try {
      await useHistoryStore
        .getState()
        .restoreSnapshot(projectRoot, selected.id);
      onClose();
    } catch (cause) {
      setError(`Could not restore this version. ${String(cause)}`);
      setConfirming(false);
    }
  }
  async function loadMore() {
    setMoreLoading(true);
    try {
      const count = useHistoryStore.getState().snapshots.length;
      await useHistoryStore.getState().loadMoreSnapshots(projectRoot);
      setHasMore(useHistoryStore.getState().snapshots.length > count);
    } catch (cause) {
      setError(`Could not load older history. ${String(cause)}`);
    } finally {
      setMoreLoading(false);
    }
  }
  function choose(snapshot: SnapshotInfo) {
    if (isRestoring || (!isPresent && selected?.id === snapshot.id)) return;
    setConfirming(false);
    const nextIndex = snapshots.findIndex((item) => item.id === snapshot.id);
    prepareCardMotion(nextIndex > index ? "older" : "newer");
    setIsPresent(false);
    setSelected(snapshot);
    setCopied(false);
  }
  function choosePresent() {
    if (isRestoring || isPresent) return;
    prepareCardMotion("newer");
    if (selected && baseline) request.current++;
    setIsPresent(true);
    setLoading(false);
    setError(null);
    setConfirming(false);
    setCopied(false);
    setPath((previous) =>
      projectFiles.some((file) => file.relativePath === previous)
        ? previous
        : (projectFiles.find(
            (file) => file.id === useDocumentStore.getState().activeFileId,
          )?.relativePath ??
          projectFiles[0]?.relativePath ??
          ""),
    );
  }
  return (
    <div
      className="history-stage"
      onKeyDown={(event) => {
        if (
          (event.target as HTMLElement).closest(
            '[data-slot="dialog-content"], [data-slot="popover-content"]',
          )
        )
          return;
        // Isolate editor/workspace shortcuts while this read-only modal is open.
        event.stopPropagation();
        if (isComposingKey(event)) return;
        if (event.key === "Escape" && !isRestoring) {
          const alreadyHandled = event.defaultPrevented;
          event.preventDefault();
          if (confirming) setConfirming(false);
          else if (!alreadyHandled) onClose();
        }
        if (
          (event.metaKey || event.ctrlKey) &&
          !["c", "a"].includes(event.key.toLowerCase())
        )
          event.preventDefault();
      }}
    >
      <TrafficLightSafeHeader
        trafficLightInset={trafficLightInset}
        className="history-stage-header"
        trailing={
          <div className="history-stage-header-actions">
            <HistoryPanel managementOnly />
            <Button
              variant="outline"
              size="sm"
              onClick={onClose}
              disabled={isRestoring}
              className="h-7 gap-2 rounded-lg text-xs"
            >
              <ArrowLeftIcon className="size-3.5" />
              Back to present
            </Button>
          </div>
        }
      >
        <div data-window-drag-region className="history-stage-heading">
          <DialogPrimitive.Title className="history-stage-title">
            Project rewind
          </DialogPrimitive.Title>
          <Hint content={projectName}>
            <span className="history-stage-project">{projectName}</span>
          </Hint>
        </div>
        <DialogPrimitive.Description
          id="history-workspace-description"
          className="sr-only"
        >
          Browse and restore previous versions of {projectName}.
        </DialogPrimitive.Description>
      </TrafficLightSafeHeader>
      <div className="history-stage-body">
        <div className="history-deck">
          {(selected || isPresent) &&
            snapshots
              .slice(index + 1, index + 4)
              .reverse()
              .map((snapshot, reverseIndex, cards) => {
                const depth = cards.length - reverseIndex;
                return (
                  <div
                    key={snapshot.id}
                    className="history-rear-card"
                    data-history-snapshot={snapshot.id}
                    aria-hidden="true"
                    style={{ "--history-depth": depth } as React.CSSProperties}
                  >
                    <span>{snapshotDate(snapshot.timestamp)}</span>
                    <span
                      className="history-title-separator"
                      aria-hidden="true"
                    >
                      ·
                    </span>
                    <span className="truncate">
                      {snapshotActionName(snapshot)}
                    </span>
                  </div>
                );
              })}
          <section
            ref={frontCardRef}
            className="history-front-card"
            data-testid="history-front-card"
            aria-label={
              isPresent
                ? "Current workspace preview"
                : "Selected project snapshot"
            }
          >
            <div
              ref={titleBarRef}
              className="history-card-header"
              data-confirming={confirming}
            >
              <div
                className="history-card-normal"
                aria-hidden={confirming || undefined}
                inert={confirming}
              >
                <div className="history-card-heading min-w-0 flex-1">
                  <Hint
                    content={
                      selected && !isPresent
                        ? snapshotDate(selected.timestamp)
                        : undefined
                    }
                  >
                    <div className="history-card-date shrink-0 font-bold text-foreground">
                      {isPresent
                        ? "Now"
                        : selected
                          ? snapshotDate(selected.timestamp)
                          : "Project rewind"}
                    </div>
                  </Hint>
                  <span className="history-title-separator" aria-hidden="true">
                    ·
                  </span>
                  <Hint
                    content={
                      selected && !isPresent
                        ? snapshotActionName(selected)
                        : projectName
                    }
                  >
                    <div className="truncate text-muted-foreground text-xs">
                      {isPresent
                        ? "Current workspace"
                        : selected
                          ? snapshotActionName(selected)
                          : loading
                            ? "Loading snapshots…"
                            : "No saved snapshots"}
                    </div>
                  </Hint>
                  {!isPresent && selected && !loading && (
                    <>
                      <span
                        className="history-title-separator"
                        aria-hidden="true"
                      >
                        ·
                      </span>
                      <Hint
                        content={`${diffs.length} ${diffs.length === 1 ? "file differs" : "files differ"} from latest snapshot`}
                      >
                        <span className="shrink-0 text-muted-foreground">
                          {diffs.length}{" "}
                          {diffs.length === 1 ? "file differs" : "files differ"}{" "}
                          from latest snapshot
                        </span>
                      </Hint>
                    </>
                  )}
                </div>
                {!isPresent && selected && (
                  <>
                    <div
                      ref={inlineDetailsRef}
                      className="history-inline-details"
                      data-collapsed={compactDetails}
                      aria-hidden={compactDetails}
                      inert={compactDetails}
                    >
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1.5 text-muted-foreground text-xs"
                        aria-label="Label snapshot"
                        disabled={isRestoring}
                        onClick={() => {
                          setLabel("");
                          setLabelOpen(true);
                        }}
                      >
                        <BookmarkIcon className="size-3.5" />
                        {snapshotDisplayLabels(selected).length
                          ? snapshotDisplayLabels(selected).map((tag) => (
                              <Badge
                                key={tag}
                                variant={
                                  snapshotAutomaticLabels(selected).includes(
                                    tag,
                                  )
                                    ? "outline"
                                    : "secondary"
                                }
                              >
                                {tag}
                              </Badge>
                            ))
                          : "No tags"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="font-mono text-muted-foreground text-xs"
                        aria-label="Copy snapshot ID"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(selected.id)
                            .then(() => setCopied(true))
                            .catch(() =>
                              setError("Could not copy the snapshot ID."),
                            )
                        }
                      >
                        {copied ? (
                          "Copied"
                        ) : (
                          <>
                            <CopyIcon className="size-3" />
                            {selected.id.slice(0, 7)}
                          </>
                        )}
                      </Button>
                    </div>
                    {compactDetails && (
                      <Popover key={selected.id}>
                        <Hint content="Snapshot tags and details">
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Snapshot details"
                              disabled={isRestoring}
                            >
                              <BookmarkIcon className="size-3.5" />
                            </Button>
                          </PopoverTrigger>
                        </Hint>
                        <PopoverContent
                          align="end"
                          className="z-[60] space-y-3 p-3"
                          aria-label="Snapshot details"
                        >
                          <div className="font-medium text-sm">
                            Snapshot tags
                          </div>
                          <div
                            className="history-snapshot-tags app-scrollbar"
                            role="group"
                            aria-label="Snapshot tags"
                          >
                            {selected &&
                            snapshotDisplayLabels(selected).length ? (
                              snapshotDisplayLabels(selected).map((tag) => (
                                <Hint content={tag} key={tag}>
                                  <Badge
                                    variant={
                                      snapshotAutomaticLabels(
                                        selected,
                                      ).includes(tag)
                                        ? "outline"
                                        : "secondary"
                                    }
                                    className="max-w-full shrink-0"
                                  >
                                    <span className="truncate">{tag}</span>
                                  </Badge>
                                </Hint>
                              ))
                            ) : (
                              <span className="text-muted-foreground text-sm">
                                No tags
                              </span>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full justify-start"
                            onClick={() => {
                              setLabel("");
                              setLabelOpen(true);
                            }}
                            disabled={isRestoring}
                          >
                            Label snapshot
                          </Button>
                          <div className="border-border border-t pt-3">
                            <div className="mb-1 text-muted-foreground text-xs">
                              Snapshot ID
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="font-mono text-muted-foreground text-xs"
                              aria-label="Copy snapshot ID"
                              onClick={() =>
                                void navigator.clipboard
                                  .writeText(selected.id)
                                  .then(() => setCopied(true))
                                  .catch(() =>
                                    setError("Could not copy the snapshot ID."),
                                  )
                              }
                            >
                              {copied ? (
                                "Copied"
                              ) : (
                                <>
                                  <CopyIcon className="size-3" />
                                  {selected.id.slice(0, 7)}
                                </>
                              )}
                            </Button>
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                    <Hint content={restoreBlocked || undefined}>
                      <Button
                        className="history-restore-button shrink-0 rounded-lg"
                        aria-label="Restore project version"
                        disabled={
                          !selected ||
                          !snapshotReady ||
                          !!error ||
                          !!restoreBlocked ||
                          isRestoring
                        }
                        onClick={() => setConfirming(true)}
                      >
                        <HistoryIcon className="size-4" />
                        Restore
                      </Button>
                    </Hint>
                  </>
                )}
              </div>
              <div
                className="history-restore-confirmation"
                role="group"
                aria-label="Confirm restore"
                aria-hidden={!confirming || undefined}
                inert={!confirming}
              >
                <span className="min-w-0 flex-1 font-medium text-sm">
                  Restore this version?
                </span>
                <Button
                  className="h-7 rounded-lg px-3 text-xs"
                  disabled={!confirming || isRestoring || !!restoreBlocked}
                  onClick={() => void restore()}
                >
                  {isRestoring && (
                    <LoaderIcon className="size-3 animate-spin" />
                  )}
                  Confirm
                </Button>
                <Button
                  data-cancel-restore
                  variant="outline"
                  className="h-7 rounded-lg px-3 text-xs"
                  disabled={isRestoring}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
            <div className="history-card-body">
              <aside
                className="history-files history-shared-files"
                aria-label="Snapshot files"
              >
                <SidebarFiles
                  className="bg-background text-sidebar-foreground"
                  files={
                    isPresent
                      ? projectFiles.map((file) => ({
                          ...file,
                          id: file.relativePath,
                        }))
                      : !snapshotReady
                        ? []
                        : [
                            ...new Set([
                              ...snapshotFiles,
                              ...diffs.map((diff) => diff.file_path),
                              ...currentAssets.map((file) => file.relativePath),
                            ]),
                          ].map((file) => ({
                            id: file,
                            name: file.split("/").pop() || file,
                            relativePath: file,
                            type:
                              currentAssets.find(
                                (asset) => asset.relativePath === file,
                              )?.type ??
                              (file.endsWith(".tex")
                                ? "tex"
                                : file.endsWith(".bib")
                                  ? "bib"
                                  : file.endsWith(".sty") ||
                                      file.endsWith(".cls")
                                    ? "style"
                                    : "other"),
                          }))
                  }
                  folders={isPresent ? projectFolders : undefined}
                  activeFileId={path}
                  onSelectFile={setPath}
                  description={
                    isPresent
                      ? "Current working files"
                      : selected?.id === baseline
                        ? "Latest saved version"
                        : "Compared with latest snapshot"
                  }
                  fileRowProps={(file) => ({
                    "data-testid": `history-file-${file.relativePath}`,
                    "aria-pressed": path === file.id,
                  })}
                  fileTextClassName={(file) =>
                    changeClassName(fileStatuses.get(file.relativePath))
                  }
                  folderTextClassName={folderChangeClassName}
                  folderIconClassName={folderChangeClassName}
                  renderFileBadge={(file) => {
                    if (isPresent)
                      return projectFiles.find(
                        (item) => item.relativePath === file.relativePath,
                      )?.isDirty ? (
                        <span className="text-[10px] text-muted-foreground">
                          Unsaved
                        </span>
                      ) : null;
                    if (
                      currentAssets.some(
                        (asset) => asset.relativePath === file.relativePath,
                      )
                    ) {
                      return (
                        <Hint content="Current project asset. Not a historical preview.">
                          <span className="text-[10px] text-muted-foreground">
                            Current
                          </span>
                        </Hint>
                      );
                    }
                    const status = diffs.find(
                      (diff) => diff.file_path === file.relativePath,
                    )?.status;
                    return status ? (
                      <span
                        role="img"
                        className={`history-file-status is-${status}`}
                        aria-label={
                          status === "added"
                            ? "Added in selected version"
                            : status === "deleted"
                              ? "Absent in selected version"
                              : "Modified"
                        }
                      >
                        {status === "added"
                          ? "A"
                          : status === "deleted"
                            ? "D"
                            : "M"}
                      </span>
                    ) : null;
                  }}
                />
                {!isPresent && diffs.length > 0 && (
                  <div className="history-file-legend">
                    <span className="history-change-added">A Added</span>
                    <span className="history-change-modified">M Modified</span>
                    <span className="history-change-deleted">D Absent</span>
                  </div>
                )}
              </aside>
              <div className="history-content">
                {error ? (
                  <div className="history-empty" role="alert">
                    <p>{error}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void loadTimeline()}
                    >
                      Reload history
                    </Button>
                  </div>
                ) : !isPresent && !selected && !loading ? (
                  <div className="history-empty">
                    <Clock3Icon className="size-7 text-muted-foreground" />
                    <p>No saved history yet</p>
                    <p className="text-muted-foreground text-sm">
                      Snapshots will appear here as you work.
                    </p>
                  </div>
                ) : (
                  <WorkspacePanel
                    className="h-full"
                    data-history-panel={
                      mediaFile || recordedAsset ? "media" : "source"
                    }
                  >
                    {recordedAsset && selected ? (
                      <HistoryRecordedAsset
                        key={`${selected.id}:${path}`}
                        projectRoot={projectRoot}
                        snapshotId={selected.id}
                        path={path}
                      />
                    ) : mediaFile ? (
                      <HistoryMediaContent
                        key={mediaFile.id}
                        file={mediaFile}
                      />
                    ) : isPresent && presentFile?.isBinary ? (
                      <div className="history-empty">
                        Preview is unavailable for this binary file.
                      </div>
                    ) : contentError ? (
                      <div className="history-empty" role="alert">
                        <p>{contentError}</p>
                      </div>
                    ) : (
                      <HistorySnapshotContent
                        currentWorkspace={isPresent}
                        diff={activeDiff}
                        path={path}
                        content={content}
                        loading={
                          !snapshotReady ||
                          (!activeDiff &&
                            !!path &&
                            !(
                              isPresent && presentFile?.content !== undefined
                            ) &&
                            !!(isPresent ? presentFile : true) &&
                            fileResult?.key !== contentKey)
                        }
                      />
                    )}
                  </WorkspacePanel>
                )}
              </div>
            </div>
            {!isPresent && restoreBlocked && (
              <p role="alert" className="history-restore-note">
                {restoreBlocked}
              </p>
            )}
          </section>
        </div>
        <nav
          className="history-timeline app-scrollbar"
          aria-label="History timeline"
        >
          <button
            type="button"
            className={cn("history-timeline-now", isPresent && "is-selected")}
            data-testid="history-now"
            aria-current={isPresent ? "true" : undefined}
            onClick={choosePresent}
            disabled={isRestoring}
          >
            <span className="history-timeline-dot" />
            <span>
              Now
              <span className="block font-normal text-muted-foreground text-xs">
                Current workspace
              </span>
            </span>
          </button>
          {snapshots.map((snapshot) => (
            <button
              type="button"
              key={snapshot.id}
              data-testid={`history-snapshot-${snapshot.id}`}
              className={cn(
                "history-timeline-entry",
                !isPresent && snapshot.id === selected?.id && "is-selected",
              )}
              aria-current={
                !isPresent && snapshot.id === selected?.id ? "true" : undefined
              }
              disabled={isRestoring}
              onClick={() => choose(snapshot)}
            >
              <span className="history-timeline-dot" />
              <span className="min-w-0">
                <span className="block text-sm">
                  {new Date(snapshot.timestamp * 1000).toLocaleTimeString(
                    undefined,
                    { hour: "numeric", minute: "2-digit" },
                  )}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {new Date(snapshot.timestamp * 1000).toLocaleDateString(
                    undefined,
                    { month: "short", day: "numeric" },
                  )}
                </span>
                <span className="history-timeline-description">
                  {snapshotTitle(snapshot)}
                </span>
                {snapshotDisplayLabels(snapshot).map((label) => (
                  <Hint content={label} key={label}>
                    <Badge
                      variant={
                        snapshotAutomaticLabels(snapshot).includes(label)
                          ? "outline"
                          : "secondary"
                      }
                      className={cn(
                        "mt-1 mr-1 max-w-full text-[10px]",
                        snapshotAutomaticLabels(snapshot).includes(label) &&
                          "border-foreground/40",
                      )}
                    >
                      <span className="truncate">{label}</span>
                    </Badge>
                  </Hint>
                ))}
                <Hint content={snapshot.id}>
                  <Badge
                    variant="outline"
                    className="mt-1 rounded-[4px] px-1.5 py-0 font-mono font-normal text-[10px] text-muted-foreground"
                  >
                    {snapshot.id.slice(0, 7)}
                  </Badge>
                </Hint>
              </span>
            </button>
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-3 ml-6"
              onClick={() => void loadMore()}
              disabled={moreLoading}
            >
              {moreLoading ? (
                <LoaderIcon className="size-3 animate-spin" />
              ) : (
                "Older history"
              )}
            </Button>
          )}
          <div className="history-timeline-navigation">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Newer snapshot"
              disabled={isPresent || !selected || isRestoring}
              onClick={() =>
                index === 0 ? choosePresent() : choose(snapshots[index - 1])
              }
            >
              <ChevronUpIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Older snapshot"
              disabled={
                !snapshots.length ||
                (!isPresent && (index < 0 || index >= snapshots.length - 1)) ||
                isRestoring
              }
              onClick={() => choose(snapshots[index + 1])}
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </div>
        </nav>
      </div>
      <Dialog
        open={labelOpen}
        onOpenChange={(next) => {
          if (!labelSaving) setLabelOpen(next);
        }}
      >
        <DialogContent
          showCloseButton={!labelSaving}
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>Snapshot labels</DialogTitle>
          </DialogHeader>
          {selected && snapshotDisplayLabels(selected).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {snapshotAutomaticLabels(selected).map((automaticLabel) => (
                <span
                  key={automaticLabel}
                  className={cn(
                    buttonVariants({
                      variant: "outline",
                      size: "sm",
                    }),
                    "border-foreground/40 bg-secondary text-secondary-foreground shadow-none hover:bg-secondary dark:border-foreground/40 dark:bg-secondary dark:hover:bg-secondary",
                  )}
                >
                  {automaticLabel}
                </span>
              ))}
              {selected.labels.map((existing) => (
                <Hint content="Remove label" key={existing}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={labelSaving}
                    aria-label={`Remove label ${existing}`}
                    onClick={() => {
                      setLabelError(null);
                      setLabelSaving(true);
                      void useHistoryStore
                        .getState()
                        .removeLabel(projectRoot, existing, selected.id)
                        .then(() =>
                          setSelected((current) =>
                            current?.id === selected.id
                              ? {
                                  ...current,
                                  labels: current.labels.filter(
                                    (item) => item !== existing,
                                  ),
                                }
                              : current,
                          ),
                        )
                        .catch((cause) => setLabelError(String(cause)))
                        .finally(() => setLabelSaving(false));
                    }}
                  >
                    {existing}
                    <span aria-hidden="true">×</span>
                  </Button>
                </Hint>
              ))}
            </div>
          )}
          {labelError && (
            <p role="alert" className="text-destructive text-sm">
              {labelError}
            </p>
          )}
          <SearchablePicker
            hideWhenEmpty
            disabled={labelSaving}
            query={label}
            onQueryChange={setLabel}
            label="Snapshot label"
            placeholder="Type a label"
            options={snapshotLabelOptions(labelCounts, label, selected?.labels)}
            onSelect={saveLabel}
            onSubmit={() => saveLabel(label)}
            emptyText="No existing labels"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={labelSaving}
              onClick={() => setLabelOpen(false)}
            >
              Done
            </Button>
            <Hint content={labelInvalidReason}>
              <span
                className="inline-flex"
                tabIndex={labelInvalidReason ? 0 : undefined}
              >
                <Button
                  disabled={!!labelInvalidReason || labelSaving}
                  onClick={() => saveLabel(label)}
                >
                  Save label
                </Button>
              </span>
            </Hint>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
