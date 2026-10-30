import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

interface Lease {
  project: string;
  windowId: string;
  canonical: string;
}

/** In-memory ownership, shared by every workspace in this app process. */
export class ProjectOwnership {
  private leases = new Map<string, Lease>();
  private trashing = new Set<string>();
  private storageMaintenance = new Set<string>();
  private generations = new Map<string, number>();

  constructor(private changed: () => void = () => {}) {}

  private async identity(projectPath: string) {
    const canonical = await fs.realpath(projectPath);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("A project must be a folder.");
    // File identity also covers symlinks and case aliases on insensitive volumes.
    return stat.ino ? `${stat.dev}:${stat.ino}` : canonical;
  }

  generation(windowId: string) {
    return this.generations.get(windowId) ?? 0;
  }

  async acquire(
    projectPath: string,
    windowId: string,
    generation = this.generation(windowId),
  ) {
    const canonical = await fs.realpath(projectPath);
    const project = await this.identity(canonical);
    if (
      [...this.storageMaintenance].some((target) => overlaps(target, canonical))
    )
      throw new Error(
        "Stored project data is being managed. Try again when it finishes.",
      );
    if ([...this.trashing].some((target) => overlaps(target, canonical)))
      throw new Error("This project is being moved to Trash.");
    if (this.generation(windowId) !== generation)
      throw new Error("The requesting window has closed.");
    const owner = [...this.leases.values()].find(
      (lease) => lease.project === project,
    );
    if (owner && owner.windowId !== windowId)
      throw new Error(
        "This project is open in another window. Use Go to window in Recent Projects.",
      );
    // No await between checking ownership and reserving it. Separate leases let
    // a window reload its own project without exposing an ownership gap.
    const token = randomUUID();
    this.leases.set(token, { project, windowId, canonical });
    this.changed();
    return token;
  }

  async trash(projectPath: string, move: (target: string) => Promise<void>) {
    const canonical = await fs.realpath(projectPath);
    await this.identity(canonical);
    if (
      [...this.leases.values()].some((lease) =>
        overlaps(lease.canonical, canonical),
      )
    )
      throw new Error(
        "Close this project in all windows before moving it to Trash.",
      );
    if ([...this.trashing].some((target) => overlaps(target, canonical)))
      throw new Error("This project is already being moved to Trash.");
    this.trashing.add(canonical);
    try {
      await move(projectPath);
    } finally {
      this.trashing.delete(canonical);
    }
  }

  hasOpenPaths(paths: string[]) {
    return [...this.leases.values()].some(
      (lease) =>
        paths.length === 0 ||
        paths.some((source) => overlaps(path.resolve(source), lease.canonical)),
    );
  }

  async withStorageMaintenance<T>(
    paths: string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const resolved = await Promise.all(
      paths.map(async (source) =>
        fs.realpath(source).catch(() => path.resolve(source)),
      ),
    );
    if (this.hasOpenPaths(resolved))
      throw new Error(
        "Close this project in every window before managing its stored data.",
      );
    if (
      resolved.some((source) =>
        [...this.storageMaintenance, ...this.trashing].some((busy) =>
          overlaps(source, busy),
        ),
      )
    )
      throw new Error("This project's storage is already being managed.");
    for (const source of resolved) this.storageMaintenance.add(source);
    try {
      return await operation();
    } finally {
      for (const source of resolved) this.storageMaintenance.delete(source);
    }
  }

  release(token: string, windowId: string) {
    if (this.leases.get(token)?.windowId !== windowId) return;
    this.leases.delete(token);
    this.changed();
  }

  invalidate(windowId: string) {
    this.generations.set(windowId, (this.generations.get(windowId) ?? 0) + 1);
  }

  releaseWindow(windowId: string) {
    this.invalidate(windowId);
    for (const [token, lease] of this.leases) {
      if (lease.windowId === windowId) this.leases.delete(token);
    }
    this.changed();
  }

  async owner(projectPath: string): Promise<string | null> {
    const project = await this.identity(projectPath).catch(() => null);
    return (
      [...this.leases.values()].find((lease) => lease.project === project)
        ?.windowId ?? null
    );
  }
}

function overlaps(a: string, b: string) {
  const within = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return (
      !relative ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  };
  return within(a, b) || within(b, a);
}
