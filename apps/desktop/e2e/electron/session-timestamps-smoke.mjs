import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-session-times-"),
);
const projectPath = path.join(profile, "project");
await fs.mkdir(projectPath);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
let page;
async function launch() {
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
}
async function invoke(command, args) {
  return page.evaluate(
    async ({ command, args }) => {
      const reply = await window.catalex.invoke(command, args);
      if ("error" in reply) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    },
    { command, args },
  );
}
const payload = (provider) => ({
  projectPath,
  sharedSessionId: `time-${provider}`,
  title: `${provider} history`,
  lastProvider: provider,
  lastClaudeModel: "sonnet",
  lastCodexModel: "gpt-5.4",
  providerSessionIds: {},
  providerSyncCursors: {},
  messages: [{ type: "user", message: { content: "Earlier question" } }],
  pendingQuestion: null,
});
try {
  await launch();
  for (const provider of ["claude", "codex"]) {
    await invoke("save_shared_session", payload(provider));
  }
  // Age only our generated fixture records, so this check never needs sleeps.
  const entries = await fs.readdir(profile, { recursive: true });
  for (const provider of ["claude", "codex"]) {
    const entry = entries.find((entry) =>
      entry.endsWith(`/time-${provider}.json`),
    );
    assert.ok(entry, "fixture session was written by the native service");
    const file = path.join(profile, entry);
    const session = JSON.parse(await fs.readFile(file, "utf8"));
    session.created_at = 100;
    session.updated_at = 200;
    await fs.writeFile(file, JSON.stringify(session));
    const saved = await invoke("save_shared_session", payload(provider));
    assert.equal(saved.last_modified, 200);
  }
  await app.close();
  app = undefined;
  await launch();
  const listed = await invoke("list_shared_sessions", { projectPath });
  assert.equal(listed.length, 2);
  assert.ok(listed.every((session) => session.last_modified === 200));
  for (const provider of ["claude", "codex"]) {
    const loaded = await invoke("load_shared_session", {
      projectPath,
      sharedSessionId: `time-${provider}`,
    });
    assert.equal(loaded.last_modified, 200);
    const next = payload(provider);
    next.messages.push({
      type: "assistant",
      message: { content: "New answer" },
    });
    next.lastActivityAt = Math.floor(Date.now() / 1000);
    const saved = await invoke("save_shared_session", next);
    assert.ok(saved.last_modified > 200);
    const checkpoint = await invoke("save_shared_session", next);
    assert.equal(checkpoint.last_modified, saved.last_modified);
  }
  console.log(
    "PASS: both providers preserve history timestamps across checkpoints and an Electron restart; new messages advance them.",
  );
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
