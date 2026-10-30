import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Exercise default storage selection in a temporary home, without the isolated
// profile override that deliberately bypasses the production directory names.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-storage-name-"));
const appData = path.join(root, "app-data");
const cacheBase =
  process.platform === "darwin"
    ? path.join(root, "Library", "Caches")
    : path.join(root, "cache");
const dataBase =
  process.platform === "linux" ? path.join(root, "data") : appData;
const oldRoots = [
  path.join(appData, "TexBuddy-Electron"),
  path.join(dataBase, "com.texbuddy.desktop"),
  path.join(cacheBase, "com.texbuddy.desktop"),
];
for (const directory of oldRoots) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "keep.txt"),
    "Old state remains untouched",
  );
}
const bootstrap = path.join(root, "bootstrap.cjs");
await fs.writeFile(
  bootstrap,
  `const { app } = require('electron');
app.setPath('appData', ${JSON.stringify(appData)});
require('node:os').homedir = () => ${JSON.stringify(root)};
require(${JSON.stringify(path.join(desktopRoot, "dist/main/index.cjs"))});`,
);
const env = {
  ...process.env,
  XDG_DATA_HOME: dataBase,
  XDG_CACHE_HOME: cacheBase,
  LOCALAPPDATA: cacheBase,
};
delete env.CATALEX_USER_DATA_DIR;
delete env.CATALEX_DEV_URL;
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  for (let pass = 0; pass < 2; pass++) {
    app = await electron.launch({ args: [bootstrap], env });
    const page = await app.firstWindow();
    await page.locator("#loading-screen").waitFor({ state: "hidden" });
    assert.equal(
      await app.evaluate(({ app }) => app.getPath("userData")),
      path.join(appData, "Catalex-Electron"),
    );
    const inventory = await page.evaluate(async () => {
      const reply = await window.catalex.invoke("desktop:storage:list", {});
      if (reply.error) throw new Error(String(reply.error));
      return reply.result;
    });
    assert.equal(
      inventory.dataPath,
      path.join(dataBase, "com.catalex.desktop"),
    );
    assert.equal(
      inventory.cachePath,
      path.join(cacheBase, "com.catalex.desktop"),
    );
    if (pass === 0) {
      assert.equal(inventory.projects.length, 0);
      await page.evaluate(() =>
        localStorage.setItem("storage-name-smoke", "saved"),
      );
    } else {
      assert.equal(
        await page.evaluate(() => localStorage.getItem("storage-name-smoke")),
        "saved",
      );
    }
    await app.close();
    app = undefined;
    for (const directory of oldRoots) {
      assert.deepEqual(await fs.readdir(directory), ["keep.txt"]);
      assert.equal(
        await fs.readFile(path.join(directory, "keep.txt"), "utf8"),
        "Old state remains untouched",
      );
    }
  }
  console.log(
    "Catalex default storage paths verified; new profile persists across restart and old folders remain untouched.",
  );
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
