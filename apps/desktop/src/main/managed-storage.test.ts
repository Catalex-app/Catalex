import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ManagedStorage } from "./managed-storage";
import { ProjectOwnership } from "./project-ownership";

const id = "11111111-1111-4111-8111-111111111111";
const orphanId = "22222222-2222-4222-8222-222222222222";
let root: string;
let source: string;
let data: string;
let cache: string;
let entry: string;
let ownership: ProjectOwnership;
let storage: ManagedStorage;
async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-storage-test-"));
  source = path.join(root, "source");
  data = path.join(root, "profile/data");
  cache = path.join(root, "profile/project-cache");
  entry = path.join(data, "projects", id);
  await write(path.join(source, "main.tex"), "source content");
  await write(path.join(source, ".git/config"), "user remote configuration");
  await write(
    path.join(data, "project-registry.json"),
    JSON.stringify({ version: 1, projects: [{ id, paths: [source] }] }),
  );
  await write(
    path.join(entry, "project.json"),
    JSON.stringify({ version: 1, projectId: id, currentPath: source }),
  );
  await write(path.join(entry, "history.git/objects/blob"), "saved history");
  await write(path.join(entry, "sessions/chat.json"), "saved session");
  await write(
    path.join(entry, "agent-workspaces/draft/main.tex"),
    "agent draft",
  );
  await write(
    path.join(cache, "projects", id, "latex-build/main.pdf"),
    "cached preview",
  );
  await write(path.join(root, "profile/Preferences"), "profile settings");
  ownership = new ProjectOwnership();
  storage = new ManagedStorage(
    data,
    cache,
    path.join(root, "profile"),
    ownership,
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("managed project storage", () => {
  it.each([
    "cache",
    "history",
    "agent",
    "all",
  ] as const)("%s cleanup respects live comment and source boundaries", async (action) => {
    const comments = ["human.json", "agent.json"].map((name) =>
      path.join(entry, "comments", name),
    );
    for (const file of comments) await write(file, '{"comments":[]}');
    await storage.clear(id, action);
    for (const file of comments) {
      if (action === "all")
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      else expect(await fs.readFile(file, "utf8")).toBe('{"comments":[]}');
    }
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
    expect(await fs.readFile(path.join(source, ".git/config"), "utf8")).toBe(
      "user remote configuration",
    );
  });

  it("inventories retained, unavailable and orphan projects independently of recents", async () => {
    await write(
      path.join(data, "projects", orphanId, "project.json"),
      JSON.stringify({ currentPath: path.join(root, "missing") }),
    );
    await write(path.join(root, "profile/Cache/resource"), "cached resource");
    await write(path.join(root, "profile/Code Cache/code"), "cached code");
    const inventory = await storage.list();
    expect(inventory.projects).toHaveLength(2);
    expect(
      inventory.projects.find((project) => project.id === orphanId)
        ?.sourceAvailable,
    ).toBe(false);
    const project = inventory.projects.find((project) => project.id === id)!;
    expect(project.historyBytes).toBe(Buffer.byteLength("saved history"));
    expect(project.agentBytes).toBe(
      Buffer.byteLength("saved sessionagent draft"),
    );
    expect(project.cacheBytes).toBe(Buffer.byteLength("cached preview"));
    expect(inventory.browserCacheBytes).toBe(
      Buffer.byteLength("cached resourcecached code"),
    );
    expect(inventory.profileBytes).toBe(Buffer.byteLength("profile settings"));
    expect(inventory.totalBytes).toBe(
      inventory.projects.reduce((sum, project) => sum + project.totalBytes, 0) +
        inventory.sharedBytes +
        inventory.profileBytes +
        inventory.browserCacheBytes,
    );
  });

  it("matches recent projects through canonical paths without treating open state as activity", async () => {
    const alias = path.join(root, "source-alias");
    await fs.symlink(source, alias);
    expect((await storage.list([alias])).projects[0]).toMatchObject({
      isRecent: true,
      isOpen: false,
      sourceAvailable: true,
    });
    expect((await storage.list([])).projects[0].isRecent).toBe(false);
  });

  it("clears categories separately without changing source Git or registry identity", async () => {
    await storage.clear(id, "cache");
    expect((await storage.list()).projects[0].cacheBytes).toBe(0);
    expect(
      await fs.readFile(path.join(entry, "history.git/objects/blob"), "utf8"),
    ).toBe("saved history");
    await storage.setHistoryLimit(id, 500 * 1024 ** 2);
    expect((await storage.list()).projects[0].historyLimitBytes).toBe(
      500 * 1024 ** 2,
    );
    await storage.clear(id, "history");
    expect(
      await fs.readFile(path.join(entry, "sessions/chat.json"), "utf8"),
    ).toBe("saved session");
    await storage.clear(id, "all");
    expect((await storage.list()).projects).toHaveLength(0);
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
    expect(await fs.readFile(path.join(source, ".git/config"), "utf8")).toBe(
      "user remote configuration",
    );
    expect(
      JSON.parse(
        await fs.readFile(path.join(data, "project-registry.json"), "utf8"),
      ).projects[0].id,
    ).toBe(id);
  });

  it("counts chat media as agent data and clears it without touching referenced files", async () => {
    const media = path.join(entry, "sessions/media/screenshot.png");
    const external = path.join(root, "external.png");
    await write(external, "original image");
    const before = (await storage.list()).projects[0].agentBytes;
    await write(media, "screenshot bytes");
    expect((await storage.list()).projects[0].agentBytes).toBe(
      before + Buffer.byteLength("screenshot bytes"),
    );
    await storage.clear(id, "history");
    await storage.clear(id, "cache");
    expect(await fs.readFile(media, "utf8")).toBe("screenshot bytes");
    await storage.clear(id, "agent");
    await expect(fs.stat(media)).rejects.toThrow();
    expect(await fs.readFile(external, "utf8")).toBe("original image");
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
  });

  it.each([
    [".git/refs/catalex/agents/draft/source", "saved checkpoint"],
    [".git/refs/heads/catalex-agent-draft", "saved checkpoint"],
    [".git/worktrees/draft/HEAD", "saved checkpoint"],
    [".git/packed-refs", "abcd refs/catalex/agents/draft/source\n"],
    [".git/packed-refs", "abcd refs/heads/catalex-agent-draft\n"],
  ])("protects shared proposal storage detected in %s", async (relative, contents) => {
    const protectedFile = path.join(entry, "history.git", relative);
    await write(protectedFile, contents);
    await expect(storage.clear(id, "history")).rejects.toThrow("Rewind");
    const clearRecovery = async () => {
      throw new Error("Must not clear recovery for a blocked operation");
    };
    await expect(storage.clear(id, "agent", clearRecovery)).rejects.toThrow(
      "finish or discard",
    );
    expect(await fs.readFile(protectedFile, "utf8")).toBe(contents);
    expect(
      await fs.readFile(path.join(entry, "sessions/chat.json"), "utf8"),
    ).toBe("saved session");
    // Explicit removal of all project data includes both sides of the shared
    // relationship and is still allowed for a closed project.
    await storage.clear(id, "all");
    await expect(fs.stat(protectedFile)).rejects.toThrow();
  });

  it("blocks cleanup and budget changes for projects open in any window", async () => {
    const lease = await ownership.acquire(source, "other-window");
    expect((await storage.list()).projects[0].isOpen).toBe(true);
    for (const action of ["cache", "history", "agent", "all"] as const)
      await expect(storage.clear(id, action)).rejects.toThrow(
        "Close this project",
      );
    await expect(storage.setHistoryLimit(id, 100 * 1024 ** 2)).rejects.toThrow(
      "Close this project",
    );
    ownership.release(lease, "other-window");
    await storage.clear(id, "agent");
    expect((await storage.list()).projects[0].agentBytes).toBe(0);
  });

  it("does not follow symlinks or accept arbitrary paths for cleanup", async () => {
    await fs.symlink(
      source,
      path.join(entry, "source-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(storage.clear("../../source", "all")).rejects.toThrow(
      "Invalid",
    );
    await expect(storage.clear(id, "unknown" as "all")).rejects.toThrow(
      "Unknown",
    );
    await storage.clear(id, "all");
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
    await fs.symlink(
      source,
      entry,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(storage.clear(id, "all")).rejects.toThrow("real directory");
  });

  it("supports cleanup after the source folder has disappeared", async () => {
    await fs.rm(source, { recursive: true });
    expect((await storage.list()).projects[0].sourceAvailable).toBe(false);
    await storage.clear(id, "history");
    expect((await storage.list()).projects[0].historyBytes).toBe(0);
  });

  it("holds the project closed while storage work is running, then releases it on failure", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const operation = ownership.withStorageMaintenance([source], async () => {
      entered();
      await held;
      throw new Error("cleanup failed");
    });
    const rejected = expect(operation).rejects.toThrow("cleanup failed");
    await ready;
    await expect(ownership.acquire(source, "new-window")).rejects.toThrow(
      "being managed",
    );
    await expect(
      ownership.withStorageMaintenance([source], async () => {}),
    ).rejects.toThrow("already being managed");
    finish();
    await rejected;
    await expect(ownership.acquire(source, "new-window")).resolves.toBeTypeOf(
      "string",
    );
  });
});

const day = 24 * 60 * 60 * 1000;
async function ageCache(now: number, days: number) {
  const stamp = new Date(now - days * day);
  async function age(file: string) {
    const info = await fs.lstat(file);
    if (info.isDirectory())
      for (const child of await fs.readdir(file))
        await age(path.join(file, child));
    await fs.utimes(file, stamp, stamp);
  }
  await age(path.join(cache, "projects", id));
  await fs.utimes(path.join(entry, "project.json"), stamp, stamp);
}

describe("automatic project cache cleanup", () => {
  it("clears only cache older than 30 days, retaining source, history and sessions", async () => {
    const now = Date.now();
    await ageCache(now, 31);
    expect(await storage.cleanupUnusedCaches(now)).toEqual([id]);
    await expect(
      fs.stat(path.join(cache, "projects", id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
    expect(await fs.readFile(path.join(source, ".git/config"), "utf8")).toBe(
      "user remote configuration",
    );
    expect(
      await fs.readFile(path.join(entry, "history.git/objects/blob"), "utf8"),
    ).toBe("saved history");
    expect(
      await fs.readFile(path.join(entry, "sessions/chat.json"), "utf8"),
    ).toBe("saved session");
  });

  it("keeps recently used cache and the exact 30-day boundary", async () => {
    const now = Date.now();
    await ageCache(now, 30);
    expect(await storage.cleanupUnusedCaches(now)).toEqual([]);
    await ageCache(now, 40);
    const metadata = path.join(entry, "project.json");
    await fs.utimes(metadata, new Date(now), new Date(now));
    expect(await storage.cleanupUnusedCaches(now + day)).toEqual([]);
    await ageCache(now, 40);
    await fs.writeFile(
      path.join(cache, "projects", id, "latex-build/main.pdf"),
      "new compile",
    );
    expect(await storage.cleanupUnusedCaches(now + 2 * day)).toEqual([]);
  });

  it("skips open projects and persists the daily check across app restarts", async () => {
    const now = Date.now();
    await ageCache(now, 31);
    const token = await ownership.acquire(source, "main");
    expect(await storage.cleanupUnusedCaches(now)).toEqual([]);
    ownership.release(token, "main");
    const restarted = new ManagedStorage(
      data,
      cache,
      path.join(root, "profile"),
      ownership,
    );
    expect(await restarted.cleanupUnusedCaches(now + day - 1)).toEqual([]);
    expect(await restarted.cleanupUnusedCaches(now + day)).toEqual([id]);
  });

  it("keeps cache with unknown metadata age and does not follow cache symlinks", async () => {
    const now = Date.now();
    await ageCache(now, 31);
    await fs.rm(path.join(entry, "project.json"));
    expect(await storage.cleanupUnusedCaches(now)).toEqual([]);
    await fs.symlink(source, path.join(cache, "projects", id, "outside"));
    await write(
      path.join(entry, "project.json"),
      JSON.stringify({ currentPath: source }),
    );
    await fs.utimes(
      path.join(entry, "project.json"),
      new Date(now - 31 * day),
      new Date(now - 31 * day),
    );
    await fs.utimes(
      path.join(cache, "projects", id),
      new Date(now - 31 * day),
      new Date(now - 31 * day),
    );
    expect(await storage.cleanupUnusedCaches(now + day)).toEqual([id]);
    expect(await fs.readFile(path.join(source, "main.tex"), "utf8")).toBe(
      "source content",
    );
  });
});
