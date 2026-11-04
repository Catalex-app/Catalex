import { createPanelStore } from "@/lib/panel-window-runtime";
import {
  flushProjectCommentWrites,
  notifyProjectCommentsRestored,
  restoreWithProjectComments,
} from "@/components/workspace/editor/inline-comment-storage";
import { useDocumentStore } from "./document-store";
import { invoke } from "@/lib/desktop/core";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("history");

// ─── Types ───

export interface SnapshotInfo {
  id: string;
  message: string;
  timestamp: number;
  labels: string[];
  changed_files: string[];
}

export interface FileDiff {
  file_path: string;
  status: "added" | "modified" | "deleted";
  old_content: string | null;
  new_content: string | null;
}

export interface HistoryStorageInfo {
  usageBytes: number;
  limitBytes: number;
  snapshotCount: number;
  protectedSnapshotCount: number;
}

interface HistoryState {
  snapshots: SnapshotInfo[];
  labelCounts: Record<string, number>;
  loadLabelCounts: (projectRoot: string) => Promise<void>;
  isLoading: boolean;
  selectedSnapshotId: string | null;
  diffResult: FileDiff[] | null;
  isDiffLoading: boolean;
  isRestoring: boolean;
  reviewingSnapshot: SnapshotInfo | null;
  storageInfo: HistoryStorageInfo | null;
  isStorageInfoLoading: boolean;
  isHistoryClearing: boolean;
  managementError: string | null;

  init: (projectRoot: string) => Promise<void>;
  createSnapshot: (
    projectRoot: string,
    message: string,
  ) => Promise<SnapshotInfo | null>;
  loadSnapshots: (projectRoot: string) => Promise<void>;
  loadMoreSnapshots: (projectRoot: string) => Promise<void>;
  selectSnapshot: (id: string | null) => void;
  loadDiff: (
    projectRoot: string,
    fromId: string,
    toId: string,
  ) => Promise<void>;
  getFileAt: (
    projectRoot: string,
    snapshotId: string,
    filePath: string,
  ) => Promise<string>;
  restoreSnapshot: (
    projectRoot: string,
    snapshotId: string,
  ) => Promise<SnapshotInfo>;
  addLabel: (
    projectRoot: string,
    snapshotId: string,
    label: string,
  ) => Promise<void>;
  removeLabel: (
    projectRoot: string,
    label: string,
    snapshotId: string,
  ) => Promise<void>;
  loadStorageInfo: (projectRoot: string) => Promise<HistoryStorageInfo | null>;
  setStorageLimit: (
    projectRoot: string,
    limitBytes: number,
  ) => Promise<HistoryStorageInfo | null>;
  clearHistory: (projectRoot: string) => Promise<HistoryStorageInfo | null>;
  clearManagementError: () => void;
  startReview: (snapshot: SnapshotInfo) => void;
  stopReview: () => void;
  reset: () => void;
}

const PAGE_SIZE = 50;
const historyInitPromises = new Map<string, Promise<void>>();
let snapshotRequestGeneration = 0;
let labelRequestGeneration = 0;
let workspaceGeneration = 0;
let storageGeneration = 0;
let observingWorkspace = false;

function ownsWorkspace(projectRoot: string): () => boolean {
  // Install lazily: document-store also imports history-store.
  if (!observingWorkspace) {
    observingWorkspace = true;
    useDocumentStore.subscribe((state, previous) => {
      if (state.projectRoot !== previous.projectRoot)
        useHistoryStore.getState().reset();
    });
  }
  const generation = workspaceGeneration;
  return () =>
    generation === workspaceGeneration &&
    useDocumentStore.getState().projectRoot === projectRoot;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const create = createPanelStore("history");
export const useHistoryStore = create<HistoryState>()((set, get) => ({
  snapshots: [],
  labelCounts: {},
  isLoading: false,
  selectedSnapshotId: null,
  diffResult: null,
  isDiffLoading: false,
  isRestoring: false,
  reviewingSnapshot: null,
  storageInfo: null,
  isStorageInfoLoading: false,
  isHistoryClearing: false,
  managementError: null,

  startReview: (snapshot) => {
    set({ reviewingSnapshot: snapshot });
  },

  stopReview: () => {
    set({ reviewingSnapshot: null, diffResult: null });
  },

  init: async (projectRoot) => {
    const pendingInitialization = historyInitPromises.get(projectRoot);
    if (pendingInitialization) {
      await pendingInitialization;
      return;
    }
    log.debug(`Initializing history for ${projectRoot}`);
    const initialization = invoke<void>("history_init", { projectRoot });
    historyInitPromises.set(projectRoot, initialization);
    try {
      await initialization;
    } finally {
      if (historyInitPromises.get(projectRoot) === initialization) {
        historyInitPromises.delete(projectRoot);
      }
    }
  },

  createSnapshot: async (projectRoot, message) => {
    const owns = ownsWorkspace(projectRoot);
    const publish = !get().isHistoryClearing;
    log.debug(`Creating snapshot: ${message}`);
    await flushProjectCommentWrites(projectRoot);
    const result = await invoke<SnapshotInfo | null>("history_snapshot", {
      projectRoot,
      message,
    });
    if (result && publish && owns()) {
      log.info(`Snapshot created: ${result.id.slice(0, 8)}`);
      void get()
        .loadLabelCounts(projectRoot)
        .catch((error) =>
          log.warn("Could not refresh label suggestions", {
            error: String(error),
          }),
        );
      const reload = get().isLoading;
      snapshotRequestGeneration++;
      set((s) => ({
        isLoading: false,
        snapshots: [
          result,
          ...s.snapshots.filter((item) => item.id !== result.id),
        ],
      }));
      if (reload)
        void get()
          .loadSnapshots(projectRoot)
          .catch((error) =>
            log.error("Could not refresh history after saving", {
              error: String(error),
            }),
          );
    }
    return result;
  },

  loadLabelCounts: async (projectRoot) => {
    const owns = ownsWorkspace(projectRoot);
    const generation = ++labelRequestGeneration;
    const counts = await invoke<Record<string, number>>(
      "history_label_counts",
      { projectRoot },
    );
    if (owns() && generation === labelRequestGeneration)
      set({ labelCounts: counts ?? {} });
  },
  loadSnapshots: async (projectRoot) => {
    // Initialization from a previously open project can finish after a switch.
    const owns = ownsWorkspace(projectRoot);
    if (!owns() || get().isHistoryClearing) return;
    const generation = ++snapshotRequestGeneration;
    set({ isLoading: true });
    try {
      const snapshots = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        // Refresh every loaded entry so concurrent edits do not collapse pagination.
        limit: Math.max(PAGE_SIZE, get().snapshots.length),
        offset: 0,
      });
      if (generation === snapshotRequestGeneration && owns()) {
        set({ snapshots });
        void get()
          .loadLabelCounts(projectRoot)
          .catch((error) =>
            log.warn("Could not load label suggestions", {
              error: String(error),
            }),
          );
      }
    } finally {
      if (owns() && generation === snapshotRequestGeneration)
        set({ isLoading: false });
    }
  },

  loadMoreSnapshots: async (projectRoot) => {
    const owns = ownsWorkspace(projectRoot);
    if (!owns() || get().isHistoryClearing) return;
    const { snapshots, isLoading } = get();
    if (isLoading) return;
    const generation = ++snapshotRequestGeneration;
    set({ isLoading: true });
    try {
      const more = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset: snapshots.length,
      });
      if (
        generation === snapshotRequestGeneration &&
        owns() &&
        more.length > 0
      ) {
        set((s) => {
          const existingIds = new Set(
            s.snapshots.map((snapshot) => snapshot.id),
          );
          return {
            snapshots: [
              ...s.snapshots,
              ...more.filter((snapshot) => !existingIds.has(snapshot.id)),
            ],
          };
        });
      }
    } finally {
      if (owns() && generation === snapshotRequestGeneration)
        set({ isLoading: false });
    }
  },

  selectSnapshot: (id) => {
    set({ selectedSnapshotId: id, diffResult: null });
  },

  loadDiff: async (projectRoot, fromId, toId) => {
    set({ isDiffLoading: true, diffResult: null });
    try {
      const diffResult = await invoke<FileDiff[]>("history_diff", {
        projectRoot,
        fromId,
        toId,
      });
      set({ diffResult });
    } finally {
      set({ isDiffLoading: false });
    }
  },

  getFileAt: async (projectRoot, snapshotId, filePath) => {
    return invoke<string>("history_file_at", {
      projectRoot,
      snapshotId,
      filePath,
    });
  },

  restoreSnapshot: async (projectRoot, snapshotId) => {
    log.info(`Restoring snapshot: ${snapshotId.slice(0, 8)}`);
    const owns = ownsWorkspace(projectRoot);
    if (owns()) set({ isRestoring: true });
    let applied = false;
    try {
      const result = await restoreWithProjectComments(projectRoot, () =>
        useDocumentStore
          .getState()
          .runGitOperation(projectRoot, {}, async () => {
            const result = await invoke<SnapshotInfo>("history_restore", {
              projectRoot,
              snapshotId,
            });
            applied = true;
            return result;
          }),
      );
      log.info(`Restored snapshot, new snapshot: ${result.id.slice(0, 8)}`);
      if (owns()) await get().loadSnapshots(projectRoot);
      return result;
    } catch (error) {
      // Native restoration can succeed even if reloading the workspace fails.
      if (applied) notifyProjectCommentsRestored(projectRoot);
      throw error;
    } finally {
      if (owns()) set({ isRestoring: false });
    }
  },

  addLabel: async (projectRoot, snapshotId, label) => {
    label = label.trim();
    if (!label || label === "Agent" || label === "Comments")
      throw new Error(`${label} is reserved for automatic labels`);
    const owns = ownsWorkspace(projectRoot);
    const publish = !get().isHistoryClearing;

    await invoke("history_add_label", { projectRoot, snapshotId, label });
    if (!publish || !owns()) return;
    void get()
      .loadLabelCounts(projectRoot)
      .catch((error) =>
        log.warn("Could not refresh label suggestions", {
          error: String(error),
        }),
      );
    const reload = get().isLoading;
    snapshotRequestGeneration++;
    set((s) => ({
      isLoading: false,
      snapshots: s.snapshots.map((snap) =>
        snap.id === snapshotId
          ? { ...snap, labels: [...new Set([...snap.labels, label])] }
          : snap,
      ),
    }));
    if (reload)
      void get()
        .loadSnapshots(projectRoot)
        .catch((error) =>
          log.error("Could not refresh history after labeling", {
            error: String(error),
          }),
        );
  },

  removeLabel: async (projectRoot, label, snapshotId) => {
    const owns = ownsWorkspace(projectRoot);
    const publish = !get().isHistoryClearing;

    await invoke("history_remove_label", { projectRoot, snapshotId, label });
    if (!publish || !owns()) return;
    void get()
      .loadLabelCounts(projectRoot)
      .catch((error) =>
        log.warn("Could not refresh label suggestions", {
          error: String(error),
        }),
      );
    const reload = get().isLoading;
    snapshotRequestGeneration++;
    set((s) => ({
      isLoading: false,
      snapshots: s.snapshots.map((snap) => ({
        ...snap,
        labels:
          snap.id === snapshotId
            ? snap.labels.filter((l) => l !== label)
            : snap.labels,
      })),
    }));
    if (reload)
      void get()
        .loadSnapshots(projectRoot)
        .catch((error) =>
          log.error("Could not refresh history after labeling", {
            error: String(error),
          }),
        );
  },

  loadStorageInfo: async (projectRoot) => {
    const owns = ownsWorkspace(projectRoot);
    const publish = owns() && !get().isHistoryClearing;
    const generation = publish ? ++storageGeneration : storageGeneration;
    const current = () => publish && owns() && generation === storageGeneration;
    if (current()) set({ isStorageInfoLoading: true, managementError: null });
    try {
      const storageInfo = await invoke<HistoryStorageInfo>(
        "history_storage_info",
        { projectRoot },
      );
      if (current()) set({ storageInfo });
      return storageInfo;
    } catch (error) {
      if (current()) set({ managementError: errorMessage(error) });
      return null;
    } finally {
      if (current()) set({ isStorageInfoLoading: false });
    }
  },

  setStorageLimit: async (projectRoot, limitBytes) => {
    const owns = ownsWorkspace(projectRoot);
    const publish = owns() && !get().isHistoryClearing;
    const generation = publish ? ++storageGeneration : storageGeneration;
    const current = () => publish && owns() && generation === storageGeneration;
    if (current()) set({ isStorageInfoLoading: true, managementError: null });
    try {
      const storageInfo = await invoke<HistoryStorageInfo>(
        "history_set_storage_limit",
        { projectRoot, limitBytes },
      );
      if (current()) {
        set({ storageInfo });
        try {
          await get().loadSnapshots(projectRoot);
        } catch (error) {
          if (current())
            set({
              managementError: `Storage limit saved, but history could not be refreshed: ${errorMessage(error)}`,
            });
        }
      }
      return storageInfo;
    } catch (error) {
      if (current()) set({ managementError: errorMessage(error) });
      return null;
    } finally {
      if (current()) set({ isStorageInfoLoading: false });
    }
  },

  clearHistory: async (projectRoot) => {
    const active = ownsWorkspace(projectRoot)();
    if (active) {
      // Clearing replaces the history timeline; every older UI response is obsolete.
      workspaceGeneration++;
      snapshotRequestGeneration++;
      storageGeneration++;
      set({
        isHistoryClearing: true,
        isLoading: false,
        isRestoring: false,
        isDiffLoading: false,
        isStorageInfoLoading: false,
        managementError: null,
      });
    }
    const owns = ownsWorkspace(projectRoot);
    const clearingCurrent = () => active && owns();
    let cleared: HistoryStorageInfo | null = null;
    try {
      const storageInfo = await invoke<HistoryStorageInfo>("history_clear", {
        projectRoot,
      });
      cleared = storageInfo;
      if (!clearingCurrent()) return storageInfo;
      // The disk operation already succeeded, even if the baseline reload fails.
      set({
        storageInfo,
        snapshots: [],
        labelCounts: {},
        selectedSnapshotId: null,
        diffResult: null,
        reviewingSnapshot: null,
      });
      const snapshots = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (clearingCurrent())
        set({
          storageInfo,
          snapshots,
          selectedSnapshotId: null,
          diffResult: null,
          reviewingSnapshot: null,
        });
      return storageInfo;
    } catch (error) {
      if (clearingCurrent()) set({ managementError: errorMessage(error) });
      return cleared;
    } finally {
      if (clearingCurrent()) set({ isHistoryClearing: false });
    }
  },

  clearManagementError: () => set({ managementError: null }),

  reset: () => {
    workspaceGeneration++;
    snapshotRequestGeneration++;
    storageGeneration++;
    set({
      snapshots: [],
      labelCounts: {},
      isLoading: false,
      selectedSnapshotId: null,
      diffResult: null,
      isDiffLoading: false,
      isRestoring: false,
      reviewingSnapshot: null,
      storageInfo: null,
      isStorageInfoLoading: false,
      isHistoryClearing: false,
      managementError: null,
    });
  },
}));
