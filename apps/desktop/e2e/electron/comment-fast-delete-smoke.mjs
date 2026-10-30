import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-fast-delete-"),
);
const project = path.join(profile, "Project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/comment-fast-delete",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(project, "notes.md"),
  "Sample paragraph for comment review.\n",
);
const vite = await createServer({
  root: desktopRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
try {
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = async () => {
    app = await electron.launch({ args: [desktopRoot], env });
    const page = await app.firstWindow();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.evaluate(() =>
      localStorage.setItem(
        "catalex-onboarding",
        JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
      ),
    );
    await page.reload();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    return page;
  };
  let page = await launch();
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.fastCommentGate = { hold: false, release: null, blocked: false };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      const gate = globalThis.fastCommentGate;
      if (
        gate.hold &&
        command.startsWith("update_project_comment") &&
        !args.patch?.before
      ) {
        gate.hold = false;
        gate.blocked = true;
        await new Promise((resolve) => {
          gate.release = resolve;
        });
      }
      return handler(event, command, args);
    });
  });
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
    const file = useDocumentStore
      .getState()
      .files.find((f) => f.relativePath === "notes.md");
    useDocumentStore.getState().setActiveFile(file.id);
  }, project);
  const flush = () =>
    page.evaluate(async (root) => {
      const { flushProjectCommentWrites, getUnsavedCommentFiles } =
        await import(
          "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
        );
      await flushProjectCommentWrites(root);
      return getUnsavedCommentFiles(root);
    }, project);
  for (const delayed of [true, false]) {
    if (delayed)
      await app.evaluate(() => {
        globalThis.fastCommentGate.hold = true;
      });
    const content = page.locator(".cm-editor .cm-content").first();
    await content.focus();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.press("Shift+End");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page
      .locator(".cm-inlineCommentEditor")
      .fill(delayed ? "Quickly deleted" : "Deleted after acknowledgement")
      .catch(async (error) => {
        await page.screenshot({
          path: path.join(artifacts, "create-failed.png"),
        });
        console.log(
          await page.evaluate(async () => {
            const { EditorView } = await import("/@id/@codemirror/view");
            const view = EditorView.findFromDOM(
              document.querySelector(".cm-content"),
            );
            return {
              selection: view?.state.selection.main.toJSON(),
              text: view?.state.doc.toString(),
              notices: [
                ...document.querySelectorAll("[data-sonner-toast]"),
              ].map((n) => n.textContent),
            };
          }),
        );
        throw error;
      });
    await page
      .getByRole("button", { name: "Save comment", exact: true })
      .click();
    if (delayed) {
      await expect
        .poll(() => app.evaluate(() => globalThis.fastCommentGate.blocked))
        .toBe(true);
    } else {
      assert.deepEqual(await flush(), []);
      await expect(page.locator(".cm-inlineCommentCard")).toContainText("H-2");
    }
    if (delayed) {
      await expect(
        page.getByRole("status", { name: "Saving comment", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete comment", exact: true }),
      ).toBeDisabled();
      await expect(page.locator(".cm-inlineCommentCard")).not.toHaveClass(
        /cm-inlineCommentCardTransitioning/,
      );
      await page.screenshot({
        path: path.join(artifacts, "saving.png"),
        animations: "disabled",
      });
      await app.evaluate(() => globalThis.fastCommentGate.release());
    }
    await page
      .getByRole("button", { name: "Delete comment", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Confirm delete comment", exact: true })
      .click();
    await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
    assert.deepEqual(await flush(), []);
    await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
    await expect(page.getByText(/Comment changes were not saved/)).toHaveCount(
      0,
    );
    const files = await page.evaluate(async (projectRoot) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke("read_project_comments", { projectRoot });
    }, project);
    assert.ok(Object.values(files).every((comments) => comments.length === 0));
    console.log(
      `PASS save/delete ${delayed ? "with delayed" : "after"} first-save acknowledgement, no resurrection or pending writes`,
    );
  }
  await page.screenshot({ path: path.join(artifacts, "deleted.png") });
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .first()
    .click();
  await expect(
    page.getByTestId("welcome-new-project-menu-trigger"),
  ).toBeVisible();
  await app.close();
  app = undefined;
  page = await launch();
  const files = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("read_project_comments", { projectRoot });
  }, project);
  assert.ok(Object.values(files).every((comments) => comments.length === 0));
  console.log(
    "PASS project closes and deletion survives full Electron restart",
  );
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
