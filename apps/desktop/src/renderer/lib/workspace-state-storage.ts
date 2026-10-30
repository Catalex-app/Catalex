import { createJSONStorage, type StateStorage } from "zustand/middleware";
import { toast } from "sonner";
import { invoke } from "./desktop/core";

export const workspaceStateKeys = [
  "catalex-agent-review-queue",
  "catalex-proposed-changes",
  "catalex-paused-review",
];
const native = () => !!window.catalex;
const revisions = new Map<string, string | null>();
const bases = new Map<string, string | null>();
const pending = new Map<string, string>();
const failures = new Map<string, unknown>();
const scheduled = new Set<string>();
let writes = Promise.resolve();

function schedule(key: string, value: string) {
  if (!pending.has(key) && bases.get(key) === value) return;
  pending.set(key, value);
  if (scheduled.has(key)) return;
  scheduled.add(key);
  writes = writes.then(async () => {
    // Keep only the latest waiting snapshot, not one large string per keystroke.
    const value = pending.get(key)!;
    try {
      if (!revisions.has(key))
        throw new Error("Draft recovery storage is not ready.");
      const next = await invoke<string>("desktop:workspace-state:write", {
        key,
        value,
        revision: revisions.get(key),
        base: bases.get(key),
      });
      revisions.set(key, next);
      bases.set(key, value);
      failures.delete(key);
      if (pending.get(key) === value) {
        pending.delete(key);
        // Read back any independent records merged from another project window.
        window.dispatchEvent(
          new CustomEvent("workspace-state-saved", { detail: key }),
        );
      }
      if (!failures.size) toast.dismiss("workspace-save-failed");
    } catch (error) {
      failures.set(key, error);
      toast.error(
        "Could not save draft recovery data. Keep this window open and retry saving.",
        {
          id: "workspace-save-failed",
          duration: Infinity,
          action: {
            label: "Retry",
            onClick: () => {
              void flushWorkspaceState().catch(() => {});
            },
          },
        },
      );
    } finally {
      scheduled.delete(key);
      const latest = pending.get(key);
      if (latest !== undefined && latest !== value) schedule(key, latest);
    }
  });
}

/** Await before applying a draft or leaving: failed saves must not authorize progress. */
export async function flushWorkspaceState() {
  if (!native()) return;
  await writes;
  for (const [key, value] of pending) schedule(key, value);
  while (true) {
    const current = writes;
    await current;
    if (current === writes) break;
  }
  if (failures.size)
    throw new Error(
      `Draft recovery data is not saved. ${String(failures.values().next().value)}`,
    );
}

const storage: StateStorage = {
  getItem: async (key) => {
    if (!native()) return localStorage.getItem(key);
    // Never replace unacknowledged edits with another window's snapshot.
    if (pending.has(key)) return pending.get(key)!;
    const revisionBeforeRead = revisions.get(key);
    const result = await invoke<{
      value: string | null;
      revision: string | null;
    }>("desktop:workspace-state:read", { key });
    if (pending.has(key)) return pending.get(key)!;
    if (revisions.get(key) !== revisionBeforeRead)
      return bases.get(key) ?? null;
    revisions.set(key, result.revision);
    bases.set(key, result.value);
    return result.value;
  },
  setItem: (key, value) => {
    if (native()) schedule(key, value);
    else localStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    if (!native()) {
      localStorage.removeItem(key);
      return;
    }
    await flushWorkspaceState();
    await invoke("desktop:workspace-state:remove", { key });
    revisions.set(key, null);
    bases.set(key, null);
  },
};

export const workspaceStatePersistence = {
  storage: createJSONStorage(() => (native() ? storage : localStorage)),
  skipHydration: native(),
};

/** Evacuate old heavy values one at a time, without opening projects or agents. */
export async function migrateBrowserWorkspaceState() {
  if (!native()) return [];
  const backups: string[] = [];
  const keys = Array.from({ length: localStorage.length }, (_, index) =>
    localStorage.key(index),
  )
    .filter((key): key is string => key !== null)
    .filter(
      (key) =>
        workspaceStateKeys.includes(key) ||
        key.startsWith("catalex-project-chats:"),
    );
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value === null) continue;
    const result = await invoke<{ backupPath: string } | null>(
      "desktop:workspace-state:migrate",
      { key, value },
    );
    if (result?.backupPath) backups.push(result.backupPath);
    const remaining = localStorage.getItem(key);
    if (remaining !== null && remaining !== value)
      throw new Error(
        "Browser recovery data changed while being preserved. Retry opening this window.",
      );
    localStorage.removeItem(key);
  }
  return backups;
}

export function showWorkspaceMigrationNotice(backups: string[]) {
  if (!backups.length) return;
  toast.warning(
    "Conflicting browser recovery data was backed up. The app is using the saved disk version.",
    {
      id: "workspace-migration-conflict",
      duration: Infinity,
      description: `Both copies are preserved in ${backups.join(", ")}`,
    },
  );
}

export async function readLegacyProjectChats(key: string) {
  const browserCopy = localStorage.getItem(key);
  if (browserCopy !== null || !native()) return browserCopy;
  return (
    await invoke<{ value: string | null }>("desktop:workspace-state:read", {
      key,
    })
  ).value;
}
export async function removeLegacyProjectChats(key: string) {
  if (native()) await invoke("desktop:workspace-state:remove", { key });
  localStorage.removeItem(key);
}
