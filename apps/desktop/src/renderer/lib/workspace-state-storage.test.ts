import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.unmock("@/lib/desktop/core");
const bridge = { invoke: vi.fn(), listen: vi.fn() };
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), dismiss: vi.fn(), warning: vi.fn() },
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  bridge.invoke.mockReset();
  localStorage.clear();
  window.catalex = bridge as any;
});
afterEach(() => {
  delete window.catalex;
});
it("removes old browser data only after verified native migration, including unopened chats", async () => {
  const key = "catalex-project-chats:/unopened";
  localStorage.setItem(key, '{"tabs":[]}');
  bridge.invoke.mockResolvedValueOnce({ error: "disk full" });
  const { migrateBrowserWorkspaceState } = await import(
    "./workspace-state-storage"
  );
  await expect(migrateBrowserWorkspaceState()).rejects.toBe("disk full");
  expect(localStorage.getItem(key)).toBe('{"tabs":[]}');
  bridge.invoke.mockResolvedValue({ result: null });
  await migrateBrowserWorkspaceState();
  expect(localStorage.getItem(key)).toBeNull();
});
it("does not throw from UI updates on disk failure; flush blocks progress and retries the exact draft", async () => {
  bridge.invoke.mockImplementation(async (command) =>
    command.endsWith(":read")
      ? { result: { value: null, revision: null } }
      : { error: "disk full" },
  );
  const { workspaceStatePersistence, flushWorkspaceState } = await import(
    "./workspace-state-storage"
  );
  const storage = workspaceStatePersistence.storage!;
  const key = "catalex-proposed-changes";
  await storage.getItem(key);
  const snapshot = {
    state: { accepted: ["one"], rejected: ["two"], edited: "my text" },
    version: 1,
  };
  expect(() => storage.setItem(key, snapshot)).not.toThrow();
  await expect(flushWorkspaceState()).rejects.toThrow("disk full");
  bridge.invoke.mockResolvedValue({ result: "saved-revision" });
  await flushWorkspaceState();
  expect(bridge.invoke).toHaveBeenLastCalledWith(
    "desktop:workspace-state:write",
    {
      key,
      value: JSON.stringify(snapshot),
      revision: null,
      base: null,
    },
  );
});
it("coalesces changes while a disk write is pending and saves the newest draft", async () => {
  let release!: (value: unknown) => void;
  bridge.invoke.mockImplementation(async (command) =>
    command.endsWith(":read")
      ? { result: { value: null, revision: null } }
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  const { workspaceStatePersistence, flushWorkspaceState } = await import(
    "./workspace-state-storage"
  );
  const storage = workspaceStatePersistence.storage!;
  const key = "catalex-proposed-changes";
  await storage.getItem(key);
  storage.setItem(key, { state: { draft: "first" }, version: 1 });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  for (let edit = 0; edit < 100; edit++)
    storage.setItem(key, { state: { draft: `edit-${edit}` }, version: 1 });
  bridge.invoke.mockResolvedValue({ result: "final-revision" });
  release({ result: "first-revision" });
  await flushWorkspaceState();
  const saves = bridge.invoke.mock.calls.filter(([command]) =>
    command.endsWith(":write"),
  );
  expect(saves).toHaveLength(2);
  expect(JSON.parse(saves[1][1].value).state.draft).toBe("edit-99");
});

it("retires a conflicting browser copy only after backup acknowledgement and shows a notice", async () => {
  const key = "catalex-project-chats:/conflict";
  localStorage.setItem(key, '{"tabs":[1]}');
  bridge.invoke.mockResolvedValue({
    result: { backupPath: "/recovery/conflict.json" },
  });
  const { migrateBrowserWorkspaceState, showWorkspaceMigrationNotice } =
    await import("./workspace-state-storage");
  const { toast } = await import("sonner");
  const backups = await migrateBrowserWorkspaceState();
  showWorkspaceMigrationNotice(backups);
  expect(localStorage.getItem(key)).toBeNull();
  expect(toast.warning).toHaveBeenCalledWith(
    expect.stringContaining("backed up"),
    expect.objectContaining({
      description: expect.stringContaining("/recovery/conflict.json"),
    }),
  );
});
