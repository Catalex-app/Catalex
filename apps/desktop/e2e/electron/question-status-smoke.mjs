import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// Real checkpoint IPC and app restarts, with saved conversation fixtures and
// no provider calls. The answered chats must remain unopened during assertions.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-questions-"));
const project = path.join(profile, "Questions project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/question-status",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(project, "notes.md"), "# Question status\n");
const errors = [];
let vite;
let app;

async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
  const window = await app.browserWindow(page);
  await window.evaluate((window) => {
    window.unmaximize();
    window.setSize(1440, 1000);
  });
  return page;
}

async function close() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}

async function openProject(page) {
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
  }, project);
  await page.locator(".cm-content").first().waitFor();
}

async function verify(page, name) {
  const tabs = await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const state = useAgentChatStore.getState();
    return state.tabs
      .filter((tab) => tab.id.startsWith("question-"))
      .map((tab) => ({
        id: tab.id,
        active: state.activeTabId === tab.id,
        pending: tab.pendingQuestion?.requestId ?? null,
        loaded: tab.messages.length,
        total: tab.history?.total,
      }));
  });
  assert.deepEqual(tabs, [
    {
      id: "question-claude",
      active: false,
      pending: null,
      loaded: 0,
      total: 301,
    },
    {
      id: "question-codex",
      active: false,
      pending: null,
      loaded: 0,
      total: 301,
    },
    {
      id: "question-unanswered",
      active: false,
      pending: "unanswered",
      loaded: 0,
      total: 301,
    },
  ]);
  await page
    .getByRole("button", { name: "Session history", exact: true })
    .click();
  const sessions = page.getByRole("menu");
  for (const title of ["Answered Claude", "Answered Codex"]) {
    const row = sessions.getByRole("menuitem").filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(
      row.getByRole("img", { name: "Awaiting your answer" }),
    ).toHaveCount(0);
  }
  const pending = sessions
    .getByRole("menuitem")
    .filter({ hasText: "Unanswered question" });
  await expect(
    pending.getByRole("img", { name: "Awaiting your answer" }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(artifacts, `${name}.png`),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
}

try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  let page = await launch();
  await openProject(page);
  console.log("Project opened; seeding saved question fixtures.");
  await page.evaluate(async (projectRoot) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { saveProjectChats } = await import(
      "/src/renderer/lib/project-chat-lifecycle.ts"
    );
    const base = useAgentChatStore.getState().tabs[0];
    const tabs = ["claude", "codex", "unanswered"].map((kind) => ({
      ...base,
      id: `question-${kind}`,
      runtimeSessionKey: `runtime-${kind}`,
      provider: kind === "codex" ? "codex" : "claude",
      title:
        kind === "unanswered"
          ? "Unanswered question"
          : `Answered ${kind === "codex" ? "Codex" : "Claude"}`,
      pendingQuestion: {
        requestId: kind,
        projectRoot,
        question: "What next?",
        options: [],
      },
      messages: [
        {
          type: "user",
          uuid:
            kind === "unanswered"
              ? "original-prompt"
              : `question-answer-${kind}`,
          message: { content: [{ type: "text", text: "Update" }] },
        },
        ...Array.from({ length: 300 }, (_, index) => ({
          type: "assistant",
          uuid: `${kind}-${index}`,
          message: { content: [{ type: "text", text: `Reply ${index}` }] },
        })),
      ],
    }));
    // Recreate metadata written by older Electron versions. The normal shared
    // session copy already knows the answer; only the checkpoint was stale.
    useAgentChatStore.setState({ tabs: [...tabs, base] });
    for (const tab of tabs)
      await useAgentChatStore.getState()._syncSharedSession(tab.id);
    await saveProjectChats();
  }, project);
  console.log("Fixtures saved; reopening project.");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    if (!(await useDocumentStore.getState().closeProject()))
      throw new Error("Project close failed");
  });
  await openProject(page);
  await verify(page, "project-reopen");
  await close();
  page = await launch();
  await openProject(page);
  await verify(page, "app-restart");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: answered chat icons stay cleared before selection after project reopen and Electron restart; unanswered question preserved.",
  );
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
