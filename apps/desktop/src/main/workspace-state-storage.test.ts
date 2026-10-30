import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorkspaceStateStorage } from "./workspace-state-storage";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-state-test-"));
  directories.push(dir);
  return { dir, storage: new WorkspaceStateStorage(dir) };
}
const key = "catalex-agent-review-queue";
describe("workspace recovery files", () => {
  it("stores a review larger than browser quota and restores it after restart", async () => {
    const { dir, storage } = await setup();
    const value = JSON.stringify({
      state: {
        entries: [
          {
            editedContents: { paper: "a".repeat(12 * 1024 * 1024) },
            decisions: { first: false, second: true },
          },
        ],
      },
    });
    await storage.run(() => storage.write(key, value, null));
    expect((await new WorkspaceStateStorage(dir).read(key)).value).toBe(value);
  });
  it("keeps the last good save when publication fails and can retry", async () => {
    const { storage } = await setup();
    const revision = await storage.write(key, '{"state":"original"}', null);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      storage.write(key, '{"state":"edited"}', revision),
    ).rejects.toThrow("disk full");
    expect((await storage.read(key)).value).toBe('{"state":"original"}');
    await storage.write(key, '{"state":"edited"}', revision);
    expect((await storage.read(key)).value).toBe('{"state":"edited"}');
  });
  it("refuses stale window saves rather than overwriting other review decisions", async () => {
    const { storage } = await setup();
    await storage.write(key, '{"approved":false}', null);
    await expect(storage.write(key, '{"approved":true}', null)).rejects.toThrow(
      "another window",
    );
    expect((await storage.read(key)).value).toBe('{"approved":false}');
  });
  it("merges independent project saves and later deletions without losing another window's records", async () => {
    const { storage } = await setup();
    const key = "catalex-proposed-changes";
    const value = (changes: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        state: { changesByProject: changes, workspaceReviewsByProject: {} },
      });
    const a = value({ a: ["manual A"] });
    const b = value({ b: ["manual B"] });
    await storage.write(key, a, null, null);
    const revision = await storage.write(key, b, null, null);
    expect(
      JSON.parse((await storage.read(key)).value!).state.changesByProject,
    ).toEqual({ a: ["manual A"], b: ["manual B"] });
    // B has not yet read the merged A snapshot; its later removal must retain A.
    await storage.write(key, value({}), revision, b);
    expect(
      JSON.parse((await storage.read(key)).value!).state.changesByProject,
    ).toEqual({ a: ["manual A"] });
    await expect(
      storage.write(key, value({ a: ["conflicting edit"] }), null, null),
    ).rejects.toThrow("another window");
  });

  it("clears only the selected project's recovery records and evacuated chats", async () => {
    const { storage } = await setup();
    await storage.write(
      key,
      JSON.stringify({
        state: {
          entries: [
            { session: { projectRoot: "/one", sessionId: "one" } },
            { session: { projectRoot: "/two", sessionId: "two" } },
          ],
        },
      }),
      null,
    );
    await storage.migrate("catalex-project-chats:/one", '{"tabs":[]}');
    await storage.clearProjects(["/one"]);
    expect((await storage.read("catalex-project-chats:/one")).value).toBeNull();
    expect(JSON.parse((await storage.read(key)).value!).state.entries).toEqual([
      { session: { projectRoot: "/two", sessionId: "two" } },
    ]);
  });

  it("migration retries preserve identical copies and archive conflicts without replacing active data", async () => {
    const { storage } = await setup();
    const legacy = "catalex-project-chats:/unopened/project";
    await storage.migrate(legacy, '{"tabs":[]}');
    await storage.migrate(legacy, '{"tabs":[]}');
    const result = await storage.migrate(legacy, '{"tabs":[1]}');
    expect(JSON.parse(await fs.readFile(result!.backupPath, "utf8"))).toEqual({
      key: legacy,
      browserValue: '{"tabs":[1]}',
      diskValue: '{"tabs":[]}',
    });
    expect(await storage.migrate(legacy, '{"tabs":[1]}')).toEqual(result);
    expect((await storage.read(legacy)).value).toBe('{"tabs":[]}');
    await expect(storage.write("arbitrary", "{}", null)).rejects.toThrow(
      "Unsupported",
    );
  });
});

it("keeps active recovery intact if conflict backup cannot be written", async () => {
  const { dir, storage } = await setup();
  await storage.migrate(key, '{"state":{"entries":[]}}');
  await fs.writeFile(
    path.join(dir, "migration-conflicts"),
    "blocked destination",
  );
  await expect(
    storage.migrate(key, '{"state":{"entries":[1]}}'),
  ).rejects.toThrow();
  expect((await storage.read(key)).value).toBe('{"state":{"entries":[]}}');
});
