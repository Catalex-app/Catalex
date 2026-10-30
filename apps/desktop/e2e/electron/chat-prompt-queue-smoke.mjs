import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-queued-prompts-"),
);
const project = path.join(profile, "Queue Project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "main.md"), "# Queue persistence\n");
let server, app;
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: server.resolvedUrls.local[0],
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async (project) => {
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish();
    (await import("/src/renderer/stores/settings-store.ts")).useSettingsStore
      .getState()
      .setWorkspacePreferences(project, { mode: "duet", chatLayout: "drawer" });
    await (
      await import("/src/renderer/stores/document-store.ts")
    ).useDocumentStore
      .getState()
      .openProject(project);
  }, project);
  return page;
}
try {
  server = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  let page = await launch();
  const queuedBefore = await page.evaluate(async () => {
    const chat = (await import("/src/renderer/stores/agent-chat-store.ts"))
      .useAgentChatStore;
    const id = chat.getState().createTab();
    chat.getState()._setStreaming(id, true);
    const store = chat.getState();
    await store.sendPrompt("First queued prompt", [
      { label: "@main.md:1:1-1:6", filePath: "main.md", selectedText: "Queue" },
    ]);
    await chat.getState().sendPrompt("Second queued prompt", []);
    await chat.getState().sendPrompt("Third queued prompt", []);
    const queue = chat.getState().tabs.find((t) => t.id === id).queuedPrompts;
    chat.getState().moveQueuedPrompt(id, queue[2].id, queue[0].id);
    chat.getState().saveDraft(id, {
      input: "Original composer draft",
      pinnedContexts: [
        {
          label: "@saved.md",
          filePath: "saved.md",
          selectedText: "Saved attachment",
        },
      ],
    });
    chat.getState().editQueuedPrompt(id, queue[0].id);
    const draft = chat.getState().tabs.find((t) => t.id === id).draft;
    chat
      .getState()
      .saveDraft(id, { ...draft, input: "Unfinished edit survives restart" });
    chat.getState().requestDrawerOpen();
    chat.getState()._setStreaming(id, false);
    await (
      await import("/src/renderer/lib/project-chat-lifecycle.ts")
    ).saveProjectChats();
    return chat.getState().tabs.find((t) => t.id === id).queuedPrompts;
  });
  assert.equal(queuedBefore.length, 2);
  await app.close();
  app = null;
  page = await launch();
  const after = await page.evaluate(async () => {
    const chat = (await import("/src/renderer/stores/agent-chat-store.ts"))
      .useAgentChatStore;
    const tab = chat.getState().tabs.find((t) => t.queuedPrompts?.length);
    if (!tab) throw new Error("Queued prompts missing after restart");
    chat.getState().setActiveTab(tab.id);
    chat.getState().requestDrawerOpen();
    return {
      queue: tab.queuedPrompts,
      paused: tab.promptQueuePaused,
      dispatching: tab.dispatchingQueuedPromptId,
      streaming: tab.isStreaming,
      draft: tab.draft,
    };
  });
  assert.deepEqual(after.queue, queuedBefore);
  assert.equal(after.paused, true);
  assert.equal(after.dispatching, null);
  assert.equal(after.streaming, false);
  assert.equal(after.draft.input, "Unfinished edit survives restart");
  assert.equal(after.draft.pinnedContexts[0].selectedText, "Queue");
  await expect(
    page.locator(
      '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"] li',
    ),
  ).toHaveCount(2);
  const input = page
    .locator(
      '[data-chat-drawer-panel="true"] textarea[data-chat-composer-input="true"]:visible',
    )
    .last();
  await expect(input).toHaveValue("Unfinished edit survives restart");
  const panel = page.locator('[data-chat-drawer-panel="true"]');
  await expect(
    panel.getByRole("button", {
      name: "Cancel editing queued prompt",
      exact: true,
    }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(panel.locator('[data-chat-prompt-queue="true"] li')).toHaveCount(
    3,
  );
  await expect(
    panel.locator('[data-chat-prompt-queue="true"] li').last(),
  ).toContainText("Unfinished edit survives restart");
  await page.screenshot({
    path: path.join(os.tmpdir(), "catalex-chat-prompt-queue.png"),
  });
  console.log(
    "PASS: real Electron queue order, context, normal composer draft, and paused restoration survive a full process restart.",
  );
} finally {
  if (app) await app.close();
  if (server) await server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
