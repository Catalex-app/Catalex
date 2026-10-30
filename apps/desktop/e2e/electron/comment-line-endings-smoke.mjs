import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-line-endings-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(project);
const source = "😀 Intro\nselected sentence.\nEnd\n";
const disk = (text) => text.replace(/\n/g, "\r\n");
const file = path.join(project, "notes.md");
await fs.writeFile(file, disk(source));
const vite = await createServer({
  root: desktopRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
let page;
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
    page = await app.firstWindow();
    page.on("pageerror", (error) => console.error(error));
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.evaluate(() =>
      localStorage.setItem(
        "catalex-onboarding",
        JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
      ),
    );
    await page.reload();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.evaluate(async (root) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await useDocumentStore.getState().openProject(root);
      useDocumentStore.getState().setActiveFile("notes.md");
    }, project);
    await expect(page.locator(".cm-editor .cm-content").first()).toBeVisible();
  };
  const snapshot = () =>
    page.evaluate(async (root) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke("read_project_comments_anchored", { projectRoot: root });
    }, project);
  const flush = () =>
    page.evaluate(async (root) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { flushProjectCommentWrites } = await import(
        "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
      );
      await flushProjectCommentWrites(root);
      await useDocumentStore.getState().saveFile("notes.md");
    }, project);
  const text = () =>
    page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      return useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === "notes.md")?.content;
    });
  await launch();
  assert.equal(await text(), source);
  await page.evaluate(async () => {
    const { EditorView } = await import("/@id/@codemirror/view");
    const view = EditorView.findFromDOM(document.querySelector(".cm-content"));
    view.dispatch({ selection: { anchor: 9, head: 17 } });
    view.focus();
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page
    .locator(".cm-inlineCommentEditor")
    .fill("CRLF range stays on selected");
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete comment", exact: true }),
  ).toBeEnabled();
  await flush();
  let loaded = await snapshot();
  const commentId = loaded.files["notes.md"][0].id;
  assert.deepEqual(
    [loaded.files["notes.md"][0].from, loaded.files["notes.md"][0].to],
    [9, 17],
  );
  assert.ok(
    Object.values(loaded.sources).every((value) => !value.includes("\r")),
  );
  assert.equal(await fs.readFile(file, "utf8"), disk(source));
  await page.evaluate(async () => {
    const { EditorView } = await import("/@id/@codemirror/view");
    EditorView.findFromDOM(document.querySelector(".cm-content")).dispatch({
      changes: { from: 0, insert: "x\n" },
    });
  });
  await flush();
  assert.equal(await fs.readFile(file, "utf8"), disk(`x\n${source}`));
  await expect
    .poll(async () => (await snapshot()).files["notes.md"][0].from)
    .toBe(11);
  await app.close();
  await launch();
  await expect(page.locator(".cm-inlineCommentCard")).toContainText(
    "CRLF range",
  );
  assert.equal(await text(), `x\n${source}`);
  loaded = await snapshot();
  assert.equal(loaded.files["notes.md"][0].id, commentId);
  assert.deepEqual(
    [loaded.files["notes.md"][0].from, loaded.files["notes.md"][0].to],
    [11, 19],
  );
  const external = `Disk\nx\n${source}`;
  await fs.writeFile(file, disk(external));
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { synchronizeProjectCommentAnchors } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    await useDocumentStore.getState().refreshExternalFiles(["notes.md"]);
    await synchronizeProjectCommentAnchors(root);
  }, project);
  await expect.poll(text).toBe(external);
  await expect
    .poll(async () => (await snapshot()).files["notes.md"][0].from)
    .toBe(16);
  // The native revision remains raw-byte guarded while proposal coordinates use LF.
  await page.evaluate(
    async ({ root, before }) => {
      const { useProposedChangesStore } = await import(
        "/src/renderer/stores/proposed-changes-store.ts"
      );
      useProposedChangesStore.getState().addChange({
        id: "crlf-review",
        filePath: "notes.md",
        absolutePath: `${root}/notes.md`,
        oldContent: before.replace(/\n/g, "\r\n"),
        newContent: `Review\n${before}`.replace(/\n/g, "\r\n"),
        toolName: "Write",
      });
    },
    { root: project, before: external },
  );
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
  await flush();
  assert.equal(await fs.readFile(file, "utf8"), disk(`Review\n${external}`));
  await expect
    .poll(async () => (await snapshot()).files["notes.md"][0].from)
    .toBe(23);
  await page.locator(".cm-editor .cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).toBe(external);
  await flush();
  await expect
    .poll(async () => (await snapshot()).files["notes.md"][0].from)
    .toBe(16);
  assert.equal(await fs.readFile(file, "utf8"), disk(external));

  const session = await page.evaluate(async (root) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("prepare_agent_workspace", {
      projectRoot: root,
      tabId: "line-ending-review",
      sharedSessionId: null,
      mode: "ask",
      dirtyBuffers: [],
    });
  }, project);
  await fs.writeFile(
    path.join(session.candidateRoot, "notes.md"),
    disk(external.replace("selected", "se")),
  );
  await page.evaluate(
    async ({ root, session }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const { useAgentReviewQueueStore } = await import(
        "/src/renderer/stores/agent-review-queue-store.ts"
      );
      const preview = await invoke("preview_agent_workspace", {
        projectRoot: root,
        sessionId: session.sessionId,
        decisions: [],
      });
      useAgentReviewQueueStore.setState({
        entries: [{ session, phase: "review", preview, conflicts: [] }],
      });
      await useAgentReviewQueueStore.getState().show(session.sessionId);
    },
    { root: project, session },
  );
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  // Hold post-acceptance reads at native IPC: undo must use the accepted text's
  // mapped anchors even before the normal background comment refresh returns.
  await app.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.reviewReadGate = {
      hold: false,
      holdSource: false,
      waiting: [],
      sourceWaiting: [],
      blocked: 0,
      blockedSource: 0,
    };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      const gate = globalThis.reviewReadGate;
      if (
        gate.holdSource &&
        command === "desktop:fs:readTextFile" &&
        args.path.endsWith("/Project/notes.md")
      ) {
        gate.blockedSource++;
        await new Promise((resolve) => gate.sourceWaiting.push(resolve));
      }
      if (gate.hold && command === "read_project_comments_anchored") {
        gate.blocked++;
        await new Promise((resolve) => gate.waiting.push(resolve));
      }
      const result = await handler(event, command, args);
      if (command === "apply_agent_workspace" && result.result?.applied) {
        gate.hold = true;
        gate.holdSource = true;
      }
      return result;
    });
  });
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect
    .poll(() => app.evaluate(() => globalThis.reviewReadGate.blockedSource))
    .toBeGreaterThan(0);
  await expect(page.locator(".cm-editor .cm-content").first()).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await app.evaluate(() => {
    globalThis.reviewReadGate.holdSource = false;
    globalThis.reviewReadGate.sourceWaiting
      .splice(0)
      .forEach((resolve) => resolve());
  });
  await page.waitForFunction(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const doc = useDocumentStore.getState();
    return (
      !doc.agentWorkspaceRoot &&
      doc.files
        .find((file) => file.relativePath === "notes.md")
        ?.content.includes("se sentence.")
    );
  });
  await expect
    .poll(() => app.evaluate(() => globalThis.reviewReadGate.blocked))
    .toBeGreaterThan(0);
  await page.locator(".cm-editor .cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(text).toBe(external);
  const immediate = await page.evaluate(async () => {
    const { EditorView } = await import("/@id/@codemirror/view");
    const { readCommentDocument } = await import(
      "/src/renderer/components/workspace/editor/inline-comments.ts"
    );
    return readCommentDocument(
      EditorView.findFromDOM(document.querySelector(".cm-content")).state,
    )?.comments;
  });
  assert.deepEqual(
    immediate.map(({ from, to }) => [from, to]),
    [[16, 24]],
  );
  await app.evaluate(() => {
    globalThis.reviewReadGate.hold = false;
    globalThis.reviewReadGate.waiting.splice(0).forEach((resolve) => resolve());
  });
  await flush();
  await expect
    .poll(async () => (await snapshot()).files["notes.md"][0].to)
    .toBe(24);
  assert.equal(await fs.readFile(file, "utf8"), disk(external));
  console.log(
    "CRLF Electron checks passed: source selection, save, native coordinates, external edit, review/undo, full restart, and immediate undo after candidate handoff with delayed comment reads.",
  );
} finally {
  await app
    ?.evaluate(() => {
      if (globalThis.reviewReadGate) {
        globalThis.reviewReadGate.hold = false;
        globalThis.reviewReadGate.holdSource = false;
        globalThis.reviewReadGate.sourceWaiting
          .splice(0)
          .forEach((resolve) => resolve());
        globalThis.reviewReadGate.waiting
          .splice(0)
          .forEach((resolve) => resolve());
      }
    })
    .catch(() => {});
  await app?.close().catch(() => {});
  await vite.close();
}
