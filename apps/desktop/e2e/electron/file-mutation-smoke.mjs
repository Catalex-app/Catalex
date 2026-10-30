import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-file-mutations-"),
);
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
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
  app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.evaluate(async () => {
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish();
  });
  // Hold only the response to a real native operation. The original IPC handler
  // still performs filesystem rename or Electron shell.trashItem in full.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("desktop:invoke");
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      const result = await original(event, command, args);
      const gate = globalThis.mutationGate;
      if (
        gate &&
        command === gate.command &&
        (args.path ??
          args.fromPath ??
          `${args.projectRoot}/${args.change?.oldPath}`) === gate.path
      ) {
        gate.result = result;
        gate.reached = true;
        await gate.pending;
      }
      return result;
    });
  });
  for (const operation of [
    "delete file",
    "delete folder",
    "rename file",
    "rename folder",
  ]) {
    for (const mode of ["typing", "switch", "return"]) {
      const project = path.join(
        profile,
        `${operation.replaceAll(" ", "-")}-${mode}`,
      );
      const other = `${project}-other`;
      await fs.mkdir(path.join(project, "draft"), { recursive: true });
      await fs.mkdir(other);
      await fs.writeFile(path.join(project, "main.md"), "surviving source\n");
      await fs.writeFile(
        path.join(project, "draft", "note.md"),
        "target source\n",
      );
      await fs.writeFile(path.join(other, "main.md"), "other project\n");
      await page.evaluate(async (project) => {
        const { useDocumentStore: store } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        await store.getState().openProject(project);
        store.getState().setActiveFile("main.md");
      }, project);
      const target = operation.endsWith("folder") ? "draft" : "draft/note.md";
      await app.evaluate(
        (_electron, { command, target }) => {
          let release;
          const pending = new Promise((resolve) => {
            release = resolve;
          });
          globalThis.mutationGate = {
            command,
            path: target,
            release,
            pending,
            reached: false,
          };
        },
        {
          command: operation.startsWith("delete")
            ? "desktop:shell:trash"
            : "rename_project_path",
          target: path.join(project, target),
        },
      );
      await page.evaluate(async (operation) => {
        const { useDocumentStore: store } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        globalThis.mutationDone = false;
        const state = store.getState();
        const pending =
          operation === "delete file"
            ? state.deleteFile("draft/note.md")
            : operation === "delete folder"
              ? state.deleteFolder("draft")
              : operation === "rename file"
                ? state.renameFile("draft/note.md", "renamed.md")
                : state.renameFolder("draft", "renamed");
        globalThis.mutationPromise = pending.then(() => {
          globalThis.mutationDone = true;
        });
      }, operation);
      await expect
        .poll(() => app.evaluate(() => globalThis.mutationGate.reached))
        .toBe(true);
      const response = await app.evaluate(() => globalThis.mutationGate.result);
      assert.equal(response.error, undefined, JSON.stringify(response));
      await assert.rejects(fs.stat(path.join(project, target)), {
        code: "ENOENT",
      });
      if (operation.startsWith("rename")) {
        const renamed = operation.endsWith("folder")
          ? "renamed/note.md"
          : "draft/renamed.md";
        assert.equal(
          await fs.readFile(path.join(project, renamed), "utf8"),
          "target source\n",
        );
      }
      if (mode === "typing") {
        const editor = page
          .locator('.cm-content[contenteditable="true"]')
          .first();
        await editor.click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.insertText("typed while native reply waits");
      } else {
        // Actual project navigation must drain the operation before clearing
        // buffers. Verify both one-way navigation and opening the source again.
        await page.evaluate(async (other) => {
          const { useDocumentStore: store } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          globalThis.switchDone = false;
          globalThis.switchPromise = store
            .getState()
            .openProject(other)
            .then(() => {
              globalThis.switchDone = true;
            });
        }, other);
        assert.equal(await page.evaluate(() => globalThis.switchDone), false);
      }
      await app.evaluate(() => {
        globalThis.mutationGate.release();
        globalThis.mutationGate = null;
      });
      await page.evaluate(() => globalThis.mutationPromise);
      if (mode === "typing") {
        const contents = await page.evaluate(async () => {
          const { useDocumentStore: store } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          const content = store
            .getState()
            .files.find((file) => file.id === "main.md").content;
          await store.getState().saveAllFiles({ requireClean: true });
          return content;
        });
        assert.match(contents, /typed while native reply waits/);
        assert.equal(
          await fs.readFile(path.join(project, "main.md"), "utf8"),
          contents,
        );
        const artifacts = path.resolve(root, "../../output/playwright");
        await fs.mkdir(artifacts, { recursive: true });
        await page.screenshot({
          path: path.join(
            artifacts,
            `mutation-${operation.replaceAll(" ", "-")}.png`,
          ),
        });
      } else {
        await page.evaluate(() => globalThis.switchPromise);
        if (mode === "return") {
          await page.evaluate(async (project) => {
            const { useDocumentStore: store } = await import(
              "/src/renderer/stores/document-store.ts"
            );
            await store.getState().openProject(project);
          }, project);
        }
        const state = await page.evaluate(async () => {
          const { useDocumentStore: store } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          return {
            root: store.getState().projectRoot,
            files: store.getState().files.map((file) => file.id),
          };
        });
        assert.equal(state.root, mode === "return" ? project : other);
        if (mode === "switch") assert.deepEqual(state.files, ["main.md"]);
        else assert.equal(state.files.includes("draft/note.md"), false);
      }
      console.log(`PASS ${operation}: ${mode}`);
    }
  }
  console.log(
    `Native filesystem/Trash checks passed; temporary profile: ${profile}`,
  );
} finally {
  if (app) {
    await app.evaluate(() => globalThis.mutationGate?.release());
    await app.close();
  }
  await vite.close();
}
