import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-auto-cache-"));
const id = "11111111-1111-4111-8111-111111111111";
const source = path.join(profile, "source");
const data = path.join(profile, "data");
const projectData = path.join(data, "projects", id);
const cache = path.join(profile, "project-cache/projects", id);
const schedule = path.join(data, "cache-cleanup.json");
const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
async function seedCache() {
  await fs.mkdir(cache, { recursive: true });
  await fs.writeFile(path.join(cache, "preview.pdf"), "rebuildable");
  await fs.utimes(path.join(cache, "preview.pdf"), old, old);
  await fs.utimes(cache, old, old);
}
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
try {
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "main.tex"), "source preserved");
  await fs.mkdir(path.join(projectData, "history.git"), { recursive: true });
  await fs.mkdir(path.join(projectData, "sessions"));
  await fs.writeFile(
    path.join(projectData, "history.git/sentinel"),
    "history preserved",
  );
  await fs.writeFile(
    path.join(projectData, "sessions/chat.json"),
    "session preserved",
  );
  await fs.writeFile(
    path.join(data, "project-registry.json"),
    JSON.stringify({ version: 1, projects: [{ id, paths: [source] }] }),
  );
  const metadata = path.join(projectData, "project.json");
  await fs.writeFile(
    metadata,
    JSON.stringify({ version: 1, currentPath: source }),
  );
  await fs.utimes(metadata, old, old);
  await seedCache();
  app = await electron.launch({ args: [desktopRoot], env });
  await app.firstWindow();
  await expect
    .poll(async () =>
      fs.access(schedule).then(
        () => true,
        () => false,
      ),
    )
    .toBe(true);
  await assert.rejects(fs.stat(cache), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(source, "main.tex"), "utf8"),
    "source preserved",
  );
  assert.equal(
    await fs.readFile(path.join(projectData, "history.git/sentinel"), "utf8"),
    "history preserved",
  );
  assert.equal(
    await fs.readFile(path.join(projectData, "sessions/chat.json"), "utf8"),
    "session preserved",
  );
  const firstSchedule = await fs.readFile(schedule, "utf8");
  await app.close();
  app = undefined;
  await seedCache();
  app = await electron.launch({ args: [desktopRoot], env });
  const window = await app.firstWindow();
  await window.locator("#loading-screen").waitFor({ state: "hidden" });
  // Inventory round-trip ensures the second app has initialized its storage host.
  await window.evaluate(() =>
    window.catalex.invoke("desktop:storage:list", {}),
  );
  assert.equal(await fs.readFile(schedule, "utf8"), firstSchedule);
  assert.equal(
    await fs.readFile(path.join(cache, "preview.pdf"), "utf8"),
    "rebuildable",
  );
  console.log(
    "Automatic cache cleanup passed: startup removes only stale cache, preserves source/history/sessions, and respects the daily check across restarts.",
  );
} finally {
  if (app) await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
