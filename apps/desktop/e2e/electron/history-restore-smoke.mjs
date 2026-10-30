import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-history-restore-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "Original version\n");
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
    const original = history.getState().snapshots[0];
    const file = docs
      .getState()
      .files.find((file) => file.relativePath === "notes.md");
    docs.getState().setActiveFile(file.id);
    docs.getState().updateFileContent("notes.md", "Later saved version\n");
    await docs.getState().saveCurrentFile();
    const later = history.getState().snapshots[0];
    docs
      .getState()
      .updateFileContent("notes.md", "Unsaved work before restore\n");
    await history.getState().restoreSnapshot(root, original.id);
    const snapshots = history.getState().snapshots;
    const before = snapshots.find((item) =>
      item.message.startsWith("[before-restore]"),
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
    if (before) await history.getState().restoreSnapshot(root, before.id);
    const recovered = docs
      .getState()
      .files.find((file) => file.relativePath === "notes.md")?.content;
    return {
      snapshots,
      original: original.id,
      later: later.id,
      captured,
      restored,
      recovered,
    };
  }, project);
  assert.equal(result.snapshots.length, 4);
  assert.equal(result.snapshots[2].id, result.later);
  assert.equal(result.snapshots[3].id, result.original);
  assert.equal(result.captured, "Unsaved work before restore\n");
  assert.equal(result.restored, "Original version\n");
  assert.equal(result.recovered, "Unsaved work before restore\n");
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    result.recovered,
  );
  console.log(
    "Electron history restoration preserved later versions and recovered unsaved work.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
}
