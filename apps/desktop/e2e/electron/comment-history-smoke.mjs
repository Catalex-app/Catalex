import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-history-"),
);
const project = path.join(profile, "Project");
const source = "Before target after.\n";
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), source);
let app;
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
try {
  await vite.listen();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const open = async () => {
    app = await electron.launch({ args: [root], env });
    const page = await app.firstWindow();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    await page.evaluate(async (project) => {
      const { useOnboardingStore } = await import(
        "/src/renderer/stores/onboarding-store.ts"
      );
      useOnboardingStore.getState().finish();
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await useDocumentStore.getState().openProject(project);
      const file = useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === "notes.md");
      useDocumentStore.getState().setActiveFile(file.id);
    }, project);
    return page;
  };
  let page = await open();
  const empty = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("history_init", { projectRoot });
    return (
      await invoke("history_list", { projectRoot, limit: 100, offset: 0 })
    )[0].id;
  }, project);
  await page.evaluate(
    async ({ projectRoot, source }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("update_project_comment_anchored", {
        projectRoot,
        source,
        patch: {
          filePath: "notes.md",
          id: "human",
          before: null,
          after: {
            id: "human",
            from: 7,
            to: 13,
            line: 1,
            text: "Original human comment",
          },
        },
      });
    },
    { projectRoot: project, source },
  );
  const autoCheckpoint = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return (
      await invoke("history_list", { projectRoot, limit: 100, offset: 0 })
    )[0];
  }, project);
  assert.equal(autoCheckpoint.message, "[comments] First comment on notes.md");
  const registry = JSON.parse(
    await fs.readFile(path.join(profile, "data/project-registry.json"), "utf8"),
  );
  const canonical = await fs.realpath(project);
  const entry = registry.projects.find((entry) =>
    entry.paths.includes(canonical),
  );
  const directory = path.join(profile, "data/projects", entry.id, "comments");
  const humanSidecar = JSON.parse(
    await readCommentFixture(path.join(directory, "human.json"), "utf8"),
  );
  const agent = {
    ...humanSidecar.files["notes.md"][0],
    id: "agent",
    number: 9,
    text: "Original agent comment",
    resolved: true,
    origin: { provider: "codex", sessionId: "history-fixture" },
  };
  await writeCommentFixture(
    path.join(directory, "agent.json"),
    JSON.stringify({
      ...humanSidecar,
      counter: 9,
      files: { "notes.md": [agent] },
    }),
  );
  const original = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const { useHistoryStore } = await import(
      "/src/renderer/stores/history-store.ts"
    );
    const snapshot = await useHistoryStore
      .getState()
      .createSnapshot(projectRoot, "Original comments");
    return {
      snapshot: snapshot.id,
      comments: await invoke("read_project_comments_anchored", { projectRoot }),
    };
  }, project);
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { clearProjectComments, synchronizeProjectCommentAnchors } =
      await import(
        "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
      );
    const store = useDocumentStore.getState();
    const file = store.files.find((file) => file.relativePath === "notes.md");
    store.updateFileContent(file.id, "Later text\nBefore target after.\n");
    await store.saveAllFiles({ requireClean: true });
    await synchronizeProjectCommentAnchors(projectRoot);
    await clearProjectComments(projectRoot, false);
    await clearProjectComments(projectRoot, true);
  }, project);
  const later = "Later text\nBefore target after.\n";
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    later,
  );
  const rewind = (id) =>
    page.evaluate(
      async ({ projectRoot, id }) => {
        const { useHistoryStore } = await import(
          "/src/renderer/stores/history-store.ts"
        );
        await useHistoryStore.getState().restoreSnapshot(projectRoot, id);
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        return invoke("read_project_comments_anchored", { projectRoot });
      },
      { projectRoot: project, id },
    );
  assert.deepEqual(await rewind(original.snapshot), original.comments);
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );
  const card = page
    .locator('.cm-inlineCommentCard[data-inline-comment-id="human"]')
    .first();
  await expect(card).toContainText("Original human comment");
  const content = page.locator(".cm-content").first();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        return useDocumentStore
          .getState()
          .files.find((file) => file.relativePath === "notes.md").content;
      }),
    )
    .toBe(source);
  await expect(content).not.toContainText("Later text");
  await expect(card).toContainText("Original human comment");
  await expect(
    page.getByText(
      /Comment positions could not be saved|Comment changes were not saved/,
    ),
  ).toHaveCount(0);
  const screenshot = path.resolve(
    root,
    "../../output/playwright/comment-history-rewind.png",
  );
  await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await page.screenshot({ path: screenshot });
  const before = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return (
      await invoke("history_list", { projectRoot, limit: 100, offset: 0 })
    ).find((entry) => entry.message.startsWith("[before-restore]")).id;
  }, project);
  const recovered = await rewind(before);
  assert.equal(Object.values(recovered.files).flat().length, 0);
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    later,
  );
  await rewind(original.snapshot);
  await app.close();
  app = undefined;
  page = await open();
  assert.deepEqual(
    await page.evaluate(async (projectRoot) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke("read_project_comments_anchored", { projectRoot });
    }, project),
    original.comments,
  );
  await fs.writeFile(path.join(project, "other.md"), source);
  const checkpoints = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const list = () =>
      invoke("history_list", { projectRoot, limit: 100, offset: 0 });
    const comments = await invoke("read_project_comments_anchored", {
      projectRoot,
    });
    const selection = [
      {
        path: "notes.md",
        disconnected: false,
        ids: comments.files["notes.md"].map((c) => c.id),
      },
    ];
    const request = {
      projectRoot,
      selection,
      author: "all",
      action: "relink",
      target: "other.md",
    };
    const beforePreview = (await list()).map((s) => s.id);
    await invoke("manage_comment_files", { ...request, preview: true });
    const afterPreview = (await list()).map((s) => s.id);
    await invoke("manage_comment_files", { ...request, preview: false });
    const relink = (await list())[0];
    const linked = await invoke("read_project_comments_anchored", {
      projectRoot,
    });
    await invoke("manage_comment_files", {
      ...request,
      action: "clear",
      target: "",
      selection: [{ ...selection[0], path: "other.md" }],
      preview: false,
    });
    const clear = (await list())[0];
    const cleared = await invoke("read_project_comments_anchored", {
      projectRoot,
    });
    return { beforePreview, afterPreview, relink, clear, linked, cleared };
  }, project);
  assert.deepEqual(checkpoints.beforePreview, checkpoints.afterPreview);
  assert.equal(
    checkpoints.relink.message,
    "[comments] Before reconnecting comments",
  );
  assert.equal(
    checkpoints.clear.message,
    "[comments] Before clearing comments",
  );
  assert.equal(Object.keys(checkpoints.cleared.files).length, 0);
  assert.deepEqual(
    (await rewind(checkpoints.clear.id)).files,
    checkpoints.linked.files,
  );
  assert.deepEqual(
    (await rewind(checkpoints.relink.id)).files,
    original.comments.files,
  );
  await rewind(empty);
  for (const name of ["human.json", "agent.json"])
    assert.deepEqual(
      JSON.parse(await readCommentFixture(path.join(directory, name))).files,
      {},
    );
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );
  // A failed protective checkpoint must not clear comments; a failed post-save
  // checkpoint must not pretend that saving the comment failed.
  const historyDir = path.join(
    profile,
    "data/projects",
    entry.id,
    "history.git",
  );
  await fs.rename(historyDir, `${historyDir}.backup`);
  await fs.writeFile(historyDir, "unavailable");
  try {
    const failure = await page.evaluate(
      async ({ projectRoot, source }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const patch = {
          filePath: "notes.md",
          id: "failure-test",
          before: null,
          after: {
            id: "failure-test",
            from: 0,
            to: 6,
            line: 1,
            text: "Keep this comment",
          },
        };
        await invoke("update_project_comment_anchored", {
          projectRoot,
          source,
          patch,
        });
        let blocked = false;
        try {
          await invoke("clear_project_comments", { projectRoot, agent: false });
        } catch {
          blocked = true;
        }
        return {
          blocked,
          saved: await invoke("read_project_comments_anchored", {
            projectRoot,
          }),
        };
      },
      { projectRoot: project, source },
    );
    assert.equal(failure.blocked, true);
    assert.equal(failure.saved.files["notes.md"][0].text, "Keep this comment");
    await expect(
      page.getByText(
        "Comment saved, but its history checkpoint could not be saved.",
      ),
    ).toBeVisible();
    await page.screenshot({
      path: path.resolve(
        root,
        "../../output/playwright/comment-checkpoint-warning.png",
      ),
    });
  } finally {
    await fs.rm(historyDir);
    await fs.rename(`${historyDir}.backup`, historyDir);
  }
  // Exercise the live editor's shared text/comment history. Disconnecting must
  // skip the comment without consuming text-only history or losing its data.
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const { toast } = await import("/node_modules/.vite/deps/sonner.js");
    toast.dismiss();
    const { COMMENT_HISTORY_EVENT } = await import(
      "/src/renderer/components/workspace/editor/comment-draft-history.ts"
    );
    const data = await invoke("read_project_comments_anchored", {
      projectRoot,
    });
    const before = data.files["notes.md"][0];
    const patch = {
      filePath: "notes.md",
      id: before.id,
      before,
      after: { ...before, text: "Edited for undo" },
    };
    await invoke("update_project_comment", { projectRoot, patch });
    window.dispatchEvent(
      new CustomEvent(COMMENT_HISTORY_EVENT, {
        detail: { root: projectRoot, patches: [patch] },
      }),
    );
  }, project);
  await expect(
    page
      .locator('.cm-inlineCommentCard[data-inline-comment-id="failure-test"]')
      .first(),
  ).toContainText("Edited for undo");
  await page.evaluate(async (projectRoot) => {
    const { detachComments } = await import(
      "/src/renderer/components/workspace/editor/comment-paths.ts"
    );
    detachComments(projectRoot, ["failure-test"]);
    window.dispatchEvent(
      new CustomEvent("catalex-file-undo", {
        detail: { root: projectRoot, filePath: "notes.md", redo: false },
      }),
    );
  }, project);
  await expect(
    page.getByText("Undo/redo skipped a disconnected comment."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Manage", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.resolve(
      root,
      "../../output/playwright/comment-undo-skipped.png",
    ),
  });
  await page.evaluate(async (projectRoot) => {
    const { detachComments } = await import(
      "/src/renderer/components/workspace/editor/comment-paths.ts"
    );
    detachComments(projectRoot, []);
    window.dispatchEvent(
      new CustomEvent("catalex-file-undo", {
        detail: { root: projectRoot, filePath: "notes.md", redo: true },
      }),
    );
  }, project);
  await expect(
    page.getByText("Undo/redo skipped an outdated comment change."),
  ).toBeVisible();
  const pendingFiles = await page.evaluate(async (projectRoot) => {
    const { getUnsavedCommentFiles } = await import(
      "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    return getUnsavedCommentFiles(projectRoot);
  }, project);
  assert.deepEqual(pendingFiles, []);
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(
    page
      .locator('.cm-inlineCommentCard[data-inline-comment-id="failure-test"]')
      .first(),
  ).toContainText("Keep this comment");
  console.log(
    "PASS: local human/agent comment history, clear then rewind, IDs/counters/status/anchors, source rewind, before-restore recovery, empty snapshots, undo boundary and restart persistence",
  );
} finally {
  if (app) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
