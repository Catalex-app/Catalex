import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-races-"),
);
const project = path.join(profile, "Project");
const artifacts = path.resolve(root, "../../output/playwright/comment-races");
const cases = [
  "edit-delete",
  "resolve-undo",
  "delete-undo",
  "type-delete",
  "save-retry",
  "markdown-preview",
  "lost-ack",
];
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
for (const name of cases)
  await fs.writeFile(
    path.join(project, `${name}.md`),
    "Sample paragraph for comment review.\n\nAnother paragraph.\n",
  );
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
let page;
const errors = [];
try {
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  async function launch() {
    app = await electron.launch({ args: [root], env });
    page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1400, 1000),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.evaluate(async () =>
      (
        await import("/src/renderer/stores/onboarding-store.ts")
      ).useOnboardingStore
        .getState()
        .finish(),
    );
  }
  await launch();
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.raceGate = {
      hold: false,
      fail: false,
      blocked: false,
      release: null,
      loseReply: false,
      holdReadRoot: null,
      readBlocked: false,
      releaseRead: null,
    };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      if (command === "race_external_update")
        return handler(event, "update_project_comment", args);
      if (
        [
          "update_project_comment",
          "update_project_comment_anchored",
          "update_project_comment_anchors",
        ].includes(command)
      ) {
        const gate = globalThis.raceGate;
        if (gate.hold) {
          gate.hold = false;
          gate.blocked = true;
          await new Promise((resolve) => {
            gate.release = resolve;
          });
        }
        if (gate.fail) throw new Error("Fixture storage unavailable");
      }
      const result = await handler(event, command, args);
      const gate = globalThis.raceGate;
      if (
        command === "read_project_comments_anchored" &&
        args.projectRoot === gate.holdReadRoot
      ) {
        gate.holdReadRoot = null;
        gate.readBlocked = true;
        await new Promise((resolve) => {
          gate.releaseRead = resolve;
        });
      }
      if (
        globalThis.raceGate.loseReply &&
        command.startsWith("update_project_comment")
      ) {
        globalThis.raceGate.loseReply = false;
        throw new Error("Fixture lost save acknowledgement");
      }
      return result;
    });
  });
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(projectRoot);
  }, project);
  const content = () => page.locator(".cm-editor .cm-content").first();
  const card = () => page.locator(".cm-inlineCommentCard").first();
  const flush = () =>
    page.evaluate(async (projectRoot) => {
      const storage = await import(
        "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
      );
      await storage.flushProjectCommentWrites(projectRoot);
      return storage.getUnsavedCommentFiles(projectRoot);
    }, project);
  const snapshot = () =>
    page.evaluate(
      async (projectRoot) =>
        (await import("/src/renderer/lib/desktop/core.ts")).invoke(
          "read_project_comments",
          { projectRoot },
        ),
      project,
    );
  const hold = () =>
    app.evaluate(() =>
      Object.assign(globalThis.raceGate, { hold: true, blocked: false }),
    );
  const blocked = () =>
    expect
      .poll(() => app.evaluate(() => globalThis.raceGate.blocked))
      .toBe(true);
  const release = () => app.evaluate(() => globalThis.raceGate.release());
  async function create(text) {
    await content().focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+End");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator(".cm-inlineCommentEditor").fill(text);
    await page
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
  }
  async function action(name) {
    await card()
      .getByRole("button", {
        name: `${name === "delete" ? "Delete" : "Resolve"} comment`,
        exact: true,
      })
      .click();
    await card()
      .getByRole("button", { name: `Confirm ${name} comment`, exact: true })
      .click();
    await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
  }
  async function undo(redo = false) {
    await content().focus();
    await page.keyboard.press(
      redo ? "ControlOrMeta+Shift+z" : "ControlOrMeta+z",
    );
  }
  const expected = {};
  for (const name of cases) {
    await page.evaluate(async (filePath) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.relativePath === filePath);
      useDocumentStore.getState().setActiveFile(file.id);
    }, `${name}.md`);
    await expect(content()).toContainText("Sample paragraph");
    if (["edit-delete", "resolve-undo", "save-retry"].includes(name))
      await hold();
    if (name === "lost-ack")
      await app.evaluate(() => {
        globalThis.raceGate.loseReply = true;
      });
    if (name === "markdown-preview") {
      const preview = page.frameLocator(`iframe[title="${name}.md preview"]`);
      const paragraph = preview.locator("p [data-comment-start]").first();
      await expect(paragraph).toHaveText(
        "Sample paragraph for comment review.",
      );
      await paragraph.evaluate((element) => {
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element.firstChild);
        const selection = element.ownerDocument.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const input = page.getByRole("textbox", {
        name: "Comment text",
        exact: true,
      });
      await expect(input).toBeFocused();
      await expect(input).toHaveCount(1);
      await expect(
        page.getByRole("dialog", { name: "PDF comment", exact: true }),
      ).toHaveCount(0);
      await input.fill(`Original ${name}`);
      await page
        .getByRole("button", { name: "Save comment", exact: true })
        .click();
    } else await create(`Original ${name}`);
    if (["edit-delete", "resolve-undo", "save-retry"].includes(name))
      await blocked();
    else if (name !== "lost-ack") assert.deepEqual(await flush(), []);
    if (name === "edit-delete") {
      await expect(
        card().getByRole("status", { name: "Saving comment", exact: true }),
      ).toBeVisible();
      await expect(
        card().getByRole("button", { name: "Delete comment", exact: true }),
      ).toBeDisabled();
      await release();
      assert.deepEqual(await flush(), []);
      await card()
        .getByRole("button", { name: "Edit comment", exact: true })
        .click();
      await card().locator("textarea").fill("Updated after creation is saved");
      await hold();
      await card()
        .getByRole("button", { name: "Save comment", exact: true })
        .click();
      await blocked();
      await expect(
        card().getByRole("button", { name: "Delete comment", exact: true }),
      ).toBeDisabled();
      await release();
      await action("delete");
    } else if (name === "resolve-undo") {
      await expect(
        card().getByRole("status", { name: "Saving comment", exact: true }),
      ).toBeVisible();
      await release();
      assert.deepEqual(await flush(), []);
      await hold();
      await action("resolve");
      await blocked();
      await undo();
      await release();
      await expect(card()).toBeVisible();
    } else if (name === "delete-undo") {
      await hold();
      await action("delete");
      await blocked();
      await undo();
      await release();
      await expect(card()).toBeVisible();
    } else if (name === "type-delete") {
      await hold();
      await content().focus();
      await page.keyboard.press("ControlOrMeta+Home");
      await page.keyboard.insertText("Prefix ");
      await blocked();
      await action("delete");
      await release();
    } else if (name === "save-retry") {
      await app.evaluate(() => {
        globalThis.raceGate.fail = true;
      });
      await release();
      await expect(
        page.getByText(/Comment changes were not saved/),
      ).toBeVisible();
      await card()
        .getByRole("button", { name: "Edit comment", exact: true })
        .click();
      await card().locator("textarea").fill("Edited after failed creation");
      await card()
        .getByRole("button", { name: "Save comment", exact: true })
        .click();
      await expect(
        page.getByText(/Comment changes were not saved/),
      ).toBeVisible();
      // Let notification entrance motion settle for the audit screenshot.
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(artifacts, "01-failed-save.png"),
      });
      await app.evaluate(() => {
        globalThis.raceGate.fail = false;
      });
      await page
        .getByRole("button", { name: "Retry saving", exact: true })
        .click();
    } else if (name === "lost-ack") {
      await expect(
        page.getByText(/Comment changes were not saved/),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Retry saving", exact: true })
        .click();
    }
    assert.deepEqual(await flush(), []);
    const comments = (await snapshot())[`${name}.md`] ?? [];
    if (["edit-delete", "type-delete"].includes(name)) {
      assert.deepEqual(comments, []);
      await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
    } else {
      assert.equal(comments.length, 1);
      assert.equal(
        comments[0].text,
        name === "save-retry"
          ? "Edited after failed creation"
          : `Original ${name}`,
      );
      assert.equal(Boolean(comments[0].resolved), false);
      assert.ok(comments[0].number > 0);
      assert.ok(comments[0].anchorRevision);
      await expect(card()).toContainText(comments[0].text);
    }
    await expect(page.getByText(/Comment changes were not saved/)).toHaveCount(
      0,
    );
    expected[`${name}.md`] = comments;
    await page.screenshot({ path: path.join(artifacts, `${name}.png`) });
    console.log(`PASS ${name}: visible state, saved record, empty queue`);
  }
  // Two independently submitted native writes: one changes text, the other status.
  const remoteUpdate = (filePath, before, after) =>
    page.evaluate(
      async (args) =>
        (await import("/src/renderer/lib/desktop/core.ts")).invoke(
          "race_external_update",
          args,
        ),
      {
        projectRoot: project,
        patch: { filePath, id: before.id, before, after },
      },
    );
  const edit = async (text) => {
    await card()
      .getByRole("button", { name: "Edit comment", exact: true })
      .click();
    await card().locator("textarea").fill(text);
    await card()
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
  };
  const independentBefore = expected["lost-ack.md"][0];
  await hold();
  await edit("Human edit during remote resolution");
  await blocked();
  await remoteUpdate("lost-ack.md", independentBefore, {
    ...independentBefore,
    resolved: true,
  });
  await release();
  assert.deepEqual(await flush(), []);
  expected["lost-ack.md"] = (await snapshot())["lost-ack.md"];
  assert.equal(
    expected["lost-ack.md"][0].text,
    "Human edit during remote resolution",
  );
  assert.equal(expected["lost-ack.md"][0].resolved, true);
  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
  console.log("PASS concurrent text/status writes preserve both changes");
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .first()
    .click();
  await expect(
    page.getByTestId("welcome-new-project-menu-trigger"),
  ).toBeVisible();

  // Exercise both deliberate recovery choices against actual concurrent native writes.
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(projectRoot);
    const file = useDocumentStore
      .getState()
      .files.find((f) => f.relativePath === "save-retry.md");
    useDocumentStore.getState().setActiveFile(file.id);
  }, project);
  await expect(card()).toContainText("Edited after failed creation");
  const conflictingBefore = (await snapshot())["save-retry.md"][0];
  await hold();
  await edit("Unsaved local conflict text");
  await blocked();
  await remoteUpdate("save-retry.md", conflictingBefore, {
    ...conflictingBefore,
    text: "Newer external conflict text",
  });
  await release();
  await assert.rejects(flush(), /comment_conflict/);
  await expect(card()).toContainText("Unsaved local conflict text");
  await expect(
    page.getByRole("button", { name: "Keep mine", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(artifacts, "conflict-choices.png") });
  await page
    .locator('[data-sonner-toast][data-front="true"]')
    .filter({ hasText: "Comment changed elsewhere" })
    .screenshot({ path: path.join(artifacts, "conflict-toast.png") });
  await page.getByRole("button", { name: "Keep mine", exact: true }).click();
  assert.deepEqual(await flush(), []);
  await expect(card()).toContainText("Unsaved local conflict text");
  assert.equal(
    (await snapshot())["save-retry.md"][0].text,
    "Unsaved local conflict text",
  );
  console.log(
    "PASS Keep mine: deliberate conflict resolution saves local text",
  );
  const secondBefore = (await snapshot())["save-retry.md"][0];
  await hold();
  await edit("Discard this conflicting local change");
  await blocked();
  await remoteUpdate("save-retry.md", secondBefore, {
    ...secondBefore,
    text: "Keep this stored version",
  });
  await release();
  await assert.rejects(flush(), /comment_conflict/);
  await page.getByRole("button", { name: "Use stored", exact: true }).click();
  assert.deepEqual(await flush(), []);
  await expect(card()).toContainText("Keep this stored version");
  expected["save-retry.md"] = (await snapshot())["save-retry.md"];
  assert.equal(expected["save-retry.md"][0].text, "Keep this stored version");
  await page.screenshot({
    path: path.join(artifacts, "conflict-resolved.png"),
  });
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .first()
    .click();
  await expect(
    page.getByTestId("welcome-new-project-menu-trigger"),
  ).toBeVisible();
  console.log(
    "PASS Use stored: pending edit discarded, UI agrees, normal project close succeeds",
  );
  const reopenedProject = path.join(profile, "Delayed read project");
  await fs.mkdir(reopenedProject);
  await fs.writeFile(
    path.join(reopenedProject, "old.md"),
    "Sample paragraph.\n",
  );
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("update_project_comment", {
      projectRoot,
      patch: {
        filePath: "old.md",
        id: "delayed-reopen",
        before: null,
        after: {
          id: "delayed-reopen",
          from: 0,
          to: 6,
          line: 1,
          text: "Relinked feedback",
        },
      },
    });
  }, reopenedProject);
  await fs.rename(
    path.join(reopenedProject, "old.md"),
    path.join(reopenedProject, "new.md"),
  );
  await app.evaluate((_electron, projectRoot) => {
    globalThis.raceGate.holdReadRoot = projectRoot;
  }, reopenedProject);
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(projectRoot);
    useDocumentStore.getState().setActiveFile("new.md");
  }, reopenedProject);
  await expect
    .poll(() => app.evaluate(() => globalThis.raceGate.readBlocked))
    .toBe(true);
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await useDocumentStore.getState().closeProject();
    await invoke("manage_comment_files", {
      projectRoot,
      selection: [
        { path: "old.md", disconnected: true, ids: ["delayed-reopen"] },
      ],
      author: "all",
      action: "relink",
      target: "new.md",
      preview: false,
    });
    await useDocumentStore.getState().openProject(projectRoot);
    useDocumentStore.getState().setActiveFile("new.md");
  }, reopenedProject);
  const reopenedCard = page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="delayed-reopen"]')
    .first();
  await expect(reopenedCard).toContainText("Relinked feedback");
  await app.evaluate(() => {
    globalThis.raceGate.releaseRead();
    globalThis.raceGate.releaseRead = null;
    globalThis.raceGate.readBlocked = false;
  });
  await page.waitForTimeout(500);
  assert.equal(
    await page.evaluate(async (projectRoot) => {
      const { isCommentDetached } = await import(
        "/src/renderer/components/workspace/editor/comment-paths.ts"
      );
      return isCommentDetached(projectRoot, "delayed-reopen");
    }, reopenedProject),
    false,
  );
  await expect(reopenedCard).toContainText("Relinked feedback");
  console.log(
    "PASS delayed snapshot: project reopen reads fresh data and late orphan metadata is discarded",
  );
  await app.evaluate(({ app }) => app.exit(0));
  await app.close().catch(() => {});
  app = undefined;
  await launch();
  const persisted = await snapshot();
  for (const [filePath, comments] of Object.entries(expected))
    assert.deepEqual(persisted[filePath] ?? [], comments);
  assert.deepEqual(errors, []);
  console.log(
    "PASS full restart: all scenario records unchanged, no renderer errors",
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
