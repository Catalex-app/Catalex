import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-scroll-sync-"),
);
const projects = ["first", "second"].map((name) => path.join(profile, name));
for (const project of projects) {
  await fs.mkdir(project);
  for (const file of ["main.tex", "other.tex", "README.md"]) {
    await fs.writeFile(
      path.join(project, file),
      file.endsWith(".tex")
        ? "\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\n"
        : "# Notes\n\nHello\n",
    );
  }
}
const artifacts = path.resolve(
  root,
  "../../output/playwright/electron/scroll-sync",
);
await fs.mkdir(artifacts, { recursive: true });
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: vite.resolvedUrls.local[0],
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
async function ready(page) {
  await page.waitForFunction(() => Boolean(window.catalex));
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
  return page;
}
async function launch() {
  app = await electron.launch({ args: [root], env });
  return ready(await app.firstWindow());
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}
async function open(page, project) {
  await page.evaluate(async (project) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
  }, project);
  await select(page, "main.tex");
}
async function select(page, file) {
  await page.evaluate(async (file) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile(file);
  }, file);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.locator("[data-scroll-sync-muted]")).toBeVisible();
}
const sync = (page, enabled) =>
  page.getByRole("button", {
    name: `${enabled ? "Disable" : "Enable"} synchronized scrolling`,
    exact: true,
  });
async function preferences(page) {
  return page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    return useSettingsStore.getState().scrollSyncByProject;
  });
}
try {
  let first = await launch();
  await first.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.getState().setDefaultAutoCompile(false);
  });
  await open(first, projects[0]);
  await expect(sync(first, true)).toHaveAttribute("aria-pressed", "true");
  await sync(first, true).click();
  await expect(sync(first, false)).toHaveAttribute("aria-pressed", "false");
  await select(first, "other.tex");
  await expect(sync(first, true)).toBeVisible();
  await sync(first, true).click();
  await sync(first, false).click();
  await select(first, "README.md");
  await expect(sync(first, true)).toBeVisible();
  await sync(first, true).click();
  await select(first, "main.tex");
  await expect(sync(first, false)).toBeVisible();
  assert.equal(
    await first.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      return useDocumentStore.getState().closeProject();
    }),
    true,
  );
  await open(first, projects[0]);
  await expect(sync(first, false)).toBeVisible();
  await first.screenshot({
    path: path.join(artifacts, "reopened-unsynced.png"),
  });

  const opened = app.waitForEvent("window");
  await first.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await ready(await opened);
  await open(second, projects[1]);
  await expect(sync(second, true)).toBeVisible();
  await sync(second, true).click();
  await expect
    .poll(async () => (await preferences(first))[projects[1]]?.["main.tex"])
    .toBe(false);
  await select(first, "other.tex");
  await expect(sync(first, true)).toBeVisible();
  const expected = {
    [projects[0]]: { "main.tex": false, "other.tex": true, "README.md": false },
    [projects[1]]: { "main.tex": false },
  };
  assert.deepEqual(await preferences(first), expected);
  await quit();

  first = await launch();
  assert.deepEqual(await preferences(first), expected);
  await open(first, projects[0]);
  await expect(sync(first, false)).toBeVisible();
  await select(first, "other.tex");
  await expect(sync(first, true)).toBeVisible();
  await select(first, "README.md");
  await expect(sync(first, false)).toBeVisible();
  await open(first, projects[1]);
  await expect(sync(first, false)).toBeVisible();
  console.log(
    "PASS: per-file defaults and choices survive project reopen, independent windows, and a full Electron restart.",
  );
} finally {
  if (app) await quit();
  await vite.close();
}
