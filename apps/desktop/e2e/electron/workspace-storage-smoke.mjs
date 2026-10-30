import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Production renderer/native IPC, large legacy browser data, and a full restart.
// Never touches the installed application's profile or calls an AI provider.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-quota-"));
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const key = "catalex-project-chats:/unopened-quota-test";
let app;
const errors = [];
async function launch() {
  app = await electron.launch({ args: [root], env, timeout: 30_000 });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  return page;
}
try {
  let page = await launch();
  const stored = await page.evaluate((key) => {
    let previous = "";
    for (let mb = 1; mb <= 32; mb++) {
      const value = JSON.stringify({
        tabs: [],
        retainedHistory: "x".repeat(mb * 1024 * 1024),
      });
      try {
        localStorage.setItem(key, value);
        previous = value;
      } catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        return { length: previous.length, quotaReached: true };
      }
    }
    return { length: previous.length, quotaReached: false };
  }, key);
  const storedLength = stored.length;
  assert.ok(storedLength > 1024 * 1024);
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  const migrated = await page.evaluate(async (key) => {
    const reply = await window.catalex.invoke("desktop:workspace-state:read", {
      key,
    });
    if (reply.error) throw new Error(String(reply.error));
    localStorage.setItem("quota-test-preference", "y".repeat(1024 * 1024));
    localStorage.removeItem("quota-test-preference");
    return {
      length: reply.result.value.length,
      removed: localStorage.getItem(key) === null,
    };
  }, key);
  assert.equal(migrated.length, storedLength);
  assert.equal(migrated.removed, true);
  await app.close();
  app = undefined;
  page = await launch();
  const restartedLength = await page.evaluate(async (key) => {
    const reply = await window.catalex.invoke("desktop:workspace-state:read", {
      key,
    });
    if (reply.error) throw new Error(String(reply.error));
    return reply.result.value.length;
  }, key);
  assert.equal(restartedLength, storedLength);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: legacy browser data (quota reached: ${stored.quotaReached}); ${storedLength} characters preserved outside browser storage, space freed, full restart verified.`,
  );
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
