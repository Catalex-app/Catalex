import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-git-checkpoints-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "Original version\n");
for (const args of [
  ["init"],
  ["config", "user.name", "Test"],
  ["config", "user.email", "test@example.com"],
  ["config", "commit.gpgsign", "false"],
  ["config", "core.hooksPath", "/dev/null"],
  ["add", "."],
  ["commit", "-m", "Initial"],
])
  execFileSync("git", args, { cwd: project, stdio: "pipe" });
let app;
let vite;
try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  const result = await page.evaluate(async (root) => {
    const { useDocumentStore: docs } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useHistoryStore: history } = await import(
      "/src/renderer/stores/history-store.ts"
    );
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await docs.getState().openProject(root);
    await history.getState().init(root);
    await history.getState().loadSnapshots(root);
    docs.getState().setActiveFile("notes.md");
    docs
      .getState()
      .updateFileContent("notes.md", "Unsaved work before reset\n");
    await docs.getState().runGitOperation(
      root,
      {
        saveFiles: [],
        discardFiles: ["notes.md"],
        history: { label: "reset", before: true },
      },
      () =>
        invoke("git_panel_reset_selected", {
          projectRoot: root,
          selectedFiles: ["notes.md"],
          untrackedFiles: [],
        }),
    );
    const resetSnapshots = [...history.getState().snapshots];
    const before = resetSnapshots.find(
      (item) => item.message === "[git] Before reset",
    );
    const captured =
      before &&
      (await invoke("history_file_at", {
        projectRoot: root,
        snapshotId: before.id,
        filePath: "notes.md",
      }));
    const restored = docs
      .getState()
      .files.find((file) => file.relativePath === "notes.md")?.content;
    docs.getState().updateFileContent("notes.md", "Committed content\n");
    await docs.getState().runGitOperation(
      root,
      {
        saveFiles: ["notes.md"],
        history: { label: "commit" },
      },
      () =>
        invoke("git_panel_commit_selected", {
          projectRoot: root,
          selectedFiles: ["notes.md"],
          message: "Checkpoint test",
        }),
    );
    const commitSnapshot = history.getState().snapshots[0];
    const committed = await invoke("history_file_at", {
      projectRoot: root,
      snapshotId: commitSnapshot.id,
      filePath: "notes.md",
    });
    const count = history.getState().snapshots.length;
    await history.getState().createSnapshot(root, "Unchanged");
    return {
      resetSnapshots,
      captured,
      restored,
      commitSnapshot,
      committed,
      count,
      deduplicatedCount: history.getState().snapshots.length,
    };
  }, project);
  assert.equal(result.resetSnapshots[0].message, "[git] After reset");
  assert.equal(result.captured, "Unsaved work before reset\n");
  assert.equal(result.restored, "Original version\n");
  assert.equal(result.commitSnapshot.message, "[git] After commit");
  assert.equal(result.committed, "Committed content\n");
  assert.equal(result.count, result.deduplicatedCount);
  assert.equal(
    execFileSync("git", ["show", "HEAD:notes.md"], {
      cwd: project,
      encoding: "utf8",
    }),
    result.committed,
  );
  console.log(
    "Electron Git checkpoints captured unsaved reset content, reset results, and committed content without duplicate snapshots.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
}
