import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// Actual Electron UI and native Git commands, using only temporary local remotes.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-merge-push-"),
);
const config = path.join(fixtureRoot, "gitconfig");
await fs.writeFile(config, "");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  CATALEX_USER_DATA_DIR: path.join(fixtureRoot, "profile"),
};
delete env.ELECTRON_RUN_AS_NODE;
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
git(fixtureRoot, "config", "--global", "user.name", "Merge fixture");
git(fixtureRoot, "config", "--global", "user.email", "fixture@example.invalid");
git(fixtureRoot, "config", "--global", "commit.gpgsign", "false");

async function fixture(name, conflict = false) {
  const base = path.join(fixtureRoot, name);
  await fs.mkdir(base);
  const remote = path.join(base, "remote.git");
  const project = path.join(base, "project");
  const collaborator = path.join(base, "collaborator");
  git(base, "init", "--bare", "--initial-branch=main", remote);
  git(base, "clone", remote, project);
  await fs.writeFile(path.join(project, "notes.md"), "Original finding.\n");
  git(project, "add", ".");
  git(project, "commit", "-m", "Baseline");
  git(project, "push", "-u", "origin", "main");
  git(base, "clone", remote, collaborator);
  await fs.writeFile(
    path.join(project, conflict ? "notes.md" : "local.md"),
    "Local finding.\n",
  );
  git(project, "add", ".");
  git(project, "commit", "-m", "Local finding");
  await fs.writeFile(path.join(collaborator, "notes.md"), "Remote finding.\n");
  git(collaborator, "commit", "-am", "Remote finding");
  git(collaborator, "push");
  return { project, remote };
}

const clean = await fixture("clean");
const conflict = await fixture("conflict", true);
const failed = await fixture("push-failure");
await fs.writeFile(
  path.join(failed.remote, "hooks", "pre-receive"),
  "#!/bin/sh\necho 'Fixture rejects push' >&2\nexit 1\n",
  { mode: 0o755 },
);
const vite = await createServer({
  root: desktopRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
});
let app;
let page;
async function launch() {
  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...env,
      CATALEX_DEV_URL: vite.resolvedUrls.local[0],
    },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
}
async function close() {
  const closed = app.waitForEvent("close", { timeout: 15000 });
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}
async function open(project) {
  await page.evaluate(async (project) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.getState().setWorkspacePreferences(project, {
      mode: "artisan",
      chatLayout: "drawer",
    });
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
  }, project);
}
async function recover(clean = true) {
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  const combined = dialog.getByRole("button", {
    name: "Pull, merge & push",
    exact: true,
  });
  if (clean) await expect(combined).toBeVisible();
  else {
    await expect(combined).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Pull and merge", exact: true }),
    ).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
}
try {
  await vite.listen();
  await vite.watcher.close();
  await launch();
  await open(clean.project);
  await recover();
  await expect
    .poll(() => git(clean.remote, "rev-parse", "main").trim())
    .toBe(git(clean.project, "rev-parse", "HEAD").trim());
  assert.equal(
    git(clean.project, "show", "HEAD:notes.md"),
    "Remote finding.\n",
  );
  assert.equal(git(clean.project, "show", "HEAD:local.md"), "Local finding.\n");
  assert.equal(git(clean.project, "status", "--porcelain"), "");
  console.log("PASS: clean recovery merged and pushed both branches");

  await open(conflict.project);
  const remoteBefore = git(conflict.remote, "rev-parse", "main").trim();
  await recover(false);
  await expect(
    page.getByRole("button", { name: "Abort merge", exact: true }),
  ).toBeVisible();
  assert.equal(git(conflict.remote, "rev-parse", "main").trim(), remoteBefore);
  assert.notEqual(git(conflict.project, "ls-files", "-u"), "");
  // Restart with an unresolved merge: the default comes from real Git state.
  await close();
  await launch();
  await open(conflict.project);
  await page.evaluate(async (project) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("git_panel_resolve_conflict", {
      projectRoot: project,
      filePath: "notes.md",
      choice: "incoming",
    });
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().refreshFiles();
    window.dispatchEvent(new CustomEvent("catalex:git-stats-refresh"));
  }, conflict.project);
  await page.getByRole("button", { name: "Finish merge", exact: true }).click();
  const finish = page.getByRole("dialog", {
    name: "Finish merge",
    exact: true,
  });
  await expect(finish.getByTestId("git-commit-submit")).toHaveText(
    "Create merge commit",
  );
  await finish
    .getByRole("button", { name: "Finish merge & push", exact: true })
    .click();
  await expect(finish.getByTestId("git-commit-submit")).toHaveText(
    "Finish merge & push",
  );
  await expect(finish).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: path.join(desktopRoot, "test-results/git-merge-push-native.png"),
  });
  await finish.getByTestId("git-commit-submit").click();
  await expect(finish).toHaveCount(0);
  await expect
    .poll(() => git(conflict.remote, "rev-parse", "main").trim())
    .toBe(git(conflict.project, "rev-parse", "HEAD").trim());
  assert.equal(
    git(conflict.project, "show", "HEAD:notes.md"),
    "Remote finding.\n",
  );
  assert.equal(
    git(conflict.project, "rev-list", "--parents", "-1", "HEAD")
      .trim()
      .split(" ").length,
    3,
  );
  assert.equal(git(conflict.project, "status", "--porcelain"), "");
  console.log(
    "PASS: conflicts waited, survived restart, then committed and pushed the resolution",
  );

  await open(failed.project);
  const rejectedRemote = git(failed.remote, "rev-parse", "main").trim();
  await recover();
  await expect(
    page.getByText(/Pull and merge completed, but push failed/),
  ).toBeVisible();
  const mergedHead = git(failed.project, "rev-parse", "HEAD").trim();
  assert.equal(git(failed.remote, "rev-parse", "main").trim(), rejectedRemote);
  assert.equal(
    git(failed.project, "rev-list", "--parents", "-1", "HEAD").trim().split(" ")
      .length,
    3,
  );
  assert.equal(git(failed.project, "status", "--porcelain"), "");
  await fs.rm(path.join(failed.remote, "hooks/pre-receive"));
  await page.getByRole("button", { name: "Push", exact: true }).click();
  await expect
    .poll(() => git(failed.remote, "rev-parse", "main").trim())
    .toBe(mergedHead);
  assert.equal(git(failed.project, "rev-parse", "HEAD").trim(), mergedHead);
  console.log(
    "PASS: rejected push retained the merge; retry pushed the same commit",
  );
} catch (error) {
  await page
    ?.screenshot({
      path: path.join(
        desktopRoot,
        "test-results/git-merge-push-native-failed.png",
      ),
    })
    .catch(() => {});
  throw error;
} finally {
  if (app) await close().catch(() => app?.process().kill("SIGKILL"));
  await vite.close();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
