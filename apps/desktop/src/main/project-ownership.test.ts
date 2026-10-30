import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectOwnership } from "./project-ownership";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ownership-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("project ownership", () => {
  it("admits exactly one competing window, including a symlink alias", async () => {
    const project = path.join(root, "project");
    const alias = path.join(root, "alias");
    await fs.mkdir(project);
    await fs.symlink(
      project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const registry = new ProjectOwnership();
    const results = await Promise.allSettled([
      registry.acquire(project, "one"),
      registry.acquire(alias, "two"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(await registry.owner(project)).toBe(await registry.owner(alias));
  });

  it("keeps ownership while the same window replaces its active lease", async () => {
    const registry = new ProjectOwnership();
    const first = await registry.acquire(root, "one");
    const pending = await registry.acquire(root, "one");
    registry.release(first, "one");
    await expect(registry.acquire(root, "two")).rejects.toThrow(
      "another window",
    );
    registry.release(pending, "two");
    expect(await registry.owner(root)).toBe("one");
    registry.release(pending, "one");
    await expect(registry.acquire(root, "two")).resolves.toBeTypeOf("string");
  });

  it("releases all reservations on window exit without persistent flags", async () => {
    const registry = new ProjectOwnership();
    await registry.acquire(root, "one");
    registry.releaseWindow("one");
    expect(await registry.owner(root)).toBeNull();
    await registry.acquire(root, "two");
    expect(await new ProjectOwnership().owner(root)).toBeNull();
  });

  it("does not resurrect a closed window while resolving a path", async () => {
    const registry = new ProjectOwnership();
    const pending = registry.acquire(root, "one");
    registry.releaseWindow("one");
    await expect(pending).rejects.toThrow("closed");
    expect(await registry.owner(root)).toBeNull();
  });

  it("rejects requests whose window changed before path authorization finished", async () => {
    const registry = new ProjectOwnership();
    const generation = registry.generation("one");
    registry.invalidate("one");
    await expect(registry.acquire(root, "one", generation)).rejects.toThrow(
      "closed",
    );
    expect(await registry.owner(root)).toBeNull();
  });

  it("blocks trashing open projects, their parents, children and aliases", async () => {
    const project = path.join(root, "project");
    const child = path.join(project, "child");
    const alias = path.join(root, "alias");
    await fs.mkdir(child, { recursive: true });
    await fs.symlink(
      project,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const registry = new ProjectOwnership();
    const lease = await registry.acquire(project, "one");
    let moved = false;
    for (const target of [root, project, child, alias]) {
      await expect(
        registry.trash(target, async () => {
          moved = true;
        }),
      ).rejects.toThrow("Close this project");
    }
    expect(moved).toBe(false);
    registry.release(lease, "one");
    await registry.trash(project, async () => {
      moved = true;
    });
    expect(moved).toBe(true);
  });

  it("reserves a project during trash and releases it after an OS failure", async () => {
    const registry = new ProjectOwnership();
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const trash = registry.trash(root, async () => {
      started();
      await held;
      throw new Error("OS refused");
    });
    const failed = expect(trash).rejects.toThrow("OS refused");
    await ready;
    await expect(registry.acquire(root, "one")).rejects.toThrow("being moved");
    await expect(registry.trash(root, async () => {})).rejects.toThrow(
      "already",
    );
    finish();
    await failed;
    await expect(registry.acquire(root, "one")).resolves.toBeTypeOf("string");
  });

  it("does not reserve a missing project or a regular file", async () => {
    const registry = new ProjectOwnership();
    await expect(
      registry.acquire(path.join(root, "missing"), "one"),
    ).rejects.toThrow();
    const file = path.join(root, "notes.md");
    await fs.writeFile(file, "notes");
    await expect(registry.acquire(file, "one")).rejects.toThrow("folder");
    expect(await registry.owner(file)).toBeNull();
  });
});
