import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-chat-checkpoints-"),
);
const project = path.join(profile, "project");
await fs.mkdir(project);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
async function launch() {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
  return (command, args = {}) =>
    page.evaluate(
      async ({ command, args }) => {
        const reply = await window.catalex.invoke(command, args);
        if ("error" in reply) throw new Error(JSON.stringify(reply.error));
        return reply.result;
      },
      { command, args: { projectRoot: project, ...args } },
    );
}
try {
  let invoke = await launch();
  const messages = Array.from({ length: 2000 }, (_, index) => ({
    index,
    type: "assistant",
    message: { content: [{ type: "text", text: `Answer ${index}` }] },
    text: "x".repeat(4096),
  }));
  await invoke("save_shared_session", {
    projectPath: project,
    sharedSessionId: "test-shared",
    title: "Long chat",
    lastProvider: "claude",
    providerSessionIds: { claude: "native-id" },
    messages,
  });
  await invoke("desktop:chat:checkpoint-save", {
    snapshot: {
      version: 1,
      activeTabId: "test",
      tabs: [
        {
          id: "test",
          runtimeSessionKey: "test-runtime",
          sharedSessionId: "test-shared",
          messages,
          draft: { input: "keep draft" },
          providerSessionIds: { claude: "native-id" },
          pauseState: "paused",
        },
      ],
    },
  });
  const decision = {
    uuid: "review-once",
    type: "system",
    subtype: "draft_review_decisions",
    message: { content: [{ type: "text", text: "rejected" }] },
  };
  await invoke("desktop:chat:append-review", {
    tabId: "test",
    runtimeSessionKey: "test-runtime",
    message: decision,
  });
  await app.close();
  app = null;
  invoke = await launch();
  const checkpoint = await invoke("desktop:chat:checkpoint-load");
  assert.equal(checkpoint.tabs[0].messages.length, 0);
  assert.equal(checkpoint.tabs[0].history.total, 2001);
  assert.equal(checkpoint.tabs[0].draft.input, "keep draft");
  assert.equal(checkpoint.tabs[0].providerSessionIds.claude, "native-id");
  assert.equal(checkpoint.tabs[0].pauseState, "paused");
  const page = await invoke("desktop:chat:messages", {
    tabId: "test",
    start: 1990,
    limit: 10,
  });
  assert.deepEqual(page, messages.slice(1990));
  assert.equal(
    await invoke("desktop:chat:append-review", {
      tabId: "test",
      runtimeSessionKey: "test-runtime",
      message: decision,
    }),
    2001,
  );
  assert.deepEqual(
    await invoke("desktop:chat:messages", {
      tabId: "test",
      start: 2000,
      limit: 1,
    }),
    [decision],
  );
  const shared = await invoke("load_shared_session", {
    projectPath: project,
    sharedSessionId: "test-shared",
  });
  assert.equal(shared.messages.length, 2001);
  assert.deepEqual(shared.messages.at(-1), decision);
  const prepared = await invoke("desktop:chat:prepare-turn", {
    tabId: "test",
    runtimeSessionKey: "test-runtime",
    cursor: 2000,
    retry: false,
  });
  assert.ok(prepared.messages.length <= 300);
  assert.equal(prepared.transcript, "");
  await invoke("desktop:chat:sync-shared", {
    tabId: "test",
    runtimeSessionKey: "test-runtime",
    sharedSessionId: "test-shared",
    pendingQuestion: null,
  });
  const fork = await invoke("desktop:chat:fork", {
    tabId: "test",
    runtimeSessionKey: "test-runtime",
    messageIndex: 1754,
    tab: {
      id: "fork",
      runtimeSessionKey: "fork-runtime",
      provider: "codex",
      title: "Fork",
      messages: [],
    },
  });
  assert.equal(fork.history.total, 1755);
  assert.deepEqual(fork.messages, []);
  const forkPage = await invoke("desktop:chat:messages", {
    tabId: "fork",
    start: 1750,
    limit: 20,
  });
  assert.deepEqual(forkPage, messages.slice(1750, 1755));
  await invoke("desktop:chat:cancel-fork", {
    tabId: "fork",
    sharedSessionId: fork.sharedSessionId,
  });
  assert.deepEqual(await fs.readdir(project), []);
  console.log(
    "Electron restart, bounded native-session preparation, backend shared save, and independent fork passed on an 8 MB history.",
  );
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
