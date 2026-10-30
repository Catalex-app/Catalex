import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-paths-"),
);
const artifacts = path.resolve(root, "../../output/playwright/comment-paths");
await fs.mkdir(artifacts, { recursive: true });
const source = "Sample paragraph for comment review.\n";
const revision = createHash("sha1").update(source).digest("hex");
const human = {
  id: "H-1",
  number: 1,
  from: 0,
  to: 6,
  line: 1,
  text: "Human feedback",
  anchorRevision: revision,
};
const agent = {
  ...human,
  id: "A-1",
  text: "Agent feedback",
  resolved: true,
  origin: { provider: "codex", sessionId: "fixture" },
};
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
let page;
const cases = [];
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => console.error("Renderer:", error.message));
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
}
async function snapshot(projectRoot) {
  return page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("read_project_comments_anchored", { projectRoot });
  }, projectRoot);
}
async function open(projectRoot, filePath) {
  await page.evaluate(
    async ({ projectRoot, filePath }) => {
      const { useDocumentStore: store } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await store.getState().openProject(projectRoot);
      store.getState().setActiveFile(filePath);
    },
    { projectRoot, filePath },
  );
}
async function autoRelink(projectRoot) {
  return page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const snapshot = await invoke("read_project_comments_anchored", {
      projectRoot,
      includeDisconnected: true,
    });
    const groups = snapshot.disconnected;
    return invoke("manage_comment_files", {
      projectRoot,
      selection: Object.entries(groups).map(([path, comments]) => ({
        path,
        disconnected: true,
        ids: comments.map((c) => c.id),
      })),
      action: "auto-relink",
      author: "all",
      target: "",
      preview: false,
    });
  }, projectRoot);
}

try {
  await vite.listen();
  await launch();
  for (const operation of [
    "rename-file",
    "rename-folder",
    "move-file",
    "move-folder",
  ]) {
    const project = path.join(profile, operation);
    await fs.mkdir(path.join(project, "chapter"), { recursive: true });
    await fs.mkdir(path.join(project, "destination"));
    await fs.writeFile(path.join(project, "chapter/notes.md"), source);
    await fs.writeFile(path.join(project, "other.md"), "Another document.\n");
    await snapshot(project);
    const registry = JSON.parse(
      await fs.readFile(
        path.join(profile, "data/project-registry.json"),
        "utf8",
      ),
    );
    const canonical = await fs.realpath(project);
    const entry = registry.projects.find((entry) =>
      entry.paths.includes(canonical),
    );
    const storage = path.join(profile, "data/projects", entry.id, "comments");
    for (const [kind, comment] of [
      ["human", human],
      ["agent", agent],
    ])
      await writeCommentFixture(
        path.join(storage, `${kind}.json`),
        JSON.stringify({
          version: 1,
          counter: 1,
          files: { "chapter/notes.md": [comment] },
          sources: { [revision]: source },
        }),
      );
    await open(project, "chapter/notes.md");
    const card = page.locator(
      '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
    );
    await expect(card).toBeVisible();
    // IPC notifications create the same native editor history event as UI edits.
    await page.evaluate(async (projectRoot) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const snapshot = await invoke("read_project_comments_anchored", {
        projectRoot,
      });
      const before = snapshot.files["chapter/notes.md"].find(
        (comment) => comment.id === "H-1",
      );
      await invoke("update_project_comment", {
        projectRoot,
        patch: {
          filePath: "chapter/notes.md",
          id: before.id,
          before,
          after: { ...before, text: "Updated human feedback" },
        },
      });
    }, project);
    await expect(card).toContainText("Updated human feedback");
    const newPath =
      operation === "rename-file"
        ? "chapter/renamed.md"
        : operation === "rename-folder"
          ? "renamed/notes.md"
          : operation === "move-file"
            ? "destination/notes.md"
            : "destination/chapter/notes.md";
    await page.evaluate(async (operation) => {
      const { useDocumentStore: store } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      if (operation === "rename-file")
        await store.getState().renameFile("chapter/notes.md", "renamed.md");
      else if (operation === "rename-folder")
        await store.getState().renameFolder("chapter", "renamed");
      else if (operation === "move-file")
        await store.getState().moveFile("chapter/notes.md", "destination");
      else await store.getState().moveFolder("chapter", "destination");
    }, operation);
    await expect
      .poll(async () => Object.keys((await snapshot(project)).files))
      .toEqual([newPath]);
    let data = await snapshot(project);
    assert.deepEqual(
      data.files[newPath].find((c) => c.id === "A-1"),
      agent,
    );
    assert.equal(data.sources[revision], source);
    await expect(card).toContainText("Updated human feedback");
    await page.locator('.cm-content[contenteditable="true"]').first().focus();
    await page.keyboard.press("ControlOrMeta+z");
    await expect
      .poll(
        async () =>
          (await snapshot(project)).files[newPath].find((c) => c.id === "H-1")
            .text,
      )
      .toBe(human.text);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect
      .poll(
        async () =>
          (await snapshot(project)).files[newPath].find((c) => c.id === "H-1")
            .text,
      )
      .toBe("Updated human feedback");
    await fs.mkdir(path.join(project, "chapter"), { recursive: true });
    await fs.writeFile(path.join(project, "chapter/notes.md"), source);
    data = await snapshot(project);
    assert.equal(data.files["chapter/notes.md"], undefined);
    await page.screenshot({ path: path.join(artifacts, `${operation}.png`) });
    for (const author of ["human", "agent"]) {
      const side = JSON.parse(
        await readCommentFixture(path.join(storage, `${author}.json`)),
      );
      const digest = createHash("sha1")
        .update(await fs.readFile(path.join(project, newPath)))
        .digest("hex");
      assert.deepEqual(side.revisions[newPath], [digest]);
    }
    cases.push({ project, newPath, storage });
    console.log(
      `PASS ${operation}: both origins, anchors, undo/redo, reused old name`,
    );
  }
  await app.close();
  app = undefined;
  await launch();
  for (const { project, newPath } of cases) {
    const data = await snapshot(project);
    assert.equal(data.files["chapter/notes.md"], undefined);
    assert.deepEqual(
      data.files[newPath].find((c) => c.id === "A-1"),
      agent,
    );
    assert.equal(
      data.files[newPath].find((c) => c.id === "H-1").text,
      "Updated human feedback",
    );
    assert.equal(data.sources[revision], source);
  }
  console.log(
    `PASS full restart: ${cases.length} projects; profile ${profile}`,
  );
  const failure = cases[1];
  await open(failure.project, failure.newPath);
  const humanPath = path.join(failure.storage, "human.json");
  const backup = await readCommentFixture(humanPath);
  await writeCommentFixture(humanPath, "invalid metadata");
  await page.evaluate(
    async ({ filePath }) => {
      const { useDocumentStore: store } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await store.getState().renameFile(filePath, "should-not-rename.md");
      store
        .getState()
        .updateFileContent(filePath, "Manuscript saving still works.\n");
      await store.getState().saveAllFiles({ requireClean: true });
    },
    { filePath: failure.newPath },
  );
  assert.equal(
    await fs.readFile(path.join(failure.project, failure.newPath), "utf8"),
    "Manuscript saving still works.\n",
  );
  assert.equal(await readCommentFixture(humanPath, "utf8"), "invalid metadata");
  await writeCommentFixture(humanPath, backup);
  // Direct fixture writes emit no native notification. Retry the failed load
  // after restoring metadata, as the normal recovery UI does.
  await page.evaluate(async (projectRoot) => {
    const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
      "/src/renderer/lib/workspace-events.ts"
    );
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot },
      }),
    );
  }, failure.project);
  await expect(
    page.locator('.cm-inlineCommentCard[data-inline-comment-id="H-1"]'),
  ).toBeVisible();
  console.log(
    "PASS failed comment metadata: rename canceled, manuscript save succeeds",
  );
  const closedAfterRepair = await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    return useDocumentStore.getState().closeProject();
  });
  if (!closedAfterRepair) {
    console.error(await page.locator("body").innerText());
    throw new Error("Project could not close after metadata repair");
  }

  await app.close();
  app = undefined;
  const interrupted = cases[0];
  await fs.writeFile(
    path.join(interrupted.storage, "path-change.json"),
    JSON.stringify([
      { oldPath: interrupted.newPath, newPath: "recovered.md", folder: false },
    ]),
  );
  await fs.rename(
    path.join(interrupted.project, interrupted.newPath),
    path.join(interrupted.project, "recovered.md"),
  );
  await launch();
  let recovered = await snapshot(interrupted.project);
  assert.deepEqual(recovered.files["recovered.md"].map((c) => c.id).sort(), [
    "A-1",
    "H-1",
  ]);
  assert.equal(recovered.files[interrupted.newPath], undefined);
  assert.equal(recovered.sources[revision], source);
  await assert.rejects(
    fs.stat(path.join(interrupted.storage, "path-change.json")),
    { code: "ENOENT" },
  );
  console.log(
    "PASS interruption: restart finishes journaled comment migration",
  );

  await app.close();
  app = undefined;
  await fs.mkdir(path.join(interrupted.project, "finder-folder"));
  await fs.rename(
    path.join(interrupted.project, "recovered.md"),
    path.join(interrupted.project, "finder-folder/external.md"),
  );
  await fs.writeFile(path.join(interrupted.project, "recovered.md"), source);
  await launch();
  recovered = await snapshot(interrupted.project);
  // Same relative path + same text is intentional continuity, even if copied.
  assert.equal(recovered.files["recovered.md"].length, 2);
  assert.equal(recovered.files["finder-folder/external.md"], undefined);
  await fs.rm(path.join(interrupted.project, "recovered.md"));
  recovered = await snapshot(interrupted.project);
  assert.ok(recovered.orphanedPaths.includes("recovered.md"));
  const ambiguous = await autoRelink(interrupted.project);
  assert.equal(ambiguous.linked, 0);
  // A reused old fixture filename contains identical text: remove that duplicate.
  await fs.rm(path.join(interrupted.project, "chapter/notes.md"));
  await autoRelink(interrupted.project);
  recovered = await snapshot(interrupted.project);
  assert.equal(recovered.files["finder-folder/external.md"].length, 2);
  console.log(
    "PASS external rename waits for requested content relink; same-path copy retains comments",
  );
  await open(interrupted.project, "finder-folder/external.md");
  await page.evaluate(async () => {
    const { useDocumentStore: store } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    store
      .getState()
      .updateFileContent(
        "finder-folder/external.md",
        "Sample paragraph for comment review.\nSaved in Catalex.\n",
      );
    await store.getState().saveAllFiles({ requireClean: true });
  });
  recovered = await snapshot(interrupted.project);
  assert.equal(recovered.files["finder-folder/external.md"].length, 2);
  await fs.rename(
    path.join(interrupted.project, "finder-folder"),
    path.join(interrupted.project, "renamed-folder"),
  );
  recovered = await snapshot(interrupted.project);
  assert.ok(recovered.orphanedPaths.includes("finder-folder/external.md"));
  await autoRelink(interrupted.project);
  recovered = await snapshot(interrupted.project);
  assert.equal(recovered.files["renamed-folder/external.md"].length, 2);
  console.log(
    "PASS app save updates content revision; external folder rename requires relink",
  );

  await fs.rename(
    path.join(interrupted.project, "renamed-folder/external.md"),
    path.join(profile, "outside-project.md"),
  );
  recovered = await snapshot(interrupted.project);
  assert.ok(recovered.orphanedPaths.includes("renamed-folder/external.md"));
  await fs.writeFile(
    path.join(interrupted.project, "reconnect.md"),
    "A different passage.\n",
  );
  await open(interrupted.project, "reconnect.md");
  await expect(
    page.locator('.cm-inlineCommentCard[data-inline-comment-id="H-1"]'),
  ).toHaveCount(0);
  const section = page.locator('[data-sidebar-section="comment-visibility"]');
  await section.locator("button").first().click();
  await section.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }).click();
  await dialog
    .getByLabel("Select disconnected file renamed-folder/external.md", {
      exact: true,
    })
    .check();
  await dialog
    .getByRole("button", { name: "Reconnect comments to file", exact: true })
    .click();
  await app.evaluate(
    ({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [filePath],
      });
    },
    path.join(interrupted.project, "reconnect.md"),
  );
  await dialog
    .getByRole("button", { name: "Choose file…", exact: true })
    .click();
  await expect(
    dialog.getByText("Ready to relink.", { exact: false }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, "locate-file.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByRole("tab", { name: /^Connected \(\d+\)$/ }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: /^Connected \(\d+\)$/ }).click();
  await expect(
    dialog.locator('[data-comment-link-group="reconnect.md"]'),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  recovered = await snapshot(interrupted.project);
  assert.deepEqual(recovered.files["reconnect.md"].map((c) => c.id).sort(), [
    "A-1",
    "H-1",
  ]);
  assert.ok(
    recovered.files["reconnect.md"].every(
      (c) => c.positionReset && c.from === 0 && c.to === 0,
    ),
  );
  await expect(
    page.locator('.cm-inlineCommentCard[data-inline-comment-id="H-1"]'),
  ).toBeVisible();
  await expect(
    page
      .locator(".cm-inlineCommentUnplaced")
      .first()
      .locator(".cm-inlineCommentPlacementStatus"),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.screenshot({
    path: path.join(artifacts, "reconnected-unplaced.png"),
    animations: "disabled",
  });
  console.log(
    "PASS manual reconnection through management dialog; changed text produces unplaced comments",
  );
  await app.close();
  app = undefined;
  await launch();
  recovered = await snapshot(interrupted.project);
  assert.equal(recovered.files["reconnect.md"].length, 2);
  assert.equal(recovered.orphanedIds.length, 0);
  console.log("PASS manual reconnection survives full application restart");
  // Exercise app-owned Git replacement through native IPC, not a mock.
  const gitProject = path.join(profile, "git-comments");
  await fs.mkdir(gitProject);
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        ...args,
      ],
      { cwd: gitProject, stdio: "pipe" },
    );
  git("init", "-b", "main");
  await fs.writeFile(path.join(gitProject, "notes.md"), source);
  git("add", ".");
  git("commit", "-m", "Base");
  git("checkout", "-b", "incoming");
  await fs.writeFile(
    path.join(gitProject, "notes.md"),
    source + "Incoming paragraph.\n",
  );
  git("commit", "-am", "Incoming edit");
  git("checkout", "main");
  git("config", "branch.main.remote", ".");
  git("config", "branch.main.merge", "refs/heads/incoming");
  await snapshot(gitProject);
  const registry = JSON.parse(
    await fs.readFile(path.join(profile, "data/project-registry.json"), "utf8"),
  );
  const canonicalGit = await fs.realpath(gitProject);
  const gitEntry = registry.projects.find((entry) =>
    entry.paths.includes(canonicalGit),
  );
  const gitStorage = path.join(
    profile,
    "data/projects",
    gitEntry.id,
    "comments",
  );
  for (const [kind, comment] of [
    ["human", human],
    ["agent", agent],
  ]) {
    await writeCommentFixture(
      path.join(gitStorage, `${kind}.json`),
      JSON.stringify({
        version: 1,
        counter: 1,
        files: { "notes.md": [comment] },
        sources: { [revision]: source },
      }),
    );
  }
  await snapshot(gitProject);
  const pull = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("git_panel_pull", { projectRoot });
  }, gitProject);
  assert.equal(pull.success, true);
  assert.equal(pull.commentWarning, undefined);
  let gitComments = await snapshot(gitProject);
  assert.equal(gitComments.files["notes.md"].length, 2);
  assert.equal(gitComments.orphanedIds.length, 0);
  assert.equal(
    await fs.readFile(path.join(gitProject, "notes.md"), "utf8"),
    source + "Incoming paragraph.\n",
  );
  console.log(
    "PASS app Git pull/merge retains both comment origins after physical file replacement",
  );
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const data = await invoke("read_project_comments_anchored", {
      projectRoot,
    });
    const before = data.files["notes.md"].find((c) => c.id === "H-1");
    await invoke("update_project_comment", {
      projectRoot,
      patch: {
        filePath: "notes.md",
        id: before.id,
        before,
        after: { ...before, text: "Edited after Git merge", resolved: true },
      },
    });
  }, gitProject);
  gitComments = await snapshot(gitProject);
  assert.equal(
    gitComments.files["notes.md"].find((c) => c.id === "H-1").text,
    "Edited after Git merge",
  );
  assert.deepEqual(
    gitComments.files["notes.md"].find((c) => c.id === "A-1"),
    {
      ...agent,
      anchorRevision: createHash("sha1")
        .update(await fs.readFile(path.join(gitProject, "notes.md")))
        .digest("hex"),
    },
  );
  console.log(
    "PASS comment editing/resolution after Git merge preserves other-author metadata",
  );
  const session = await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("prepare_agent_workspace", {
      projectRoot,
      tabId: "comment-audit",
      mode: "ask",
      dirtyBuffers: [],
    });
  }, gitProject);
  const baseline = await fs.readFile(path.join(gitProject, "notes.md"), "utf8");
  await fs.writeFile(
    path.join(session.candidateRoot, "notes.md"),
    baseline + "Agent addition.\n",
  );
  const mergedSource = baseline.replace("Sample", "SAMPLE");
  await page.evaluate(
    async ({ projectRoot, expected, content }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const saved = await invoke("save_file_if_unchanged", {
        projectRoot,
        filePath: "notes.md",
        expected,
        content,
      });
      if (!saved.written)
        throw new Error("Concurrent source edit did not save");
    },
    { projectRoot: gitProject, expected: baseline, content: mergedSource },
  );
  const accepted = await page.evaluate(
    async ({ projectRoot, sessionId }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const preview = await invoke("preview_agent_workspace", {
        projectRoot,
        sessionId,
        decisions: [],
      });
      return invoke("apply_agent_workspace", {
        projectRoot,
        sessionId,
        decisions: preview.changes.map((change) => ({
          changeId: change.id,
          accept: true,
          content: null,
        })),
        expectedSourceRevision: preview.sourceRevision,
      });
    },
    { projectRoot: gitProject, sessionId: session.sessionId },
  );
  assert.equal(accepted.applied, true);
  assert.equal(accepted.commentWarning, null);
  assert.equal(
    await fs.readFile(path.join(gitProject, "notes.md"), "utf8"),
    mergedSource + "Agent addition.\n",
  );
  gitComments = await snapshot(gitProject);
  assert.equal(gitComments.files["notes.md"].length, 2);
  assert.equal(gitComments.orphanedIds.length, 0);
  assert.equal(
    gitComments.files["notes.md"].find((c) => c.id === "H-1").text,
    "Edited after Git merge",
  );
  assert.deepEqual(
    gitComments.files["notes.md"].find((c) => c.id === "A-1").origin,
    agent.origin,
  );
  console.log(
    "PASS native agent acceptance merges concurrent manuscript edits and preserves both comment groups",
  );
  await fs.rename(
    path.join(gitProject, "notes.md"),
    path.join(profile, "cleared-notes.md"),
  );
  await snapshot(gitProject);
  await page.evaluate(async (projectRoot) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    let rejected = false;
    try {
      await invoke("manage_comment_files", {
        projectRoot,
        selection: [{ path: "notes.md", disconnected: true, ids: ["H-1"] }],
        action: "clear",
        author: "all",
        target: "",
        preview: false,
      });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Stale clear must be rejected");
    await invoke("manage_comment_files", {
      projectRoot,
      selection: [
        { path: "notes.md", disconnected: true, ids: ["H-1", "A-1"] },
      ],
      action: "clear",
      author: "all",
      target: "",
      preview: false,
    });
    const data = await invoke("read_project_comments_anchored", {
      projectRoot,
      includeDisconnected: true,
    });
    if (Object.keys(data.disconnected).length)
      throw new Error("Disconnected group was not cleared");
  }, gitProject);
  await app.close();
  app = null;
  await launch();
  const cleared = await snapshot(gitProject);
  assert.equal(cleared.orphanedIds.length, 0);
  console.log(
    "PASS clearing a disconnected group checks IDs, removes both authors, and survives restart",
  );
  // A known path stays linked even when every selected passage disappears.
  const lostProject = path.join(profile, "lost-anchors");
  await fs.mkdir(lostProject);
  await fs.writeFile(path.join(lostProject, "notes.md"), source);
  await snapshot(lostProject);
  const lostRegistry = JSON.parse(
    await fs.readFile(path.join(profile, "data/project-registry.json"), "utf8"),
  );
  const lostCanonical = await fs.realpath(lostProject);
  const lostId = lostRegistry.projects.find((entry) =>
    entry.paths.includes(lostCanonical),
  ).id;
  const lostStorage = path.join(profile, "data/projects", lostId, "comments");
  for (const [kind, template] of [
    ["human", human],
    ["agent", agent],
  ]) {
    const comment =
      kind === "human" ? { ...template, from: 7, to: 16 } : template;
    await writeCommentFixture(
      path.join(lostStorage, `${kind}.json`),
      JSON.stringify({
        version: 1,
        counter: 1,
        files: { "notes.md": [comment] },
        sources: { [revision]: source },
      }),
    );
  }
  await open(lostProject, "notes.md");
  const lostCard = page.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
  );
  await expect(
    lostCard.getByRole("button", { name: "Edit comment", exact: true }),
  ).toBeVisible();
  await lostCard
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  const lostDraft = lostCard.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await lostDraft.fill("Draft preserved while its anchor is lost");
  await fs.writeFile(
    path.join(lostProject, "notes.md"),
    "Sample removed content.\n",
  );
  await expect(lostCard).toHaveClass(/cm-inlineCommentUnplaced/);
  await expect(lostDraft).toHaveValue(
    "Draft preserved while its anchor is lost",
  );
  await lostCard
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(lostCard.locator(".cm-inlineCommentPlacementStatus")).toHaveText(
    "Lost",
  );
  let lostState = await snapshot(lostProject);
  assert.equal(lostState.orphanedIds.length, 0);
  assert.equal(
    lostState.files["notes.md"].find((c) => c.id === "H-1").text,
    "Draft preserved while its anchor is lost",
  );
  assert.equal(
    lostState.files["notes.md"].find((c) => c.id === "H-1").positionReset,
    true,
  );
  assert.equal(
    lostState.files["notes.md"].find((c) => c.id === "A-1").resolved,
    true,
  );
  assert.equal(
    lostState.files["notes.md"].find((c) => c.id === "A-1").positionReset ??
      false,
    false,
  );
  await expect(
    lostCard.getByRole("button", { name: "Delete comment", exact: true }),
  ).toBeVisible();
  await expect(
    lostCard.getByRole("button", { name: "Edit comment", exact: true }),
  ).toHaveCount(0);
  await lostCard.locator(".cm-inlineCommentAttach").click();
  await expect(
    lostCard.locator(".cm-inlineCommentPlacementHint"),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, "external-edit-lost-comment.png"),
    animations: "disabled",
  });
  await fs.writeFile(path.join(lostProject, "notes.md"), "");
  await expect
    .poll(async () =>
      (await snapshot(lostProject)).files["notes.md"].every(
        (c) => c.positionReset && c.from === 0 && c.to === 0,
      ),
    )
    .toBe(true);
  await app.close();
  app = null;
  await launch();
  lostState = await snapshot(lostProject);
  assert.equal(lostState.orphanedIds.length, 0);
  assert.equal(lostState.files["notes.md"].length, 2);
  assert.ok(lostState.files["notes.md"].every((c) => c.positionReset));
  await fs.rename(
    path.join(lostProject, "notes.md"),
    path.join(lostProject, "moved.md"),
  );
  lostState = await snapshot(lostProject);
  assert.equal(lostState.orphanedIds.length, 2);
  const lostRelink = await autoRelink(lostProject);
  assert.equal(lostRelink.linked, 2);
  assert.equal(lostRelink.unplaced, 2);
  lostState = await snapshot(lostProject);
  assert.equal(lostState.orphanedIds.length, 0);
  assert.ok(lostState.files["moved.md"].every((c) => c.positionReset));
  console.log(
    "PASS external edits retain mixed/resolved/Lost comments; empty files, restart and auto-relink preserve all records",
  );
  // Exercise the real batch action with two matches and one edited candidate.
  const batchProject = path.join(profile, "batch-relink");
  await fs.mkdir(batchProject);
  const batchSources = [
    "First marked sentence.\n",
    "Second marked sentence.\n",
    "Unmatched sentence.\n",
  ];
  for (const [i, text] of batchSources.entries())
    await fs.writeFile(path.join(batchProject, `old-${i}.md`), text);
  await snapshot(batchProject);
  const batchRegistry = JSON.parse(
    await fs.readFile(path.join(profile, "data/project-registry.json"), "utf8"),
  );
  const batchCanonical = await fs.realpath(batchProject);
  const batchId = batchRegistry.projects.find((entry) =>
    entry.paths.includes(batchCanonical),
  ).id;
  const batchStorage = path.join(profile, "data/projects", batchId, "comments");
  for (const [kind, template] of [
    ["human", human],
    ["agent", agent],
  ]) {
    const files = {};
    const sources = {};
    for (const [i, text] of batchSources.entries()) {
      const rev = createHash("sha1").update(text).digest("hex");
      files[`old-${i}.md`] = [
        {
          ...template,
          id: `${kind === "human" ? "H" : "A"}-${i + 1}`,
          number: i + 1,
          from: 0,
          to: text.trim().length,
          anchorRevision: rev,
        },
      ];
      sources[rev] = text;
    }
    await writeCommentFixture(
      path.join(batchStorage, `${kind}.json`),
      JSON.stringify({ version: 1, counter: 3, files, sources }),
    );
  }
  await snapshot(batchProject);
  // Replacement at an existing path recovers matching text, including offsets.
  await fs.writeFile(
    path.join(batchProject, "replacement.tmp"),
    `Prefix\n${batchSources[0]}`,
  );
  await fs.rename(
    path.join(batchProject, "replacement.tmp"),
    path.join(batchProject, "old-0.md"),
  );
  let batchState = await snapshot(batchProject);
  assert.equal(batchState.files["old-0.md"][0].from, 7);
  assert.equal(batchState.orphanedIds.length, 0);
  for (const i of [0, 1, 2])
    await fs.rename(
      path.join(batchProject, `old-${i}.md`),
      path.join(batchProject, `new-${i}.md`),
    );
  await fs.writeFile(
    path.join(batchProject, "new-2.md"),
    "Unmatched sentence, edited.\n",
  );
  batchState = await snapshot(batchProject);
  assert.equal(batchState.orphanedIds.length, 6);
  await open(batchProject, "new-0.md");
  const batchSection = page.locator(
    '[data-sidebar-section="comment-visibility"]',
  );
  if (
    !(await batchSection
      .getByRole("button", { name: "Manage", exact: true })
      .isVisible())
  )
    await batchSection.locator("button").first().click();
  await batchSection
    .getByRole("button", { name: "Manage", exact: true })
    .click();
  const batchDialog = page.getByRole("dialog", { name: "Manage comments" });
  await batchDialog
    .getByRole("tab", { name: "Disconnected (3)", exact: true })
    .click();
  await batchDialog.getByLabel("Select all files", { exact: true }).check();
  await batchDialog
    .getByRole("button", { name: "Auto-relink selected", exact: true })
    .click();
  await page.screenshot({
    path: path.join(artifacts, "batch-relink-selected.png"),
    animations: "disabled",
  });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.managerRefreshProbe = { original, snapshots: 0 };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", (event, command, args) => {
      if (
        command === "read_project_comments_anchored" &&
        args.includeDisconnected
      )
        globalThis.managerRefreshProbe.snapshots++;
      return original(event, command, args);
    });
  });
  await batchDialog
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    batchDialog.getByText("4 comments relinked. 2 remain disconnected.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    batchDialog.getByLabel("Select disconnected file old-2.md", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    batchDialog.getByRole("tab", { name: "Disconnected (1)", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(250);
  assert.equal(
    await app.evaluate(() => globalThis.managerRefreshProbe.snapshots),
    1,
    "native manager success causes one manager snapshot refresh",
  );
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", globalThis.managerRefreshProbe.original);
    delete globalThis.managerRefreshProbe;
  });
  await page.screenshot({
    path: path.join(artifacts, "batch-relink-result.png"),
    animations: "disabled",
  });
  await batchDialog.getByRole("button", { name: "Close", exact: true }).click();
  batchState = await snapshot(batchProject);
  assert.equal(batchState.files["new-0.md"].length, 2);
  assert.equal(batchState.files["new-1.md"].length, 2);
  assert.equal(batchState.orphanedIds.length, 2);
  await app.close();
  app = null;
  await launch();
  batchState = await snapshot(batchProject);
  assert.equal(batchState.files["new-0.md"].length, 2);
  assert.equal(batchState.orphanedIds.length, 2);
  console.log(
    "PASS external replacement anchor recovery, batch auto-relink partial success, and restart persistence",
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await vite.close();
}
