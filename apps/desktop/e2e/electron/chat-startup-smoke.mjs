import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-chat-startup-"),
);
const project = path.join(profile, "Project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "# Startup check\n");
let app;
let vite;
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
  }, project);
  return page;
}
async function close() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}
async function state(page) {
  return page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { tabs, activeTabId } = useAgentChatStore.getState();
    return { tabs, activeTabId };
  });
}
try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  let page = await launch();
  await page.evaluate(async (root) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    for (const [title, archived] of [
      ["Earlier chat", false],
      ["Archived chat", true],
    ]) {
      const saved = await invoke("save_shared_session", {
        projectPath: root,
        title,
        lastProvider: "codex",
        providerSessionIds: {},
        providerSyncCursors: {},
        messages: [
          {
            type: "user",
            message: { content: [{ type: "text", text: title }] },
          },
        ],
      });
      if (archived)
        await invoke("set_shared_session_archived", {
          projectPath: root,
          sharedSessionId: saved.shared_session_id,
          archived: true,
        });
    }
  }, project);
  await close();
  page = await launch();
  let current = await state(page);
  assert(
    current.tabs.some((tab) => tab.title === "Earlier chat" && !tab.archived),
  );
  assert(
    !current.tabs.some((tab) => tab.title === "Archived chat" && !tab.archived),
  );
  assert.equal(
    current.tabs.find((tab) => tab.id === current.activeTabId).title,
    "New Chat",
  );
  await expect(
    page.locator('[data-chat-composer-input="true"]:visible').first(),
  ).toBeFocused();
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.setState({ drawerOpenRequested: true });
  });
  const earlier = current.tabs.find((tab) => tab.title === "Earlier chat");
  const historyTab = page.locator(`[data-tab-id="${earlier.id}"]`).first();
  await expect(historyTab).toBeVisible();
  await historyTab.hover();
  await historyTab.getByRole("button", { name: "Archive chat" }).click();
  await expect(historyTab).toHaveCount(0);
  await page.evaluate(
    async ({ root, id }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const sessions = await invoke("list_shared_sessions", {
        projectPath: root,
      });
      if (
        !sessions.find((session) => session.shared_session_id === id)?.archived
      )
        throw new Error("Archive was not persisted");
      await invoke("set_shared_session_archived", {
        projectPath: root,
        sharedSessionId: id,
        archived: false,
      });
      const { updateArchivedChatTab } = await import(
        "/src/renderer/lib/project-chat-lifecycle.ts"
      );
      await updateArchivedChatTab(root, id, false);
    },
    { root: project, id: earlier.sharedSessionId },
  );
  await expect(historyTab).toBeVisible();
  // Restore the state produced by graceful automatic pause; provider cancellation
  // itself is covered by the project lifecycle harness and unit tests.
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const store = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: store.tabs.map((tab) =>
        tab.title === "Earlier chat"
          ? {
              ...tab,
              pauseState: "paused",
              pausedRequest: { prompt: "Continue later" },
            }
          : tab,
      ),
    });
  });
  await close();
  page = await launch();
  current = await state(page);
  assert.equal(
    current.tabs.find((tab) => tab.id === current.activeTabId).title,
    "Earlier chat",
  );
  assert.equal(
    current.tabs.find((tab) => tab.id === current.activeTabId).pauseState,
    "paused",
  );
  await page.screenshot({
    path: path.join(profile, "paused-startup.png"),
    animations: "disabled",
  });
  console.log(
    `Native restart checks passed. Screenshot: ${path.join(profile, "paused-startup.png")}`,
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
}
