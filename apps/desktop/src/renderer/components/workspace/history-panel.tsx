import { SearchablePicker } from "@/components/ui/searchable-picker";
import {
  HISTORY_CLEAR_DESCRIPTION,
  HISTORY_CLEAR_WARNING,
  HISTORY_CLEAR_PRESERVED,
} from "@/lib/history-confirmation";
import {
  snapshotAutomaticLabels,
  labelValidationReason,
} from "./history-workspace-model";
import { invoke } from "@/lib/desktop/core";
import { Hint } from "@/components/ui/tooltip";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  HistoryIcon,
  LoaderIcon,
  TagIcon,
  RotateCcwIcon,
  CopyIcon,
  PlusIcon,
  XIcon,
  HardDriveIcon,
  CircleHelpIcon,
  Trash2Icon,
  AlertCircleIcon,
} from "lucide-react";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { useDocumentStore } from "@/stores/document-store";
import { cn } from "@/lib/utils";
import { PopupHeader, PopupSeparator } from "@/components/ui/popup-surface";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogIconHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ─── Helpers ───

function formatRelativeTime(timestamp: number): string {
  const now = Date.now() / 1000;
  const diff = now - timestamp;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function snapshotTypeLabel(message: string): string {
  if (message.startsWith("[auto]")) return "Auto-save";
  if (message.startsWith("[manual]")) return "Save";
  if (message.startsWith("[compile]")) return "Compile";
  if (message.startsWith("[claude]"))
    return message.includes("Before") ? "Before Claude" : "After Claude";
  if (message.startsWith("[before-restore]")) return "Before restore";
  if (message.startsWith("[restore]")) return "Restore";
  if (message.startsWith("[init]")) return "Initial";
  return message;
}

function snapshotTypeBadgeColor(message: string): string {
  if (message.startsWith("[claude]"))
    return "bg-violet-500/15 text-violet-600 dark:text-violet-400";
  if (message.startsWith("[restore]"))
    return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (message.startsWith("[manual]"))
    return "bg-blue-500/15 text-blue-600 dark:text-blue-400";
  if (message.startsWith("[compile]"))
    return "bg-green-500/15 text-green-600 dark:text-green-400";
  return "bg-muted text-muted-foreground";
}

const HISTORY_LIMIT_OPTIONS = [100, 250, 500, 1024].map((megabytes) => ({
  bytes: megabytes * 1024 * 1024,
  label: megabytes === 1024 ? "1 GB" : `${megabytes} MB`,
}));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(1)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}

// ─── Panel ───

export function HistoryPanel({
  maxHeight,
  managementOnly = false,
}: {
  maxHeight?: string;
  managementOnly?: boolean;
}) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const snapshots = useHistoryStore((s) => s.snapshots);
  const isLoading = useHistoryStore((s) => s.isLoading);
  const isRestoring = useHistoryStore((s) => s.isRestoring);
  const reviewingSnapshot = useHistoryStore((s) => s.reviewingSnapshot);
  const init = useHistoryStore((s) => s.init);
  const loadSnapshots = useHistoryStore((s) => s.loadSnapshots);
  const loadMoreSnapshots = useHistoryStore((s) => s.loadMoreSnapshots);
  const loadDiff = useHistoryStore((s) => s.loadDiff);
  const startReview = useHistoryStore((s) => s.startReview);
  const restoreSnapshot = useHistoryStore((s) => s.restoreSnapshot);
  const addLabel = useHistoryStore((s) => s.addLabel);
  const removeLabel = useHistoryStore((s) => s.removeLabel);
  const storageInfo = useHistoryStore((s) => s.storageInfo);
  const isStorageInfoLoading = useHistoryStore((s) => s.isStorageInfoLoading);
  const isHistoryClearing = useHistoryStore((s) => s.isHistoryClearing);
  const managementError = useHistoryStore((s) => s.managementError);
  const loadStorageInfo = useHistoryStore((s) => s.loadStorageInfo);
  const setStorageLimit = useHistoryStore((s) => s.setStorageLimit);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const clearManagementError = useHistoryStore((s) => s.clearManagementError);

  const labelCounts = useHistoryStore((state) => state.labelCounts);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [labelDialogOpen, setLabelDialogOpen] = useState(false);
  const [labelTargetId, setLabelTargetId] = useState<string | null>(null);
  const [labelValue, setLabelValue] = useState("");
  const [managementDialogOpen, setManagementDialogOpen] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [pendingLimit, setPendingLimit] = useState<number | null>(null);

  // Init history when project opens
  useEffect(() => {
    if (!projectRoot || managementOnly) return;
    init(projectRoot)
      .then(() => loadSnapshots(projectRoot))
      .catch(console.error);
  }, [projectRoot, init, loadSnapshots, managementOnly]);

  // Infinite scroll
  const scrollRef = useRef<HTMLDivElement>(null);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !projectRoot || isLoading) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
      loadMoreSnapshots(projectRoot);
    }
  }, [projectRoot, isLoading, loadMoreSnapshots]);

  // Click to show diff in editor
  const handleClick = useCallback(
    async (snap: SnapshotInfo) => {
      if (!projectRoot) return;
      // Toggle off if already reviewing this snapshot
      if (reviewingSnapshot?.id === snap.id) {
        useHistoryStore.getState().stopReview();
        return;
      }
      // Find parent snapshot (the one right after in the linear list)
      const idx = snapshots.findIndex((s) => s.id === snap.id);
      const parent = snapshots[idx + 1];
      if (parent) {
        await loadDiff(projectRoot, parent.id, snap.id);
        startReview(snap);
      }
    },
    [projectRoot, snapshots, reviewingSnapshot, loadDiff, startReview],
  );

  const handleRestore = useCallback(
    async (snapshotId: string) => {
      if (!projectRoot) return;
      // Stop any active review
      useHistoryStore.getState().stopReview();
      await restoreSnapshot(projectRoot, snapshotId);
      // The restore action refreshes source files and the full history list.
    },
    [projectRoot, restoreSnapshot],
  );

  const labelInvalidReason = labelValidationReason(
    labelValue,
    snapshots.find((snapshot) => snapshot.id === labelTargetId)?.labels,
  );
  const handleAddLabel = useCallback(
    async (value = labelValue) => {
      const label = value.trim();
      if (
        !labelTargetId ||
        !projectRoot ||
        labelValidationReason(
          value,
          snapshots.find((snapshot) => snapshot.id === labelTargetId)?.labels,
        )
      )
        return;
      try {
        await addLabel(projectRoot, labelTargetId, label);
        setLabelDialogOpen(false);
        setLabelValue("");
        setLabelTargetId(null);
      } catch (error) {
        setLabelError(String(error));
      }
    },
    [projectRoot, labelTargetId, labelValue, addLabel, snapshots],
  );

  const openLabelDialog = useCallback((snapshotId: string) => {
    setLabelError(null);
    setLabelTargetId(snapshotId);
    setLabelValue("");
    setLabelDialogOpen(true);
  }, []);

  const openManagementDialog = useCallback(() => {
    if (!projectRoot) return;
    setConfirmingClear(false);
    clearManagementError();
    setManagementDialogOpen(true);
    void loadStorageInfo(projectRoot);
  }, [projectRoot, clearManagementError, loadStorageInfo]);

  const handleManagementDialogChange = useCallback(
    (open: boolean) => {
      setManagementDialogOpen(open);
      if (!open) {
        setConfirmingClear(false);
        setPendingLimit(null);
        clearManagementError();
      }
    },
    [clearManagementError],
  );

  const handleStorageLimitChange = useCallback(
    (value: string) => {
      if (!projectRoot) return;
      const limit = Number(value);
      if (
        storageInfo &&
        limit < storageInfo.limitBytes &&
        limit < storageInfo.usageBytes
      ) {
        setPendingLimit(limit);
        return;
      }
      void setStorageLimit(projectRoot, limit);
    },
    [projectRoot, setStorageLimit, storageInfo],
  );

  const handleClearHistory = useCallback(async () => {
    if (!projectRoot) return;
    const result = await clearHistory(projectRoot);
    if (result) {
      setConfirmingClear(false);
      setManagementDialogOpen(false);
    }
  }, [projectRoot, clearHistory]);

  if (!projectRoot) {
    return (
      <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
        <p className="text-muted-foreground text-xs">
          Open a project to view history.
        </p>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col", maxHeight || "h-full")}>
      {/* Header */}
      {managementOnly ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={openManagementDialog}
          aria-label="Manage automatic history"
        >
          <HardDriveIcon className="size-4" /> Manage history
        </Button>
      ) : (
        <PopupHeader
          action={
            <Hint content="Manage automatic history">
              <Button
                aria-label="Manage automatic history"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground"
                onClick={openManagementDialog}
              >
                <HardDriveIcon className="size-3.5" />
              </Button>
            </Hint>
          }
        >
          <HistoryIcon className="size-3.5 text-muted-foreground" />
          <span>History</span>
        </PopupHeader>
      )}
      {!managementOnly && (
        <>
          <PopupSeparator />
          <div
            ref={scrollRef}
            className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
            onScroll={handleScroll}
          >
            {snapshots.length === 0 && !isLoading ? (
              <div className="px-3 py-4 text-center text-muted-foreground text-xs">
                No history yet
              </div>
            ) : (
              <div className="py-1">
                {snapshots.map((snap) => (
                  <SnapshotRow
                    key={snap.id}
                    snapshot={snap}
                    isSelected={reviewingSnapshot?.id === snap.id}
                    isRestoring={isRestoring}
                    onClick={() => handleClick(snap)}
                    onRestore={() => handleRestore(snap.id)}
                    onAddLabel={() => openLabelDialog(snap.id)}
                    onRemoveLabel={(label) =>
                      projectRoot && removeLabel(projectRoot, label, snap.id)
                    }
                    onCopySha={() => navigator.clipboard.writeText(snap.id)}
                  />
                ))}
              </div>
            )}

            {isLoading && (
              <div className="flex items-center justify-center py-2">
                <LoaderIcon className="size-3 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>
        </>
      )}
      {/* Label dialog */}
      <Dialog open={labelDialogOpen} onOpenChange={setLabelDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Label</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <SearchablePicker
              hideWhenEmpty
              label="Snapshot label"
              placeholder="Type a label"
              query={labelValue}
              onQueryChange={setLabelValue}
              options={Object.keys(labelCounts)
                .filter(
                  (name) =>
                    labelCounts[name] > 0 &&
                    name.trim() !== "Agent" &&
                    name.trim() !== "Comments" &&
                    !snapshots
                      .find((snapshot) => snapshot.id === labelTargetId)
                      ?.labels.includes(name) &&
                    name
                      .toLowerCase()
                      .includes(labelValue.trim().toLowerCase()),
                )
                .map((name) => ({ value: name, label: name }))}
              onSelect={(value) => void handleAddLabel(value)}
              onSubmit={() => void handleAddLabel()}
            />
            {labelError && (
              <p role="alert" className="text-destructive text-sm">
                {labelError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLabelDialogOpen(false)}>
              Cancel
            </Button>
            <Hint content={labelInvalidReason}>
              <span
                className="inline-flex"
                tabIndex={labelInvalidReason ? 0 : undefined}
              >
                <Button
                  onClick={() => void handleAddLabel()}
                  disabled={!!labelInvalidReason}
                >
                  Add
                </Button>
              </span>
            </Hint>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={managementDialogOpen && !confirmingClear && pendingLimit === null}
        onOpenChange={handleManagementDialogChange}
      >
        <DialogContent
          className="rounded-[20px] bg-muted p-4 shadow-2xl sm:max-w-md dark:bg-background"
          overlayClassName="bg-black/10"
          showCloseButton={false}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (confirmingClear || pendingLimit !== null)
              event.preventDefault();
          }}
        >
          <DialogHeader className="space-y-3">
            <DialogIconHeader>
              <HardDriveIcon aria-hidden="true" />
            </DialogIconHeader>
            <div className="flex items-center gap-2">
              <DialogTitle>Manage automatic history</DialogTitle>
              <Hint content="Private snapshots of sources and assets. Cleanup keeps the latest 50 snapshots and custom-labeled versions. These controls leave project files and Git unchanged.">
                <button
                  type="button"
                  aria-label="About automatic history"
                  className="rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CircleHelpIcon className="size-4" />
                </button>
              </Hint>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium">Storage used</span>
                <span className="text-muted-foreground tabular-nums">
                  {isStorageInfoLoading && !storageInfo
                    ? "Calculating…"
                    : `${formatBytes(storageInfo?.usageBytes ?? 0)} of ${formatBytes(
                        storageInfo?.limitBytes ??
                          HISTORY_LIMIT_OPTIONS[1].bytes,
                      )}`}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${Math.min(
                      100,
                      storageInfo && storageInfo.limitBytes > 0
                        ? (storageInfo.usageBytes / storageInfo.limitBytes) *
                            100
                        : 0,
                    )}%`,
                  }}
                />
              </div>
              <div className="mt-2 text-muted-foreground text-xs">
                {storageInfo
                  ? `${storageInfo.snapshotCount} snapshot${storageInfo.snapshotCount === 1 ? "" : "s"}`
                  : "Snapshot count unavailable"}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-sm">Storage limit</div>
                <div className="text-muted-foreground text-xs">
                  Recent and labeled snapshots may exceed this limit.
                </div>
              </div>
              <Select
                value={String(
                  storageInfo?.limitBytes ?? HISTORY_LIMIT_OPTIONS[1].bytes,
                )}
                onValueChange={handleStorageLimitChange}
                disabled={isStorageInfoLoading}
              >
                <SelectTrigger
                  size="sm"
                  className="w-28"
                  aria-label="Automatic history storage limit"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {HISTORY_LIMIT_OPTIONS.map((option) => (
                    <SelectItem key={option.bytes} value={String(option.bytes)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {managementError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-xs"
              >
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>{managementError}</span>
              </div>
            )}

            <div className="border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-auto shrink-0"
                  onClick={() =>
                    void invoke("open_settings_window", {
                      section: "storage",
                    }).catch((error) =>
                      useHistoryStore.setState({
                        managementError: String(error),
                      }),
                    )
                  }
                >
                  <HardDriveIcon className="size-3.5" />
                  Manage all projects
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-auto shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setConfirmingClear(true)}
                >
                  <Trash2Icon className="size-3.5" />
                  Clear history
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={managementDialogOpen && confirmingClear}
        onOpenChange={(open) => {
          if (!open && !isHistoryClearing) {
            setConfirmingClear(false);
            clearManagementError();
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            if (managementDialogOpen) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isHistoryClearing) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (isHistoryClearing) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Clear history?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span className="block font-medium text-foreground">
                  {projectRoot.split(/[\\/]/).filter(Boolean).pop()}
                </span>
                <span className="mt-2 block">
                  {HISTORY_CLEAR_DESCRIPTION}{" "}
                  <strong className="font-semibold text-foreground">
                    {HISTORY_CLEAR_WARNING}
                  </strong>
                </span>
                <span className="mt-2 block">{HISTORY_CLEAR_PRESERVED}</span>
              </div>
            </DialogDescription>
          </DialogHeader>
          {managementError && (
            <p role="alert" className="text-destructive text-sm">
              {managementError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={isHistoryClearing}
              autoFocus
              onClick={() => {
                setConfirmingClear(false);
                clearManagementError();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isHistoryClearing}
              onClick={handleClearHistory}
            >
              {isHistoryClearing ? "Working…" : "Clear history"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={managementDialogOpen && pendingLimit !== null}
        onOpenChange={(open) => {
          if (!open && !isStorageInfoLoading) {
            setPendingLimit(null);
            clearManagementError();
          }
        }}
      >
        <DialogContent
          className="sm:max-w-md"
          onCloseAutoFocus={(event) => {
            if (managementDialogOpen) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (isStorageInfoLoading) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            if (isStorageInfoLoading) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Lower history limit?</DialogTitle>
            <DialogDescription asChild>
              <div>
                <span>
                  Reducing the limit to {formatBytes(pendingLimit ?? 0)} may
                  delete older snapshots. The latest 50 and labeled snapshots
                  will be kept.
                </span>
                <strong className="mt-2 block font-semibold text-foreground">
                  Deleted snapshots cannot be recovered.
                </strong>
              </div>
            </DialogDescription>
          </DialogHeader>
          {managementError && (
            <p role="alert" className="text-destructive text-sm">
              {managementError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              disabled={isStorageInfoLoading}
              onClick={() => {
                setPendingLimit(null);
                clearManagementError();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isStorageInfoLoading}
              onClick={async () => {
                if (pendingLimit === null) return;
                const result = await setStorageLimit(projectRoot, pendingLimit);
                if (result) setPendingLimit(null);
              }}
            >
              {isStorageInfoLoading ? "Working…" : "Lower limit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Snapshot Row ───

function SnapshotRow({
  snapshot,
  isSelected,
  isRestoring,
  onClick,
  onRestore,
  onAddLabel,
  onRemoveLabel,
  onCopySha,
}: {
  snapshot: SnapshotInfo;
  isSelected: boolean;
  isRestoring: boolean;
  onClick: () => void;
  onRestore: () => void;
  onAddLabel: () => void;
  onRemoveLabel: (label: string) => void;
  onCopySha: () => void;
}) {
  const hasFiles = snapshot.changed_files.length > 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className={cn(
            "group flex w-full items-start rounded-sm px-2 py-1.5 text-left outline-hidden transition-colors focus-visible:bg-accent",
            isSelected ? "bg-accent" : "menu-open:bg-accent hover:bg-accent",
          )}
          onClick={onClick}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium text-xs leading-tight",
                  snapshotTypeBadgeColor(snapshot.message),
                )}
              >
                {snapshotTypeLabel(snapshot.message)}
              </span>
              <span className="text-muted-foreground text-xs">
                {formatRelativeTime(snapshot.timestamp)}
              </span>
            </div>

            {snapshotAutomaticLabels(snapshot).map((label) => (
              <span
                key={label}
                className="inline-flex rounded border border-border bg-transparent px-1.5 py-0.5 text-foreground text-xs"
              >
                {label}
              </span>
            ))}

            {/* Labels */}
            {snapshot.labels.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-0.5">
                {snapshot.labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-0.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-600 text-xs dark:text-amber-400"
                  >
                    <TagIcon className="size-2" />
                    {label}
                    <button
                      aria-label={`Remove label ${label}`}
                      className="ml-0.5 rounded-sm opacity-0 hover:text-destructive group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveLabel(label);
                      }}
                    >
                      <XIcon className="size-2" />
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* Changed files summary */}
            {hasFiles && (
              <div className="mt-0.5 truncate text-muted-foreground text-xs">
                {snapshot.changed_files
                  .map((f) => f.split(/[/\\]/).pop())
                  .join(", ")}
              </div>
            )}
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onRestore} disabled={isRestoring}>
          <RotateCcwIcon className="mr-2 size-3.5" />
          Restore this version
        </ContextMenuItem>
        <ContextMenuItem onClick={onAddLabel}>
          <PlusIcon className="mr-2 size-3.5" />
          Add label
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onCopySha}>
          <CopyIcon className="mr-2 size-3.5" />
          Copy SHA
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
