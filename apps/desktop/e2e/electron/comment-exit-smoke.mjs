import { writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-exit-"),
);
const source = "Comment persistence fixture.\n";
const revision = createHash("sha1").update(source).digest("hex");
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
let page;
const projects = [];
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
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
  // Delay at the native IPC boundary, then forward unchanged to the real service.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.commentGate = {
      hold: false,
      fail: false,
      blocked: false,
      release: null,
    };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      if (
        [
          "update_project_comment",
          "update_project_comment_anchored",
          "update_project_comment_anchors",
        ].includes(command)
      ) {
        const gate = globalThis.commentGate;
        if (gate.fail) {
          gate.failedProject = args.projectRoot;
          throw new Error("Fixture comment storage unavailable");
        }
        if (gate.hold) {
          gate.blocked = true;
          await new Promise((resolve) => {
            gate.release = resolve;
          });
        }
      }
      return handler(event, command, args);
    });
  });
}
async function open(project) {
  await page.evaluate(async (project) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
    useDocumentStore.getState().setActiveFile("notes.md");
  }, project);
}
async function snapshot(project) {
  return page.evaluate(
    async (projectRoot) =>
      (await import("/src/renderer/lib/desktop/core.ts")).invoke(
        "read_project_comments_anchored",
        { projectRoot },
      ),
    project,
  );
}
async function seed(name) {
  const project = path.join(profile, name);
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "notes.md"), source);
  await snapshot(project);
  const registry = JSON.parse(
    await fs.readFile(path.join(profile, "data/project-registry.json"), "utf8"),
  );
  const canonical = await fs.realpath(project);
  const entry = registry.projects.find((entry) =>
    entry.paths.includes(canonical),
  );
  for (const kind of ["human", "agent"]) {
    const comment = {
      id: kind,
      number: 1,
      from: 0,
      to: 7,
      line: 1,
      text: `${kind} before`,
      anchorRevision: revision,
      ...(kind === "agent"
        ? { origin: { provider: "codex", sessionId: "fixture" } }
        : {}),
    };
    await writeCommentFixture(
      path.join(profile, "data/projects", entry.id, "comments", `${kind}.json`),
      JSON.stringify({
        version: 1,
        counter: 1,
        files: { "notes.md": [comment] },
        sources: { [revision]: source },
      }),
    );
  }
  return project;
}
async function edit(project, action) {
  await page.evaluate(
    async ({ project, action }) => {
      const { saveProjectInlineComments, loadProjectInlineComments } =
        await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
      const before = await loadProjectInlineComments(project);
      const comments = before["notes.md"];
      const after = {
        "notes.md":
          action === "delete"
            ? []
            : comments.map((c) =>
                action === "resolve"
                  ? { ...c, resolved: true }
                  : { ...c, text: `${c.id} after` },
              ),
      };
      window.commentSave = saveProjectInlineComments(
        project,
        before,
        after,
      ).catch((error) => {
        window.commentSaveError = String(error);
      });
    },
    { project, action },
  );
}
function verify(data, action) {
  const comments = data.files["notes.md"] ?? [];
  if (action === "delete") assert.equal(comments.length, 0);
  else {
    assert.equal(comments.length, 2);
    for (const c of comments) {
      if (action === "resolve") assert.equal(c.resolved, true);
      else assert.equal(c.text, `${c.id} after`);
    }
    assert.equal(
      comments.find((c) => c.id === "agent").origin.provider,
      "codex",
    );
  }
}
async function release() {
  await app.evaluate(() => {
    const gate = globalThis.commentGate;
    gate.hold = false;
    gate.fail = false;
    gate.release?.();
  });
}
try {
  await vite.listen();
  await launch();
  const destination = await seed("destination");
  for (const mode of ["switch", "close"]) {
    for (const action of ["edit", "resolve", "delete"]) {
      const project = await seed(`${mode}-${action}`);
      await open(project);
      await app.evaluate(() => {
        globalThis.commentGate.hold = true;
        globalThis.commentGate.blocked = false;
      });
      await edit(project, action);
      await expect
        .poll(() => app.evaluate(() => globalThis.commentGate.blocked))
        .toBe(true);
      if (mode === "switch") {
        await page.evaluate(async (destination) => {
          const { useDocumentStore } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          window.departure = useDocumentStore
            .getState()
            .openProject(destination);
        }, destination);
      } else
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].close(),
        );
      await page.waitForTimeout(250);
      assert.equal(
        await page.evaluate(
          async () =>
            (
              await import("/src/renderer/stores/document-store.ts")
            ).useDocumentStore.getState().projectRoot,
        ),
        project,
      );
      assert.equal(page.isClosed(), false);
      await release();
      if (mode === "switch")
        await page.evaluate(async () => await window.departure);
      else {
        await expect.poll(() => page.isClosed()).toBe(true);
        await app.close();
        app = undefined;
        await launch();
      }
      verify(await snapshot(project), action);
      projects.push({ project, action });
      console.log(
        `PASS both origins: delayed ${action}, ${mode}, persisted result`,
      );
    }
  }
  const failedProject = await seed("failure");
  await open(failedProject);
  await app.evaluate(() => {
    globalThis.commentGate.fail = true;
  });
  await edit(failedProject, "edit");
  await page.evaluate(async () => await window.commentSave);
  await page.evaluate(async (destination) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore
      .getState()
      .updateFileContent("notes.md", "Manuscript still saves.\n");
    window.departureError = null;
    await useDocumentStore
      .getState()
      .openProject(destination)
      .catch((error) => {
        window.departureError = String(error);
      });
  }, destination);
  assert.ok(await page.evaluate(() => window.departureError));
  assert.equal(
    await fs.readFile(path.join(failedProject, "notes.md"), "utf8"),
    "Manuscript still saves.\n",
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await import("/src/renderer/stores/document-store.ts")
        ).useDocumentStore.getState().projectRoot,
    ),
    failedProject,
  );
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(profile, "comment-save-failure.png"),
  });
  await app.evaluate(() => {
    globalThis.commentGate.fail = false;
  });
  await open(destination);
  verify(await snapshot(failedProject), "edit");
  console.log(
    "PASS failed comments block departure, source saves independently, retry succeeds",
  );
  await app.close();
  app = undefined;
  await launch();
  console.log("Checking retry UI");
  const uiProject = await seed("retry-ui");
  await open(uiProject);

  await app.evaluate(() => {
    globalThis.commentGate.fail = true;
    globalThis.commentGate.failedProject = null;
  });
  await page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="human"]')
    .getByRole("button", { name: "Resolve comment", exact: true })
    .click();
  await page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="human"]')
    .getByRole("button", { name: "Confirm resolve comment", exact: true })
    .click();
  await expect
    .poll(() => app.evaluate(() => globalThis.commentGate.failedProject))
    .toBe(uiProject);
  await expect(
    page.getByRole("button", { name: "Retry saving", exact: true }),
  ).toBeVisible();
  console.log("Checking failed close");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page.waitForTimeout(500);
  assert.equal(page.isClosed(), false);
  await page.waitForTimeout(400);
  const artifacts = path.resolve(root, "../../output/playwright/comment-exit");
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "retry-saving.png") });
  const dialog = page.getByRole("dialog", {
    name: "Comments couldn’t be saved",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("list", { name: "Files with unsaved comments" }),
  ).toContainText("notes.md");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  assert.equal(page.isClosed(), false);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Retry saving", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Retry saving", exact: true }),
  ).toBeEnabled();
  assert.equal(page.isClosed(), false);
  await app.evaluate(() => {
    globalThis.commentGate.fail = false;
  });
  await dialog
    .getByRole("button", { name: "Retry saving", exact: true })
    .click();
  await expect.poll(() => page.isClosed(), { timeout: 25000 }).toBe(true);
  await app.close();
  app = undefined;
  await launch();
  assert.equal(
    (await snapshot(uiProject)).files["notes.md"].find((c) => c.id === "human")
      .resolved,
    true,
  );
  console.log(
    "PASS Cancel retains window; failed retry stays open; successful retry saves and closes",
  );
  const slowProject = await seed("slow-ui");
  await open(slowProject);
  await app.evaluate(() => {
    globalThis.commentGate.hold = true;
  });
  await edit(slowProject, "edit");
  // Include source edits so the comment timer must also cover anchor synchronization.
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore
      .getState()
      .updateFileContent("notes.md", "Comment persistence fixture. Updated.\n");
  });
  const slowCloseAt = Date.now();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  const waiting = page.getByRole("dialog", {
    name: "Comments are taking longer to save",
  });
  await expect(waiting).toBeVisible({ timeout: 8_000 });
  await expect(
    waiting.getByRole("list", { name: "Files with unsaved comments" }),
  ).toContainText("notes.md");
  assert.ok(Date.now() - slowCloseAt >= 4_900);
  await page.screenshot({ path: path.join(artifacts, "slow-saving.png") });
  await waiting
    .getByRole("button", { name: "Keep waiting", exact: true })
    .click();
  await expect(waiting).not.toBeVisible();
  await expect(waiting).toBeVisible({ timeout: 8_000 });
  await waiting.getByRole("button", { name: "Cancel", exact: true }).click();
  await release();
  await page.evaluate(async () => await window.commentSave);
  await page.waitForTimeout(700);
  assert.equal(page.isClosed(), false);
  assert.equal(
    await fs.readFile(path.join(slowProject, "notes.md"), "utf8"),
    "Comment persistence fixture. Updated.\n",
  );
  console.log(
    "PASS slow dirty-source close shows choices after five seconds; Keep waiting preserves save; Cancel prevents late close",
  );
  await app.evaluate(() => {
    globalThis.commentGate.hold = true;
  });
  await edit(slowProject, "resolve");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await expect(waiting).toBeVisible({ timeout: 8_000 });
  await waiting
    .getByRole("button", { name: "Keep waiting", exact: true })
    .click();
  await release();
  await expect.poll(() => page.isClosed(), { timeout: 25_000 }).toBe(true);
  await app.close();
  app = undefined;
  await launch();
  verify(await snapshot(slowProject), "resolve");
  console.log(
    "PASS Keep waiting closes automatically when the original save completes",
  );
  const slowDiscard = await seed("slow-discard");
  await open(slowDiscard);
  await app.evaluate(() => {
    globalThis.commentGate.hold = true;
  });
  await edit(slowDiscard, "edit");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page
    .getByRole("dialog", { name: "Comments are taking longer to save" })
    .waitFor({ timeout: 8_000 });
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close anyway", exact: true })
    .click();
  await expect.poll(() => page.isClosed(), { timeout: 25_000 }).toBe(true);
  await app.close();
  app = undefined;
  await launch();
  console.log(
    "PASS Close anyway does not wait for a stalled native comment request",
  );
  const discardProject = await seed("discard-ui");
  await open(discardProject);
  await app.evaluate(() => {
    globalThis.commentGate.fail = true;
  });
  await edit(discardProject, "edit");
  await page.evaluate(async () => await window.commentSave);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close anyway", exact: true })
    .click();
  await expect.poll(() => page.isClosed(), { timeout: 25000 }).toBe(true);
  await app.close();
  app = undefined;
  await launch();
  const discarded = (await snapshot(discardProject)).files["notes.md"];
  assert.equal(discarded.length, 2);
  assert.ok(discarded.every((c) => c.text === `${c.id} before`));
  console.log(
    "PASS Close anyway closes despite comment failure and keeps previously saved comments",
  );
  for (const { project, action } of projects)
    verify(await snapshot(project), action);
  verify(await snapshot(failedProject), "edit");
  console.log("PASS all comment edits survive a full Electron restart");
} catch (error) {
  console.error("SMOKE FAILURE", error);
  throw error;
} finally {
  if (app) {
    await release().catch(() => {});
    await app.close();
  }
  await vite.close();
  console.log(`Artifacts/profile: ${profile}`);
}
