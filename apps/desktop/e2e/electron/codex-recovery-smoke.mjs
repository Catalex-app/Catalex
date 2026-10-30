import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Requires a running normal Vite app and a freshly compiled native debug helper.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-refinement-ipc-"),
);
const projectRoot = path.join(profile, "Review refinement project");
await fs.mkdir(projectRoot);
await fs.writeFile(path.join(projectRoot, "notes.md"), "Original source\n");
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: process.env.CATALEX_DEV_URL ?? "http://127.0.0.1:4173",
  CATALEX_SERVICE_PATH:
    process.env.CATALEX_SERVICE_PATH ??
    path.join(desktopRoot, "backend/target/debug/catalex-desktop"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [desktopRoot], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () =>
      !!window.catalex && document.querySelector("#root")?.children.length > 0,
  );
  const result = await page.evaluate(async (_root) => {
    const invoke = async (command, args) => {
      const reply = await window.catalex.invoke(command, args);
      if ("error" in reply) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    };
    const results = [];
    for (const command of [
      "check_codex_session_owner",
      "reconnect_codex_session",
    ]) {
      try {
        await invoke(command, {
          tabId: "missing-runtime",
          sessionId: "unknown-session",
          ownerToken: "unverified",
          model: "gpt-5.4",
          reasoningEffort: "medium",
        });
        throw new Error("Unverified recovery unexpectedly succeeded");
      } catch (error) {
        if (!String(error).includes("runtime is no longer available"))
          throw error;
        results.push(command);
      }
    }
    return results;
  }, projectRoot);
  assert.equal(result.length, 2);
  console.log(
    "Real Electron IPC: both recovery commands reject an unverified runtime.",
  );
} finally {
  if (app) await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
