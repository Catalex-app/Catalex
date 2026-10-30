import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-undo-"),
);
const project = path.join(profile, "Project");
const artifacts = path.join(
  desktopRoot,
  "../../output/playwright/comment-undo-electron",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(project, "notes.md"),
  "Sample paragraph for comment review.\n",
);
await fs.writeFile(
  path.join(project, "other.md"),
  "Another document to review.\n",
);
const original = {
  id: "agent-one",
  number: 1,
  from: 0,
  to: 6,
  line: 1,
  text: "Original agent feedback",

  resolved: false,
  origin: { provider: "codex", sessionId: "fixture-chat", model: "Fixture" },
};
let app;
let vite;
try {
  vite = await createServer({
    root: desktopRoot,
    configFile: path.join(desktopRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const open = async () => {
    app = await electron.launch({ args: [desktopRoot], env });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => console.error("Renderer:", error.message));
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    // Workspace tests use a fresh profile; onboarding has separate coverage.
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
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.relativePath === "notes.md");
      useDocumentStore.getState().setActiveFile(file.id);
    }, project);
    return page;
  };
  let page = await open();
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("read_project_comments", { projectRoot });
  }, project);
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
  const commentFile = path.join(
    profile,
    "data",
    "projects",
    entry.id,
    "comments",
    "agent.json",
  );
  await writeCommentFixture(
    commentFile,
    JSON.stringify({
      version: 1,
      counter: 1,
      files: { "notes.md": [original] },
      sources: {},
    }),
  );
  await page.evaluate(
    (projectRoot) =>
      window.dispatchEvent(
        new CustomEvent("catalex:project-comments-refresh", {
          detail: { projectRoot },
        }),
      ),
    project,
  );

  const content = () => page.locator(".cm-editor .cm-content").first();
  await expect(content()).toContainText("paragraph for comment review.");
  const readComment = async () =>
    JSON.parse(await readCommentFixture(commentFile)).files["notes.md"]?.[0];
  const change = async (after) =>
    page.evaluate(
      async ({ root, after }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const files = await invoke("read_project_comments", {
          projectRoot: root,
        });
        const before = files["notes.md"][0];
        await invoke("update_project_comment", {
          projectRoot: root,
          patch: {
            filePath: "notes.md",
            id: before.id,
            before,
            after: after && { ...before, ...after },
          },
        });
      },
      { root: project, after },
    );
  // A partial selection deletion loses a boundary unless text undo carries the
  // anchor inverse. Verify the restored range also reaches the native database.
  await expect(page.locator(".cm-inlineCommentCard").first()).toBeVisible();
  await content().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Backspace");
  await expect
    .poll(async () => {
      const comment = await readComment();
      return [comment.from, comment.to];
    })
    .toEqual([0, 4]);
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(async () => {
        const comment = await readComment();
        return [comment.from, comment.to];
      })
      .toEqual([original.from, original.to]);
    if (i === 0) {
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect.poll(async () => (await readComment()).to).toBe(4);
    }
  }
  // An accepted proposal rebuilds history outside the visible editor. Its text
  // and anchors must undo together, including the native persisted ranges.
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useProposedChangesStore } = await import(
      "/src/renderer/stores/proposed-changes-store.ts"
    );
    const file = useDocumentStore
      .getState()
      .files.find((file) => file.relativePath === "notes.md");
    useProposedChangesStore.getState().addChange({
      id: "comment-anchor-review",
      filePath: "notes.md",
      absolutePath: `${root}/notes.md`,
      oldContent: file.content,
      newContent: "Replacement manuscript.\n",
      toolName: "Write",
    });
  }, project);
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
  const sourceText = () =>
    page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      return useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === "notes.md")?.content;
    });
  await expect.poll(sourceText).toBe("Replacement manuscript.\n");
  await expect.poll(async () => (await readComment())?.id).toBe(original.id);
  await content().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(sourceText)
    .toContain("Sample paragraph for comment review.");
  await expect
    .poll(async () => {
      const comment = await readComment();
      return [comment.from, comment.to];
    })
    .toEqual([original.from, original.to]);
  // Exercise a real pointer resize through Electron IPC and the Rust sidecar.
  await page.locator(".cm-inlineCommentCard").first().click();
  await page
    .locator(".cm-scroller")
    .first()
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  const handle = page
    .locator(".cm-editor")
    .getByRole("button", { name: "Resize comment end" });
  await page.screenshot({ path: path.join(artifacts, "before-resize.png") });
  await handle.hover();
  const endpoint = await page.evaluate(async () => {
    const line = document.querySelector(".cm-line");
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement.closest(
          ".cm-inlineCommentCard, .cm-inlineCommentSuperscript",
        )
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    let remaining = 16;
    let node;
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) break;
      remaining -= node.length;
    }
    const range = document.createRange();
    range.setStart(node, remaining);
    range.collapse(true);
    const rect = range.getBoundingClientRect();
    return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
  });
  const handleBox = await handle.boundingBox();
  await page.mouse.move(
    handleBox.x + handleBox.width / 2,
    handleBox.y + handleBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(endpoint.x, endpoint.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await readComment()).to).toBe(16);
  await page.screenshot({ path: path.join(artifacts, "resized-comment.png") });
  await content().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await readComment()).to).toBe(original.to);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await readComment()).to).toBe(16);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await readComment()).to).toBe(original.to);

  await content().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("Test ");
  await expect.poll(async () => (await readComment()).from).toBe(5);
  await change({ text: "Updated feedback" });
  await expect
    .poll(async () => (await readComment()).text)
    .toBe("Updated feedback");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await readComment()).text).toBe(original.text);
  await expect(content()).toContainText("Test Sample");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content()).not.toContainText("Test Sample");
  await expect.poll(async () => (await readComment()).from).toBe(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect
    .poll(async () => (await readComment()).text)
    .toBe("Updated feedback");
  for (const after of [{ resolved: true }, null]) {
    await change(after);
    await expect
      .poll(async () =>
        after ? (await readComment())?.resolved : !(await readComment()),
      )
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await readComment())?.resolved).toBe(false);
    assert.deepEqual((await readComment()).origin, original.origin);
    assert.equal((await readComment()).number, original.number);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect
      .poll(async () =>
        after ? (await readComment())?.resolved : !(await readComment()),
      )
      .toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await readComment())?.resolved).toBe(false);
  }
  const editCard = page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="agent-one"]')
    .first();
  await editCard
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  const draftInput = editCard.getByRole("textbox", { name: "Comment text" });
  await draftInput.fill("Native unsaved draft");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draftInput).toHaveValue("Updated feedback");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(draftInput).toHaveValue("Native unsaved draft");
  await editCard
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect
    .poll(async () => (await readComment()).text)
    .toBe("Native unsaved draft");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draftInput).toHaveValue("Native unsaved draft");
  await expect
    .poll(async () => (await readComment()).text)
    .toBe("Updated feedback");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(draftInput).toHaveValue("Updated feedback");
  await editCard
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await page.screenshot({ path: path.join(artifacts, "direct-comments.png") });
  await app.close();
  app = null;
  page = await open();
  assert.equal((await readComment()).text, "Updated feedback");
  assert.deepEqual((await readComment()).origin, original.origin);
  await expect(
    page.getByRole("region", { name: "Review proposed comment changes" }),
  ).toHaveCount(0);
  const fresh = await page.evaluate(async (root) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const session = await invoke("prepare_agent_workspace", {
      projectRoot: root,
      tabId: "guard-test",
      mode: "ask",
      dirtyBuffers: [],
    });
    return session;
  }, project);
  assert.equal(
    await fs.readFile(path.join(fresh.candidateRoot, "notes.md"), "utf8"),
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
  );
  await fs.writeFile(
    path.join(fresh.candidateRoot, "notes.md"),
    "Unfinished agent draft\n",
  );
  const inspectDraft = (dirtyBuffers = []) =>
    page.evaluate(
      async ({ root, sessionId, dirtyBuffers }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        return invoke("inspect_paused_workspace", {
          projectRoot: root,
          sessionId,
          dirtyBuffers,
        });
      },
      { root: project, sessionId: fresh.sessionId, dirtyBuffers },
    );
  const originalInspection = await inspectDraft();
  assert.equal(originalInspection.changed, false);
  assert.ok(originalInspection.changes.length > 0);
  const dirtyInspection = await inspectDraft([
    { relativePath: "notes.md", content: "Unsaved human edit\n" },
  ]);
  assert.equal(dirtyInspection.changed, true);
  assert.notEqual(dirtyInspection.revision, originalInspection.revision);
  await fs.writeFile(path.join(project, "notes.md"), "Saved human edit\n");
  assert.equal((await inspectDraft()).changed, true);
  for (const backup of [true, false]) {
    const sessions = await page.evaluate(
      async ({ root, sessionId, backup }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        await invoke("set_agent_workspace_backup", {
          projectRoot: root,
          sessionId,
          backup,
        });
        return invoke("list_agent_workspaces", { projectRoot: root });
      },
      { root: project, sessionId: fresh.sessionId, backup },
    );
    assert.equal(
      sessions.some((s) => s.sessionId === fresh.sessionId),
      !backup,
    );
    assert.equal(
      await fs.readFile(path.join(fresh.candidateRoot, "notes.md"), "utf8"),
      "Unfinished agent draft\n",
    );
  }
  console.log(
    "Paused resume IPC: source freshness, unsaved buffers, revision change and reversible backup preservation passed.",
  );
  console.log(
    "Electron direct comments: text/comment undo order, edit/resolve/delete redo, identity preservation and restart persistence passed.",
  );
} finally {
  await app?.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
