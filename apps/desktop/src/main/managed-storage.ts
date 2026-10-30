import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProjectOwnership } from "./project-ownership";

const PROJECT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const CACHE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_IDLE_MS = 30 * CACHE_CLEANUP_INTERVAL_MS;
const DEFAULT_LIMIT = 250 * 1024 * 1024;
export type StorageAction = "cache" | "history" | "agent" | "all";

export interface StoredProject {
  id: string;
  name: string;
  paths: string[];
  sourceAvailable: boolean;
  isOpen: boolean;
  isRecent: boolean;
  historyBytes: number;
  agentBytes: number;
  otherBytes: number;
  cacheBytes: number;
  totalBytes: number;
  historyLimitBytes: number;
  dataPath: string;
  cachePath: string;
}
export interface StorageInventory {
  projects: StoredProject[];
  totalBytes: number;
  sharedBytes: number;
  profileBytes: number;
  browserCacheBytes: number;
  dataPath: string;
  cachePath: string;
  profilePath: string;
}

async function stat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
interface StorageMetadata {
  version?: number;
  projects?: Array<{ id: string; paths: string[] }>;
  currentPath?: string;
  storageLimitBytes?: number;
  lastCleanupAt?: number;
}
async function readJson(file: string): Promise<StorageMetadata | null> {
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Invalid storage metadata: ${file}`);
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Invalid storage metadata: ${file}`);
  return parsed as StorageMetadata;
}
async function size(file: string, excluded: string[] = []): Promise<number> {
  if (excluded.includes(file)) return 0;
  const info = await stat(file);
  if (!info || info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let entries: string[];
  try {
    entries = await fs.readdir(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  // Bound filesystem concurrency by walking each directory sequentially.
  let total = 0;
  for (const entry of entries)
    total += await size(path.join(file, entry), excluded);
  return total;
}

// Agent worktrees share this repository's objects. Category cleanup must not
// remove one half of that relationship; the backend owns worktree disposal.
async function hasPrivateAgentStorage(historyPath: string): Promise<boolean> {
  for (const gitDir of [path.join(historyPath, ".git"), historyPath]) {
    for (const relative of ["refs/catalex/agents", "worktrees"]) {
      const directory = path.join(gitDir, relative);
      const info = await stat(directory);
      if (info?.isSymbolicLink()) return true;
      if (info?.isDirectory() && (await fs.readdir(directory)).length > 0)
        return true;
    }
    const heads = path.join(gitDir, "refs/heads");
    const headsInfo = await stat(heads);
    if (headsInfo?.isSymbolicLink()) return true;
    if (
      headsInfo?.isDirectory() &&
      (await fs.readdir(heads)).some((name) =>
        name.startsWith("catalex-agent-"),
      )
    )
      return true;
    const packedRefs = path.join(gitDir, "packed-refs");
    const packedInfo = await stat(packedRefs);
    if (packedInfo?.isSymbolicLink()) return true;
    if (
      packedInfo?.isFile() &&
      /^[0-9a-f]+ refs\/(?:catalex\/agents\/|heads\/catalex-agent-)/m.test(
        await fs.readFile(packedRefs, "utf8"),
      )
    )
      return true;
  }
  return false;
}

async function newestModification(file: string): Promise<number> {
  const info = await stat(file);
  if (!info || info.isSymbolicLink()) return 0;
  let newest = info.mtimeMs;
  if (info.isDirectory()) {
    for (const child of await fs.readdir(file))
      newest = Math.max(
        newest,
        await newestModification(path.join(file, child)),
      );
  }
  return newest;
}

/** App-owned storage only. Never derives a deletion target from a source path. */
export class ManagedStorage {
  private cleaningCache = false;
  constructor(
    readonly dataPath: string,
    readonly cachePath: string,
    readonly profilePath: string,
    private ownership: ProjectOwnership,
  ) {}

  private async projectDirectory(root: string, id: string) {
    if (!PROJECT_ID.test(id))
      throw new Error("Invalid stored project identifier.");
    for (const target of [
      root,
      path.join(root, "projects"),
      path.join(root, "projects", id),
    ]) {
      const info = await stat(target);
      if (info && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error("Project storage must be a real directory.");
    }
    return path.join(root, "projects", id);
  }

  async list(recentPaths: string[] = []): Promise<StorageInventory> {
    if (
      !Array.isArray(recentPaths) ||
      !recentPaths.every(
        (item) => typeof item === "string" && path.isAbsolute(item),
      )
    )
      throw new Error("Invalid recent project paths.");
    const recent = new Set(
      await Promise.all(
        recentPaths.map((source) =>
          fs.realpath(source).catch(() => path.resolve(source)),
        ),
      ),
    );

    const registry = await readJson(
      path.join(this.dataPath, "project-registry.json"),
    );
    if (
      registry &&
      (registry.version !== 1 || !Array.isArray(registry.projects))
    )
      throw new Error("Unsupported project storage registry.");
    const entries = new Map<string, string[]>();
    for (const entry of registry?.projects ?? []) {
      if (
        !PROJECT_ID.test(entry.id) ||
        !Array.isArray(entry.paths) ||
        !entry.paths.every(
          (item: unknown) => typeof item === "string" && path.isAbsolute(item),
        )
      )
        throw new Error("Invalid project storage registry.");
      entries.set(entry.id, entry.paths);
    }
    for (const root of [this.dataPath, this.cachePath]) {
      const parent = path.join(root, "projects");
      const info = await stat(parent);
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Project storage must be a real directory.");
      for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
        if (
          entry.isDirectory() &&
          PROJECT_ID.test(entry.name) &&
          !entries.has(entry.name)
        )
          entries.set(entry.name, []);
      }
    }
    const projects: StoredProject[] = [];
    for (const [id, registeredPaths] of entries) {
      const dataPath = await this.projectDirectory(this.dataPath, id);
      const cachePath = await this.projectDirectory(this.cachePath, id);
      if (!(await stat(dataPath)) && !(await stat(cachePath))) continue;
      const metadata = await readJson(path.join(dataPath, "project.json"));
      const paths = [...registeredPaths];
      if (
        typeof metadata?.currentPath === "string" &&
        path.isAbsolute(metadata.currentPath) &&
        !paths.includes(metadata.currentPath)
      )
        paths.unshift(metadata.currentPath);
      let sourceAvailable = false;
      for (const source of paths) {
        try {
          if ((await fs.stat(source)).isDirectory()) sourceAvailable = true;
        } catch {
          /* Retained project may be offline. */
        }
      }
      const historyBytes = await size(path.join(dataPath, "history.git"));
      const agentBytes =
        (await size(path.join(dataPath, "sessions"))) +
        (await size(path.join(dataPath, "agent-workspaces")));
      const dataBytes = await size(dataPath);
      const cacheBytes = await size(cachePath);
      const settings = await readJson(
        path.join(dataPath, "history-settings.json"),
      );
      const resolvedPaths = await Promise.all(
        paths.map((source) =>
          fs.realpath(source).catch(() => path.resolve(source)),
        ),
      );
      projects.push({
        id,
        paths,
        name: paths[0]
          ? path.basename(paths[0])
          : `Stored project ${id.slice(0, 8)}`,
        sourceAvailable,
        isRecent: resolvedPaths.some((source) => recent.has(source)),
        isOpen: this.ownership.hasOpenPaths(
          await Promise.all(
            paths.map((source) =>
              fs.realpath(source).catch(() => path.resolve(source)),
            ),
          ),
        ),
        historyBytes,
        agentBytes,
        otherBytes: Math.max(0, dataBytes - historyBytes - agentBytes),
        cacheBytes,
        totalBytes: dataBytes + cacheBytes,
        historyLimitBytes: Number.isSafeInteger(settings?.storageLimitBytes)
          ? settings!.storageLimitBytes!
          : DEFAULT_LIMIT,
        dataPath,
        cachePath,
      });
    }
    projects.sort(
      (a, b) => b.totalBytes - a.totalBytes || a.name.localeCompare(b.name),
    );
    const managedBytes =
      (await size(this.dataPath)) + (await size(this.cachePath));
    const profileBytes = await size(this.profilePath, [
      this.dataPath,
      this.cachePath,
    ]);
    const browserCacheBytes =
      (await size(path.join(this.profilePath, "Cache"))) +
      (await size(path.join(this.profilePath, "Code Cache")));
    return {
      projects,
      totalBytes: managedBytes + profileBytes,
      sharedBytes: Math.max(
        0,
        managedBytes -
          projects.reduce((sum, project) => sum + project.totalBytes, 0),
      ),
      profileBytes: Math.max(0, profileBytes - browserCacheBytes),
      browserCacheBytes,
      dataPath: this.dataPath,
      cachePath: this.cachePath,
      profilePath: this.profilePath,
    };
  }

  async cleanupUnusedCaches(now = Date.now()): Promise<string[]> {
    if (this.cleaningCache) return [];
    this.cleaningCache = true;
    try {
      const schedulePath = path.join(this.dataPath, "cache-cleanup.json");
      const schedule = await readJson(schedulePath);
      if (
        typeof schedule?.lastCleanupAt === "number" &&
        now >= schedule.lastCleanupAt &&
        now - schedule.lastCleanupAt < CACHE_CLEANUP_INTERVAL_MS
      )
        return [];
      const removed: string[] = [];
      for (const project of (await this.list()).projects) {
        if (
          project.isOpen ||
          project.cacheBytes === 0 ||
          project.paths.length === 0
        )
          continue;
        try {
          await this.ownership.withStorageMaintenance(
            project.paths,
            async () => {
              const data = await this.projectDirectory(
                this.dataPath,
                project.id,
              );
              const cache = await this.projectDirectory(
                this.cachePath,
                project.id,
              );
              // Native storage resolution rewrites this metadata on open/compile.
              // Unknown age is retained; newer cache writes also postpone cleanup.
              const metadata = await stat(path.join(data, "project.json"));
              if (!metadata?.isFile() || metadata.isSymbolicLink()) return;
              const lastUsed = Math.max(
                metadata.mtimeMs,
                await newestModification(cache),
              );
              // Round up sub-millisecond filesystem timestamps at the age boundary.
              if (now - Math.ceil(lastUsed) <= CACHE_MAX_IDLE_MS) return;
              await fs.rm(cache, { recursive: true, force: true });
              removed.push(project.id);
            },
          );
        } catch (error) {
          // A project can open between inventory and the maintenance reservation.
          // Leave its cache intact and allow other projects to be checked.
          console.warn("Project cache cleanup skipped", project.id, error);
        }
      }
      await fs.mkdir(this.dataPath, { recursive: true });
      const temp = `${schedulePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(
          temp,
          JSON.stringify({ version: 1, lastCleanupAt: now }),
        );
        await fs.rename(temp, schedulePath);
      } finally {
        await fs.rm(temp, { force: true });
      }
      return removed;
    } finally {
      this.cleaningCache = false;
    }
  }

  private async find(id: string) {
    if (!PROJECT_ID.test(id))
      throw new Error("Invalid stored project identifier.");
    const entry = (await this.list()).projects.find(
      (project) => project.id === id,
    );
    if (!entry)
      throw new Error(
        "This project no longer has stored data. Refresh Storage.",
      );
    return entry;
  }

  async clear(
    id: string,
    action: StorageAction,
    clearRecovery?: (paths: string[]) => Promise<void>,
  ) {
    if (!["cache", "history", "agent", "all"].includes(action))
      throw new Error("Unknown storage action.");
    const entry = await this.find(id);
    await this.ownership.withStorageMaintenance(entry.paths, async () => {
      const data = await this.projectDirectory(this.dataPath, id);
      const cache = await this.projectDirectory(this.cachePath, id);
      if (
        (action === "history" || action === "agent") &&
        (await hasPrivateAgentStorage(path.join(data, "history.git")))
      ) {
        throw new Error(
          action === "history"
            ? "This history shares storage with agent proposals. Use Clear History in Rewind to preserve those proposals."
            : "Agent proposals use shared Git storage. Open the project and finish or discard its proposals before clearing agent data.",
        );
      }
      const targets =
        action === "cache"
          ? [cache]
          : action === "history"
            ? [path.join(data, "history.git")]
            : action === "agent"
              ? [
                  path.join(data, "sessions"),
                  path.join(data, "agent-workspaces"),
                ]
              : [data, cache];
      if (action === "agent" || action === "all")
        await clearRecovery?.(entry.paths);
      for (const target of targets) {
        // rm unlinks a symlink itself; no recursive traversal outside our roots.
        await fs.rm(target, { recursive: true, force: true });
      }
      // Keep the registry identity: opening the same path reconnects to the
      // retained categories, or creates fresh storage after explicit removal.
    });
  }

  async setHistoryLimit(id: string, bytes: number) {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 10 * 1024 * 1024 ||
      bytes > 100 * 1024 ** 3
    )
      throw new Error("History budget must be between 10 MB and 100 GB.");
    const entry = await this.find(id);
    await this.ownership.withStorageMaintenance(entry.paths, async () => {
      const data = await this.projectDirectory(this.dataPath, id);
      await fs.mkdir(data, { recursive: true });
      const temp = path.join(data, `history-settings-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(
          temp,
          JSON.stringify({ version: 1, storageLimitBytes: bytes }),
        );
        await fs.rename(temp, path.join(data, "history-settings.json"));
      } finally {
        await fs.rm(temp, { force: true });
      }
    });
  }

  async revealPath(id?: string) {
    if (!id) return this.dataPath;
    const entry = await this.find(id);
    return (await stat(entry.dataPath)) ? entry.dataPath : entry.cachePath;
  }
}
