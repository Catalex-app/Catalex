import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-attachments-"),
);
const project = path.join(profile, "project");
await fs.mkdir(project);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
try {
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => !!window.catalex);
  const invoke = (args) =>
    page.evaluate(async (args) => {
      const reply = await window.catalex.invoke(
        "desktop:chat:attachment",
        args,
      );
      if ("error" in reply) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    }, args);
  const source = path.join(root, "package.json");
  assert.equal(
    await invoke({ projectRoot: project, sourcePath: source }),
    await fs.realpath(source),
  );
  const shot = await invoke({
    projectRoot: project,
    name: "shot.png",
    bytes: [1, 2, 3],
  });
  assert.ok(shot.includes("/data/projects/"));
  assert.ok(shot.includes("/sessions/media/"));
  assert.deepEqual([...(await fs.readFile(shot))], [1, 2, 3]);
  assert.deepEqual(await fs.readdir(project), []);
  console.log(
    "Electron attachment IPC preserves original paths, persists clipboard data, and leaves the project empty.",
  );
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
