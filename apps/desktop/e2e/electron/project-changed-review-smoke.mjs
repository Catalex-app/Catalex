import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-review-interrupt-"),
);
const config = path.join(fixture, "gitconfig");
await fs.writeFile(
  config,
  "[user]\n name = Review fixture\n email = fixture@example.invalid\n[commit]\n gpgsign = false\n",
);
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: "1",
  CATALEX_USER_DATA_DIR: path.join(fixture, "profile"),
};
delete env.ELECTRON_RUN_AS_NODE;
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
const vite = await createServer({
  root: desktopRoot,
  server: { host: "127.0.0.1", port: 0, strictPort: false, watch: null },
});
let app;
let page;
async function invoke(command, args) {
  return page.evaluate(
    async ({ command, args }) => {
      const response = await window.catalex.invoke(command, args);
      if ("error" in response) throw new Error(JSON.stringify(response.error));
      return response.result;
    },
    { command, args },
  );
}
async function prepare(name) {
  const root = path.join(fixture, name);
  await fs.mkdir(root);
  git(root, "init", "--initial-branch=main");
  await fs.writeFile(path.join(root, "notes.md"), "Original finding.\n");
  await fs.writeFile(path.join(root, "remaining.md"), "Original remaining.\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "Baseline");
  // Independent branches establish a real unresolved external merge fixture.
  git(root, "checkout", "-b", "incoming");
  await fs.writeFile(path.join(root, "notes.md"), "Incoming finding.\n");
  git(root, "commit", "-am", "Incoming");
  git(root, "checkout", "main");
  await page.evaluate(async (root) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore
      .getState()
      .setWorkspacePreferences(root, { mode: "artisan", chatLayout: "drawer" });
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
  }, root);
  const tabId = await page.evaluate(
    async () =>
      (
        await import("/src/renderer/stores/agent-chat-store.ts")
      ).useAgentChatStore.getState().activeTabId,
  );
  const session = await invoke("prepare_agent_workspace", {
    projectRoot: root,
    tabId,
    mode: "ask",
    dirtyBuffers: [],
  });
  await fs.writeFile(
    path.join(session.candidateRoot, "notes.md"),
    "Accepted finding.\n",
  );
  await fs.writeFile(
    path.join(session.candidateRoot, "remaining.md"),
    "Remaining proposal.\n",
  );
  const result = await invoke("reconcile_agent_workspace", {
    projectRoot: root,
    sessionId: session.sessionId,
    outcome: "success",
  });
  await page.evaluate(async (session) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.getState()._setAgentWorkspace(session.tabId, session);
    const { useAgentReviewQueueStore } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    await useAgentReviewQueueStore.getState().enqueue(session);
  }, result.session);
  const panel = page.locator("[data-proposed-changes-panel]");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Accept All", exact: true }).click();
  await expect
    .poll(() => fs.readFile(path.join(root, "notes.md"), "utf8"))
    .toBe("Accepted finding.\n");
  await expect(panel).toBeVisible();
  await expect.poll(async () => (await snapshot()).phase).toBe("review");
  return { root, session };
}
async function snapshot() {
  return page.evaluate(async () => {
    const { useAgentReviewQueueStore } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const doc = useDocumentStore.getState();
    return {
      ...useAgentReviewQueueStore
        .getState()
        .entries.find((e) => e.session.projectRoot === doc.projectRoot),
      workspace: doc.agentWorkspaceRoot,
    };
  });
}
async function acknowledge() {
  const dialog = page.getByRole("dialog", {
    name: "Project changed externally",
  });
  await expect(dialog).toBeVisible();
  assert.equal((await snapshot()).phase, "question");
  await dialog.getByRole("button", { name: "Got it" }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await snapshot()).workspace, null);
  assert.equal((await snapshot()).interrupted, true);
}
try {
  await vite.listen();
  await vite.watcher.close();
  app = await electron.launch({
    args: [desktopRoot],
    env: { ...env, CATALEX_DEV_URL: vite.resolvedUrls.local[0] },
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async () =>
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish(),
  );
  const deleted = await prepare("deleted");
  await fs.unlink(path.join(deleted.root, "notes.md"));
  await acknowledge();
  await assert.rejects(fs.stat(path.join(deleted.root, "notes.md")), {
    code: "ENOENT",
  });
  assert.equal(
    await fs.readFile(
      path.join(deleted.session.candidateRoot, "remaining.md"),
      "utf8",
    ),
    "Remaining proposal.\n",
  );
  console.log(
    "PASS: partially accepted file deletion exits review and preserves draft",
  );
  const switched = await prepare("switched");
  git(switched.root, "checkout", "-b", "external-branch");
  await acknowledge();
  console.log("PASS: Git-only branch change exits acceptance");
  const merged = await prepare("merged");
  git(merged.root, "commit", "-am", "Accepted changes");
  try {
    git(merged.root, "merge", "incoming");
  } catch {}
  await fs.writeFile(
    path.join(merged.root, "notes.md"),
    "Externally resolved.\n",
  );
  git(merged.root, "add", "notes.md");
  git(merged.root, "commit", "-m", "Resolved externally");
  await acknowledge();
  assert.equal(
    await fs.readFile(path.join(merged.root, "notes.md"), "utf8"),
    "Externally resolved.\n",
  );
  console.log("PASS: completed external merge remains authoritative");
  const conflict = await prepare("conflicted");
  git(conflict.root, "commit", "-am", "Accepted changes");
  try {
    git(conflict.root, "merge", "incoming");
  } catch {}
  await acknowledge();
  await expect(
    page.getByRole("button", { name: "Abort merge", exact: true }),
  ).toBeVisible();
  assert.notEqual(git(conflict.root, "ls-files", "-u"), "");
  console.log(
    "PASS: unresolved external merge returns to existing Git controls",
  );
} finally {
  if (app) await app.close();
  await vite.close();
  console.log(`Fixture: ${fixture}`);
}
