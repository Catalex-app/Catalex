import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { readCommentFixture, writeCommentFixture } from "./comment-fixture.mjs";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-storage-smoke-"),
);
const project = path.join(profile, "Retained paper");
const artifacts = path.resolve(desktopRoot, "../../output/playwright/storage");
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
const source =
  "\\documentclass{article}\n\\begin{document}\nPreserved history.\n\\end{document}\n";
await fs.writeFile(path.join(project, "main.tex"), source);
await fs.writeFile(path.join(project, "notes.md"), "# Stored project\n");
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({ args: [desktopRoot], env });
async function invoke(page, command, args = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      const reply = await window.catalex.invoke(command, args);
      if ("error" in reply) throw new Error(String(reply.error));
      return reply.result;
    },
    { command, args },
  );
}
try {
  const main = await app.firstWindow();
  const errors = [];
  main.on("pageerror", (error) => errors.push(error.message));
  await main.locator("#loading-screen").waitFor({ state: "hidden" });
  // Exercise retained storage as a returning user; onboarding has separate coverage.
  await main.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await main.reload();
  await main.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, project);
  async function openProject() {
    await main.getByTestId("welcome-new-project-menu-trigger").click();
    await main.getByRole("menuitem", { name: "Open Folder" }).click();
    await main.locator(".cm-content").first().waitFor();
  }
  await openProject();
  await invoke(main, "history_init", { projectRoot: project });
  const baseline = (
    await invoke(main, "history_list", {
      projectRoot: project,
      limit: 10,
      offset: 0,
    })
  )[0].id;
  const canonicalProject = await fs.realpath(project);
  const inventory = await invoke(main, "desktop:storage:list");
  const stored = inventory.projects.find((entry) =>
    entry.paths.includes(canonicalProject),
  );
  assert.ok(stored);
  assert.equal(stored.isOpen, true);
  assert.ok(stored.historyBytes > 0);
  const rejected = await main.evaluate(
    (projectId) =>
      window.catalex.invoke("desktop:storage:clear", {
        projectId,
        action: "history",
      }),
    stored.id,
  );
  assert.match(String(rejected.error), /Close this project/);
  await main
    .getByRole("button", { name: "Close project", exact: true })
    .first()
    .click();
  await expect(
    main.getByTestId("welcome-new-project-menu-trigger"),
  ).toBeVisible();
  await main
    .getByRole("button", { name: "Remove Retained paper", exact: true })
    .click();
  await expect(
    main.getByRole("button", { name: "Remove Retained paper", exact: true }),
  ).toHaveCount(0);
  assert.equal(
    (await invoke(main, "desktop:storage:list")).projects[0].id,
    stored.id,
  );
  await openProject();
  const afterReopen = await invoke(main, "history_list", {
    projectRoot: project,
    limit: 10,
    offset: 0,
  });
  assert.ok(afterReopen.some((snapshot) => snapshot.id === baseline));
  assert.equal(
    (await invoke(main, "desktop:storage:list")).projects[0].id,
    stored.id,
  );
  await main
    .getByRole("button", { name: "Close project", exact: true })
    .first()
    .click();
  await expect(
    main.getByTestId("welcome-new-project-menu-trigger"),
  ).toBeVisible();
  const cacheFile = path.join(stored.cachePath, "test-cache.tmp");
  const commentFiles = ["human.json"].map((name) =>
    path.join(stored.dataPath, "comments", name),
  );
  await writeCommentFixture(
    path.join(stored.dataPath, "comments", "human.json"),
    JSON.stringify({
      version: 1,
      counter: 1,
      files: {
        "main.tex": [
          {
            id: "storage-comment",
            number: 1,
            from: 0,
            to: 6,
            line: 1,
            text: "Keep this comment",
          },
        ],
      },
    }),
  );
  const commentBytes = await Promise.all(
    commentFiles.map((file) => readCommentFixture(file)),
  );
  await fs.mkdir(stored.cachePath, { recursive: true });
  await fs.writeFile(cacheFile, "disposable cached data");
  const settingsReady = app.waitForEvent("window");
  await invoke(main, "open_settings_window", { section: "storage" });
  const settings = await settingsReady;
  settings.on("pageerror", (error) => errors.push(error.message));
  await expect(
    settings.getByRole("region", { name: "Storage settings" }),
  ).toBeVisible();
  const cacheServer = createServer((_request, response) => {
    response.writeHead(200, { "Cache-Control": "public, max-age=86400" });
    response.end(Buffer.alloc(1024 * 1024, "x"));
  });
  await new Promise((resolve) => cacheServer.listen(0, "127.0.0.1", resolve));
  try {
    const address = cacheServer.address();
    await app.evaluate(async ({ net }, url) => {
      await (await net.fetch(url)).arrayBuffer();
    }, `http://127.0.0.1:${address.port}/cached-resource`);
  } finally {
    await new Promise((resolve, reject) =>
      cacheServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  const cacheBefore = await app.evaluate(({ session }) =>
    session.defaultSession.getCacheSize(),
  );
  assert.ok(cacheBefore >= 1024 * 1024);
  await settings.evaluate(() =>
    localStorage.setItem("storage-smoke-preference", "keep"),
  );
  await app.evaluate(async ({ session }) => {
    await session.defaultSession.cookies.set({
      url: "https://storage-test.invalid",
      name: "storage-smoke",
      value: "keep",
    });
  });
  await settings
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await settings
    .getByRole("dialog", { name: "Clear browser cache?" })
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await expect(
    settings.getByRole("dialog", { name: "Clear browser cache?" }),
  ).toBeHidden();
  const cacheAfter = await app.evaluate(({ session }) =>
    session.defaultSession.getCacheSize(),
  );
  assert.ok(cacheAfter < cacheBefore);
  assert.equal(
    await settings.evaluate(() =>
      localStorage.getItem("storage-smoke-preference"),
    ),
    "keep",
  );
  assert.equal(
    await app.evaluate(
      async ({ session }) =>
        (await session.defaultSession.cookies.get({ name: "storage-smoke" }))[0]
          ?.value,
    ),
    "keep",
  );
  const row = settings.getByTestId(`stored-project-${stored.id}`);
  const filters = settings.getByRole("group", {
    name: "Filter stored projects",
  });
  await filters.getByRole("button", { name: "Active", exact: true }).click();
  await expect(row).toBeVisible();
  await filters.getByRole("button", { name: "Inactive", exact: true }).click();
  await expect(row).toHaveCount(0);
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await row.getByRole("button", { name: /Retained paper/ }).click();
  await row.getByRole("button", { name: "Clear cache", exact: true }).click();
  const confirmation = settings.getByRole("dialog", { name: "Clear cache?" });
  await confirmation
    .getByRole("button", { name: "Clear cache", exact: true })
    .click();
  await expect(confirmation).toBeHidden();
  await expect(
    row.getByRole("button", { name: "Clear cache", exact: true }),
  ).toBeDisabled();
  await assert.rejects(fs.stat(cacheFile), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(project, "main.tex"), "utf8"),
    source,
  );
  assert.ok(
    (
      await invoke(settings, "history_list", {
        projectRoot: project,
        limit: 10,
        offset: 0,
      })
    ).some((snapshot) => snapshot.id === baseline),
  );
  await settings.screenshot({
    path: path.join(artifacts, "storage-settings.png"),
  });
  for (const action of ["cache", "history", "agent"]) {
    await invoke(settings, "desktop:storage:clear", {
      projectId: stored.id,
      action,
    });
    for (const [index, file] of commentFiles.entries())
      assert.deepEqual(await readCommentFixture(file), commentBytes[index]);
    assert.equal(
      await fs.readFile(path.join(project, "main.tex"), "utf8"),
      source,
    );
  }
  // Deletion of a source folder must not make retained storage unmanageable.
  await fs.rm(project, { recursive: true, force: true });
  await settings.getByRole("button", { name: "Refresh storage" }).click();
  await expect(
    row.getByText("Folder unavailable", { exact: true }),
  ).toBeVisible();
  await filters
    .getByRole("button", { name: "Unavailable", exact: true })
    .click();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Remove stored data…" }).click();
  const remove = settings.getByRole("dialog", { name: "Remove stored data?" });
  await remove
    .getByRole("button", { name: "Remove stored data", exact: true })
    .click();
  await expect(row).toHaveCount(0);
  await assert.rejects(
    fs.stat(path.join(stored.dataPath, "comments", "comments.polodb")),
    { code: "ENOENT" },
  );
  assert.equal(
    (await invoke(settings, "desktop:storage:list")).projects.length,
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Storage Electron smoke passed: Recents removal/reopen preserves history and identity; active-project cleanup is blocked; Settings cache cleanup preserves history and source; unavailable projects can be explicitly removed.",
  );
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
