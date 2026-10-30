import { readCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-anchor-recovery-"),
);
const project = path.join(profile, "Project");
const original = "before target after\n";
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), original);
await fs.writeFile(path.join(project, "comments.json"), "ignored project JSON");
await fs.writeFile(
  path.join(project, "comments-agents.json"),
  "ignored agent JSON",
);
let app;
let commentDirectory;
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  console.log("Launched");
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error(error));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(msg.text());
  });
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.evaluate(async () =>
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish(),
  );
  console.log("Ready");
  return page;
}
async function close() {
  console.log("Closing");
  await app.close();
  console.log("Closed");
  app = undefined;
}
async function recover(page) {
  return page.evaluate(async (projectRoot) => {
    const { loadProjectInlineComments } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    return (await loadProjectInlineComments(projectRoot))["notes.md"][0];
  }, project);
}
try {
  await vite.listen();
  let page = await launch();
  await page.evaluate(
    async ({ projectRoot, source }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("update_project_comment_anchored", {
        projectRoot,
        source,
        patch: {
          filePath: "notes.md",
          id: "recovery",
          before: null,
          after: {
            id: "recovery",
            from: 7,
            to: 13,
            line: 1,
            text: "Keep this comment",
          },
        },
      });
    },
    { projectRoot: project, source: original },
  );
  await close();
  // State left by interruption between a source save and comment completion.
  await fs.writeFile(path.join(project, "notes.md"), `prefix ${original}`);
  page = await launch();
  console.log("Recovering");
  const registry = JSON.parse(
    await fs.readFile(
      path.join(profile, "data", "project-registry.json"),
      "utf8",
    ),
  );
  const canonical = await fs.realpath(project);
  const entry = registry.projects.find((entry) =>
    entry.paths.includes(canonical),
  );
  commentDirectory = path.join(
    profile,
    "data",
    "projects",
    entry.id,
    "comments",
  );
  assert.equal(
    await fs.readFile(path.join(project, "comments.json"), "utf8"),
    "ignored project JSON",
  );
  const recovered = await recover(page);
  assert.equal(recovered.from, 14);
  assert.equal(recovered.to, 20);
  assert.equal(recovered.positionReset, undefined);
  const snapshot = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("read_project_comments_anchored", { projectRoot });
  }, project);
  assert.equal(
    snapshot.sources[snapshot.documents["notes.md"]],
    `prefix ${original}`,
  );
  assert.equal(
    snapshot.files["notes.md"][0].anchorRevision,
    snapshot.documents["notes.md"],
  );
  await close();
  page = await launch();
  assert.deepEqual(await recover(page), recovered);
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(projectRoot);
  }, project);
  const section = page.locator('[data-sidebar-section="comment-visibility"]');
  await section.locator("button").first().click();
  await expect(
    section.getByRole("button", { name: "Manage", exact: true }),
  ).toBeVisible();
  const artifacts = path.resolve(root, "../../output/playwright");
  await fs.mkdir(artifacts, { recursive: true });
  await section.screenshot({
    path: path.join(artifacts, "local-comment-sidebar.png"),
  });
  await section.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Manage comments" }),
  ).toBeVisible();
  await page.getByRole("dialog").screenshot({
    path: path.join(artifacts, "local-comment-clear-dialog.png"),
  });
  await page
    .getByRole("dialog", { name: "Manage comments" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  // Git and external tools update disk; the live watcher must recover comments too.
  await fs.writeFile(path.join(project, "notes.md"), `live prefix ${original}`);
  await expect
    .poll(
      () =>
        page.evaluate(async (projectRoot) => {
          const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
          const snapshot = await invoke("read_project_comments_anchored", {
            projectRoot,
          });
          return snapshot.files["notes.md"][0].from;
        }, project),
      { timeout: 15000 },
    )
    .toBe(19);
  // A broken metadata destination must not prevent a source save.
  await fs.rename(
    path.join(commentDirectory, "comments.polodb"),
    path.join(commentDirectory, "database.backup"),
  );
  await fs.writeFile(path.join(commentDirectory, "comments.polodb"), "blocked");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    // The project is already open. Reopening would test the project-switch
    // snapshot guard, rather than saving a source with broken comment metadata.
    const file = useDocumentStore
      .getState()
      .files.find((file) => file.relativePath === "notes.md");
    useDocumentStore.setState((state) => ({
      files: state.files.map((item) =>
        item.id === file.id
          ? {
              ...item,
              content: "Writing survives\n",
              diskContent: "live prefix before target after\n",
              isDirty: true,
            }
          : item,
      ),
    }));
    await useDocumentStore.getState().saveAllFiles({ requireClean: true });
    if (useDocumentStore.getState().files.some((file) => file.isDirty))
      throw new Error("Source remains dirty");
  });
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    "Writing survives\n",
  );
  await fs.unlink(path.join(commentDirectory, "comments.polodb"));
  await fs.rename(
    path.join(commentDirectory, "database.backup"),
    path.join(commentDirectory, "comments.polodb"),
  );
  await page.evaluate(async (projectRoot) => {
    const { clearProjectComments, loadProjectInlineComments } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    await clearProjectComments(projectRoot, false);
    const comments = await loadProjectInlineComments(projectRoot);
    if (Object.values(comments).flat().length)
      throw new Error("Deleted comments reappeared");
  }, project);
  assert.deepEqual(
    JSON.parse(
      await readCommentFixture(path.join(commentDirectory, "human.json")),
    ).files,
    {},
  );
  assert.equal(
    await fs.readFile(path.join(project, "comments.json"), "utf8"),
    "ignored project JSON",
  );
  console.log(
    "PASS: local storage, ignored project JSON, restart recovery, text save with failed comments, and full deletion",
  );
} catch (error) {
  console.error("Recovery smoke failed:", error);
  throw error;
} finally {
  if (app) {
    app.process().kill("SIGKILL");
    app = undefined;
  }
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
