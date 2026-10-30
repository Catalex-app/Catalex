import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";

function snapshot(id: string): SnapshotInfo {
  return { id, message: id, timestamp: 123, labels: [], changed_files: [] };
}

function pendingPage() {
  let resolve!: (snapshots: SnapshotInfo[]) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<SnapshotInfo[]>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useHistoryStore", () => {
  const initialProjectRoot = useDocumentStore.getState().projectRoot;
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useHistoryStore.getState().reset();
    useDocumentStore.setState({ projectRoot: "/papers/review" });
  });
  afterEach(() =>
    useDocumentStore.setState({ projectRoot: initialProjectRoot }),
  );

  it("keeps newer refresh results when an earlier response arrives last", async () => {
    const oldPage = pendingPage();
    const newPage = pendingPage();
    vi.mocked(invoke)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const first = useHistoryStore.getState().loadSnapshots("/papers/review");
    const second = useHistoryStore.getState().loadSnapshots("/papers/review");
    newPage.resolve([snapshot("new")]);
    await second;
    oldPage.resolve([snapshot("old")]);
    await first;
    expect(useHistoryStore.getState().snapshots).toEqual([snapshot("new")]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("does not clear the loading flag when an obsolete request fails", async () => {
    const oldPage = pendingPage();
    const newPage = pendingPage();
    vi.mocked(invoke)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const first = useHistoryStore.getState().loadSnapshots("/papers/review");
    const second = useHistoryStore.getState().loadSnapshots("/papers/review");
    const rejected = expect(first).rejects.toThrow("Old request failed");
    oldPage.reject(new Error("Old request failed"));
    await rejected;
    expect(useHistoryStore.getState().isLoading).toBe(true);
    newPage.resolve([snapshot("new")]);
    await second;
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("discards an old project's response while the new project is loading", async () => {
    const oldPage = pendingPage();
    const newPage = pendingPage();
    vi.mocked(invoke)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const first = useHistoryStore.getState().loadSnapshots("/papers/review");
    useDocumentStore.setState({ projectRoot: "/papers/other" });
    const second = useHistoryStore.getState().loadSnapshots("/papers/other");
    oldPage.resolve([snapshot("wrong-project")]);
    await first;
    expect(useHistoryStore.getState().snapshots).toEqual([]);
    expect(useHistoryStore.getState().isLoading).toBe(true);
    newPage.resolve([snapshot("other-project")]);
    await second;
    expect(useHistoryStore.getState().snapshots).toEqual([
      snapshot("other-project"),
    ]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("does not start stale requests after project initialization finishes late", async () => {
    useDocumentStore.setState({ projectRoot: "/papers/other" });
    await useHistoryStore.getState().loadSnapshots("/papers/review");
    await useHistoryStore.getState().loadMoreSnapshots("/papers/review");
    expect(invoke).not.toHaveBeenCalled();
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("drops a response when the project changes without starting another request", async () => {
    const page = pendingPage();
    vi.mocked(invoke).mockReturnValueOnce(page.promise);
    const loading = useHistoryStore.getState().loadSnapshots("/papers/review");
    useDocumentStore.setState({ projectRoot: "/papers/other" });
    page.resolve([snapshot("wrong-project")]);
    await loading;
    expect(useHistoryStore.getState().snapshots).toEqual([]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("invalidates pending pagination on reset, including reopening the same project", async () => {
    const oldPage = pendingPage();
    const newPage = pendingPage();
    useHistoryStore.setState({ snapshots: [snapshot("head")] });
    vi.mocked(invoke)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const first = useHistoryStore
      .getState()
      .loadMoreSnapshots("/papers/review");
    expect(invoke).toHaveBeenLastCalledWith("history_list", {
      projectRoot: "/papers/review",
      limit: 50,
      offset: 1,
    });
    useHistoryStore.getState().reset();
    const second = useHistoryStore.getState().loadSnapshots("/papers/review");
    oldPage.resolve([snapshot("old-tail")]);
    await first;
    expect(useHistoryStore.getState().snapshots).toEqual([]);
    expect(useHistoryStore.getState().isLoading).toBe(true);
    newPage.resolve([snapshot("fresh-head")]);
    await second;
    expect(useHistoryStore.getState().snapshots).toEqual([
      snapshot("fresh-head"),
    ]);
  });

  it("discards pending older pages when a full refresh takes over", async () => {
    const oldPage = pendingPage();
    const newPage = pendingPage();
    useHistoryStore.setState({ snapshots: [snapshot("head")] });
    vi.mocked(invoke)
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const first = useHistoryStore
      .getState()
      .loadMoreSnapshots("/papers/review");
    const second = useHistoryStore.getState().loadSnapshots("/papers/review");
    newPage.resolve([snapshot("fresh-head")]);
    await second;
    oldPage.resolve([snapshot("old-tail")]);
    await first;
    expect(useHistoryStore.getState().snapshots).toEqual([
      snapshot("fresh-head"),
    ]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("deduplicates an older page if autosaving shifts the history offset", async () => {
    const page = pendingPage();
    useHistoryStore.setState({ snapshots: [snapshot("head")] });
    vi.mocked(invoke).mockReturnValueOnce(page.promise);
    const loading = useHistoryStore
      .getState()
      .loadMoreSnapshots("/papers/review");
    useHistoryStore.setState({
      snapshots: [snapshot("new-save"), snapshot("head")],
    });
    page.resolve([snapshot("head"), snapshot("older")]);
    await loading;
    expect(useHistoryStore.getState().snapshots.map((item) => item.id)).toEqual(
      ["new-save", "head", "older"],
    );
  });

  it("shares concurrent history initialization for the same project", async () => {
    let finishInitialization: (() => void) | undefined;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishInitialization = resolve;
      }),
    );

    const first = useHistoryStore.getState().init("/papers/review");
    const second = useHistoryStore.getState().init("/papers/review");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("history_init", {
      projectRoot: "/papers/review",
    });

    finishInitialization?.();
    await Promise.all([first, second]);

    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await useHistoryStore.getState().init("/papers/review");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("loads per-project automatic history storage information", async () => {
    const storageInfo = {
      usageBytes: 42 * 1024 * 1024,
      limitBytes: 250 * 1024 * 1024,
      snapshotCount: 12,
      protectedSnapshotCount: 2,
    };
    vi.mocked(invoke).mockResolvedValueOnce(storageInfo);

    await expect(
      useHistoryStore.getState().loadStorageInfo("/papers/review"),
    ).resolves.toEqual(storageInfo);

    expect(invoke).toHaveBeenCalledWith("history_storage_info", {
      projectRoot: "/papers/review",
    });
    expect(useHistoryStore.getState().storageInfo).toEqual(storageInfo);
    expect(useHistoryStore.getState().managementError).toBeNull();
  });

  it("reloads checkpoints and label counts after storage-limit cleanup", async () => {
    useHistoryStore.setState({
      snapshots: [snapshot("old"), snapshot("kept")],
    });
    const storageInfo = {
      usageBytes: 80,
      limitBytes: 100,
      snapshotCount: 1,
      protectedSnapshotCount: 0,
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "history_set_storage_limit") return storageInfo;
      if (command === "history_list") return [snapshot("kept")];
      if (command === "history_label_counts") return {};
    });
    await useHistoryStore.getState().setStorageLimit("/papers/review", 100);
    expect(useHistoryStore.getState().snapshots).toEqual([snapshot("kept")]);
    expect(useHistoryStore.getState().storageInfo).toEqual(storageInfo);
    expect(invoke).toHaveBeenCalledWith("history_label_counts", {
      projectRoot: "/papers/review",
    });
  });

  it("keeps the saved limit and reports a failed timeline refresh", async () => {
    const storageInfo = {
      usageBytes: 80,
      limitBytes: 100,
      snapshotCount: 1,
      protectedSnapshotCount: 0,
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "history_set_storage_limit") return storageInfo;
      throw new Error("Read failed");
    });
    await expect(
      useHistoryStore.getState().setStorageLimit("/papers/review", 100),
    ).resolves.toEqual(storageInfo);
    expect(useHistoryStore.getState().storageInfo).toEqual(storageInfo);
    expect(useHistoryStore.getState().managementError).toContain(
      "Storage limit saved, but history could not be refreshed",
    );
  });

  it("persists a project storage limit and surfaces failures without throwing", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("Settings directory is read-only");

    await expect(
      useHistoryStore
        .getState()
        .setStorageLimit("/papers/review", 500 * 1024 * 1024),
    ).resolves.toBeNull();

    expect(invoke).toHaveBeenCalledWith("history_set_storage_limit", {
      projectRoot: "/papers/review",
      limitBytes: 500 * 1024 * 1024,
    });
    expect(useHistoryStore.getState().managementError).toBe(
      "Settings directory is read-only",
    );
    expect(useHistoryStore.getState().isStorageInfoLoading).toBe(false);
  });

  it("clears history, reloads its fresh baseline, and leaves review mode", async () => {
    const storageInfo = {
      usageBytes: 8192,
      limitBytes: 250 * 1024 * 1024,
      snapshotCount: 1,
      protectedSnapshotCount: 0,
    };
    const freshSnapshot = {
      id: "fresh",
      message: "[init] Project opened",
      timestamp: 123,
      labels: [],
      changed_files: [],
    };
    useHistoryStore.setState({
      snapshots: [
        {
          ...freshSnapshot,
          id: "old",
          labels: ["milestone"],
        },
      ],
      reviewingSnapshot: { ...freshSnapshot, id: "old" },
    });
    vi.mocked(invoke)
      .mockResolvedValueOnce(storageInfo)
      .mockResolvedValueOnce([freshSnapshot]);

    await expect(
      useHistoryStore.getState().clearHistory("/papers/review"),
    ).resolves.toEqual(storageInfo);

    expect(invoke).toHaveBeenNthCalledWith(1, "history_clear", {
      projectRoot: "/papers/review",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "history_list", {
      projectRoot: "/papers/review",
      limit: 50,
      offset: 0,
    });
    expect(useHistoryStore.getState().snapshots).toEqual([freshSnapshot]);
    expect(useHistoryStore.getState().reviewingSnapshot).toBeNull();
    expect(useHistoryStore.getState().storageInfo).toEqual(storageInfo);
  });

  it("does not reintroduce a pre-clear page after history has been cleared", async () => {
    const page = pendingPage();
    const storageInfo = {
      usageBytes: 8192,
      limitBytes: 250 * 1024 * 1024,
      snapshotCount: 1,
      protectedSnapshotCount: 0,
    };
    vi.mocked(invoke)
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(storageInfo)
      .mockResolvedValueOnce([snapshot("fresh")]);
    const loading = useHistoryStore.getState().loadSnapshots("/papers/review");
    await useHistoryStore.getState().clearHistory("/papers/review");
    page.resolve([snapshot("removed")]);
    await loading;
    expect(useHistoryStore.getState().snapshots).toEqual([snapshot("fresh")]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const root = "/papers/review";
const storage = {
  usageBytes: 1,
  limitBytes: 100,
  snapshotCount: 1,
  protectedSnapshotCount: 0,
};

describe("history request ownership", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useDocumentStore.setState({ projectRoot: root });
    useHistoryStore.getState().reset();
  });

  it.each([
    "snapshot",
    "add",
    "remove",
    "storage",
    "limit",
    "clear",
  ])("preserves %s caller results without publishing after reopening", async (kind) => {
    const request = deferred<unknown>();
    vi.mocked(invoke).mockReturnValue(request.promise);
    useHistoryStore.setState({ snapshots: [snapshot("base")] });
    const state = useHistoryStore.getState();
    const operation =
      kind === "snapshot"
        ? state.createSnapshot(root, "test")
        : kind === "add"
          ? state.addLabel(root, "base", "tag")
          : kind === "remove"
            ? state.removeLabel(root, "tag", "snapshot")
            : kind === "storage"
              ? state.loadStorageInfo(root)
              : kind === "limit"
                ? state.setStorageLimit(root, 100)
                : state.clearHistory(root);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    useDocumentStore.setState({ projectRoot: "/other" });
    useDocumentStore.setState({ projectRoot: root });
    const fresh = { ...snapshot("base"), labels: ["tag"] };
    useHistoryStore.setState({ snapshots: [fresh] });
    const value = kind === "snapshot" ? snapshot("old") : storage;
    request.resolve(value);
    const result = await operation;
    if (["snapshot", "storage", "limit", "clear"].includes(kind))
      expect(result).toEqual(value);
    expect(useHistoryStore.getState().snapshots).toEqual([fresh]);
    expect(useHistoryStore.getState().storageInfo).toBeNull();
    expect(useHistoryStore.getState().isHistoryClearing).toBe(false);
  });

  it("ignores an older storage failure while a newer request is loading", async () => {
    const old = deferred<unknown>();
    const fresh = deferred<unknown>();
    vi.mocked(invoke)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValueOnce([]);
    const a = useHistoryStore.getState().loadStorageInfo(root);
    const b = useHistoryStore.getState().setStorageLimit(root, 100);
    old.reject(new Error("obsolete"));
    expect(await a).toBeNull();
    expect(useHistoryStore.getState().managementError).toBeNull();
    expect(useHistoryStore.getState().isStorageInfoLoading).toBe(true);
    fresh.resolve(storage);
    expect(await b).toEqual(storage);
    expect(useHistoryStore.getState().storageInfo).toEqual(storage);
  });

  it("a pre-clear snapshot completion cannot repopulate cleared history", async () => {
    const old = deferred<SnapshotInfo>();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "history_snapshot") return old.promise;
      if (command === "history_clear") return storage;
      if (command === "history_list") return [snapshot("fresh")];
    });
    const creation = useHistoryStore.getState().createSnapshot(root, "old");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "history_snapshot",
        expect.anything(),
      ),
    );
    await useHistoryStore.getState().clearHistory(root);
    old.resolve(snapshot("old"));
    expect(await creation).toEqual(snapshot("old"));
    expect(useHistoryStore.getState().snapshots).toEqual([snapshot("fresh")]);
  });

  it("returns an old storage result without replacing the newer value", async () => {
    const old = deferred<unknown>();
    vi.mocked(invoke)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(storage)
      .mockResolvedValueOnce([]);
    const loading = useHistoryStore.getState().loadStorageInfo(root);
    await useHistoryStore.getState().setStorageLimit(root, storage.limitBytes);
    const previous = { ...storage, limitBytes: 50 };
    old.resolve(previous);
    expect(await loading).toEqual(previous);
    expect(useHistoryStore.getState().storageInfo).toEqual(storage);
  });

  it("reset prevents a late clear failure from changing current errors or flags", async () => {
    const request = deferred<unknown>();
    vi.mocked(invoke).mockReturnValueOnce(request.promise);
    const clearing = useHistoryStore.getState().clearHistory(root);
    useHistoryStore.getState().reset();
    useHistoryStore.setState({
      managementError: "Current error",
      isHistoryClearing: true,
    });
    request.reject(new Error("Old failure"));
    expect(await clearing).toBeNull();
    expect(useHistoryStore.getState().managementError).toBe("Current error");
    expect(useHistoryStore.getState().isHistoryClearing).toBe(true);
  });

  it("reloads a list interrupted by snapshot creation instead of losing older entries", async () => {
    const oldPage = deferred<SnapshotInfo[]>();
    let lists = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "history_list") {
        if (++lists === 1) return oldPage.promise;
        return [snapshot("new"), snapshot("older")];
      }
      if (command === "history_snapshot") return snapshot("new");
    });
    const loading = useHistoryStore.getState().loadSnapshots(root);
    await useHistoryStore.getState().createSnapshot(root, "new");
    oldPage.resolve([snapshot("older")]);
    await loading;
    await vi.waitFor(() =>
      expect(useHistoryStore.getState().snapshots.map((s) => s.id)).toEqual([
        "new",
        "older",
      ]),
    );
  });

  it("keeps a successful clear visible even if reloading its baseline fails", async () => {
    useHistoryStore.setState({ snapshots: [snapshot("deleted")] });
    vi.mocked(invoke)
      .mockResolvedValueOnce(storage)
      .mockRejectedValueOnce(new Error("Reload failed"));
    expect(await useHistoryStore.getState().clearHistory(root)).toEqual(
      storage,
    );
    expect(useHistoryStore.getState().snapshots).toEqual([]);
    expect(useHistoryStore.getState().storageInfo).toEqual(storage);
    expect(useHistoryStore.getState().managementError).toBe("Reload failed");
    expect(useHistoryStore.getState().isHistoryClearing).toBe(false);
  });

  it("an older list cannot overwrite a successful label update", async () => {
    const page = deferred<SnapshotInfo[]>();
    vi.mocked(invoke)
      .mockReturnValueOnce(page.promise)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ tag: 1 })
      .mockResolvedValueOnce([{ ...snapshot("base"), labels: ["tag"] }]);
    useHistoryStore.setState({ snapshots: [snapshot("base")] });
    const loading = useHistoryStore.getState().loadSnapshots(root);
    await useHistoryStore.getState().addLabel(root, "base", "tag");
    page.resolve([snapshot("base")]);
    await loading;
    expect(useHistoryStore.getState().snapshots[0].labels).toEqual(["tag"]);
  });

  it("preserves the loaded history range when labeling interrupts a refresh", async () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      snapshot(`item-${i}`),
    );
    const oldPage = deferred<SnapshotInfo[]>();
    let lists = 0;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command !== "history_list") return;
      if (++lists === 1) return oldPage.promise;
      const limit = (args as { limit: number }).limit;
      return entries
        .slice(0, limit)
        .map((item) =>
          item.id === "item-99" ? { ...item, labels: ["tag"] } : item,
        );
    });
    useHistoryStore.setState({ snapshots: entries });
    const loading = useHistoryStore.getState().loadSnapshots(root);
    await useHistoryStore.getState().addLabel(root, "item-99", "tag");
    oldPage.resolve(entries);
    await loading;
    await vi.waitFor(() => {
      expect(useHistoryStore.getState().snapshots).toHaveLength(100);
      expect(useHistoryStore.getState().snapshots[99].labels).toEqual(["tag"]);
    });
  });
});
