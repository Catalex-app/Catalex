import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const reviewKeys = new Set([
  "catalex-agent-review-queue",
  "catalex-proposed-changes",
  "catalex-paused-review",
]);
const revision = (value: string | null) =>
  value === null ? null : createHash("sha256").update(value).digest("hex");

// Merge only independent records, never the contents of a draft or its decisions.
// This keeps two project windows from replacing each other's global store snapshot.
function mergeIndependentRecords(
  key: string,
  base: string | null,
  next: string,
  current: string | null,
) {
  const before = base === null ? { state: {} } : JSON.parse(base);
  const incoming = JSON.parse(next);
  const saved =
    current === null ? { ...incoming, state: {} } : JSON.parse(current);
  if (
    !incoming.state ||
    !saved.state ||
    (base !== null && before.version !== incoming.version) ||
    saved.version !== incoming.version
  )
    throw new Error("Incompatible recovery snapshots.");
  const fields =
    key === "catalex-agent-review-queue"
      ? ["entries"]
      : key === "catalex-proposed-changes"
        ? ["changesByProject", "workspaceReviewsByProject"]
        : key === "catalex-paused-review"
          ? ["pending", "backups"]
          : [];
  if (!fields.length) throw new Error("Unsupported recovery merge.");
  const result = { ...saved, state: { ...saved.state } };
  for (const field of fields) {
    const records = (state: any): Record<string, unknown> => {
      if (field !== "entries") return state?.[field] ?? {};
      const entries = state?.entries ?? [];
      const mapped: Record<string, unknown> = Object.create(null);
      for (const entry of entries) {
        const id = entry.session?.sessionId;
        if (typeof id !== "string" || Object.hasOwn(mapped, id))
          throw new Error("Invalid recovery session.");
        mapped[id] = entry;
      }
      return mapped;
    };
    const oldRecords = records(before.state);
    const newRecords = records(incoming.state);
    const currentRecords = records(saved.state);
    const merged = { ...currentRecords };
    for (const id of new Set([
      ...Object.keys(oldRecords),
      ...Object.keys(newRecords),
    ])) {
      const previous = JSON.stringify(oldRecords[id]);
      const changed = JSON.stringify(newRecords[id]);
      if (previous === changed) continue;
      const existing = JSON.stringify(currentRecords[id]);
      if (existing !== previous && existing !== changed)
        throw new Error("Conflicting recovery record.");
      if (changed === undefined) delete merged[id];
      else
        Object.defineProperty(merged, id, {
          value: newRecords[id],
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    result.state[field] = field === "entries" ? Object.values(merged) : merged;
  }
  return JSON.stringify(result);
}

/** Large recovery state belongs outside Chromium's small localStorage quota. */
export class WorkspaceStateStorage {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string) {}

  private file(key: string) {
    if (!reviewKeys.has(key) && !key.startsWith("catalex-project-chats:"))
      throw new Error("Unsupported workspace state key.");
    return path.join(this.directory, `${revision(key)}.json`);
  }

  private async readFile(key: string) {
    try {
      return await fs.readFile(this.file(key), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }

  async read(key: string) {
    const value = await this.readFile(key);
    return { value, revision: revision(value) };
  }

  async write(
    key: string,
    value: string,
    expected: string | null,
    base?: string | null,
  ) {
    if (typeof value !== "string") throw new Error("Invalid recovery data.");
    JSON.parse(value); // Never replace a valid save with malformed JSON.
    const current = await this.readFile(key);
    if (
      current !== value &&
      (revision(current) !== expected ||
        (base !== undefined && base !== current))
    ) {
      try {
        if (base === undefined) throw new Error("Missing recovery base.");
        value = mergeIndependentRecords(key, base, value, current);
      } catch {
        throw new Error(
          "Draft recovery data changed in another window. Your unsaved draft remains in this window; do not close it.",
        );
      }
    }
    if (current === value) return revision(value);
    await this.writeAtomic(this.file(key), value);
    return revision(value);
  }

  private async writeAtomic(target: string, value: string) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async migrate(key: string, value: string) {
    // Retry safely if the app stopped after writing but before deleting browser data.
    const saved = await this.read(key);
    if (saved.value !== null && saved.value !== value) {
      // Disk is the active store. Preserve both exact versions before retiring
      // a browser copy; a stale browser origin must not prevent app startup.
      const backup = JSON.stringify({
        key,
        browserValue: value,
        diskValue: saved.value,
      });
      const backupPath = path.join(
        this.directory,
        "migration-conflicts",
        `${revision(backup)}.json`,
      );
      await this.writeAtomic(backupPath, backup);
      if ((await fs.readFile(backupPath, "utf8")) !== backup)
        throw new Error("Could not verify conflicting recovery backup.");
      return { backupPath };
    }
    await this.write(key, value, saved.revision);
    if ((await this.readFile(key)) !== value)
      throw new Error("Could not verify migrated recovery data.");
  }

  async clearProjects(paths: string[]) {
    const normalize = (value: string) =>
      value.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
    const roots = new Set(paths.map(normalize));
    const matches = (value: string) =>
      typeof value === "string" && roots.has(normalize(value));
    for (const key of reviewKeys) {
      const saved = await this.read(key);
      if (saved.value === null) continue;
      const envelope = JSON.parse(saved.value);
      const state = envelope.state;
      if (key === "catalex-agent-review-queue") {
        state.entries = (state.entries ?? []).filter(
          (entry: any) => !matches(entry.session?.projectRoot),
        );
      } else if (key === "catalex-proposed-changes") {
        for (const field of ["changesByProject", "workspaceReviewsByProject"])
          for (const root of Object.keys(state[field] ?? {}))
            if (matches(root)) delete state[field][root];
      } else {
        for (const [tab, pending] of Object.entries(state.pending ?? {}))
          if (matches((pending as any)?.session?.projectRoot))
            delete state.pending[tab];
        for (const [tab, backups] of Object.entries(state.backups ?? {})) {
          state.backups[tab] = (backups as any[]).filter(
            (entry) => !matches(entry.projectRoot),
          );
          if (!state.backups[tab].length) delete state.backups[tab];
        }
      }
      await this.write(key, JSON.stringify(envelope), saved.revision);
    }
    for (const root of paths)
      await this.remove(`catalex-project-chats:${root}`);
  }

  async remove(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
}
