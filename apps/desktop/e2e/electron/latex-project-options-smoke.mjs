import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-latex-options-"),
);
const project = path.join(profile, "project");
const artifacts = path.resolve(
  root,
  "../../output/playwright/electron/latex-project-options",
);
await fs.mkdir(path.join(project, "paper"), { recursive: true });
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}Other document\\end{document}",
);
await fs.writeFile(
  path.join(project, "shared.tex"),
  "Shared text from parent folder.",
);
await fs.writeFile(
  path.join(project, "paper", "article.tex"),
  "\\documentclass{article}\n\\begin{document}\nRoot folder smoke test.\n\\input{../shared}\n\\end{document}\n",
);
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let page;
async function launch() {
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      defaultAutoCompile: false,
      latexInstallation: "/Library/TeX/texbin",
      compilerBackend: "latexmk",
      compilerEngine: "pdflatex",
    });
  });
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => setImmediate(() => app.quit()));
  await closed;
  app = undefined;
}
async function open() {
  await page.evaluate(async (project) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(project);
  }, project);
  await expect(
    page.getByRole("button", { name: "Compilation options", exact: true }),
  ).toBeVisible({ timeout: 20000 });
}
async function choices(target = page) {
  return target.evaluate(async (project) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    return useProjectStore.getState().latexOptionsByProject[project];
  }, project);
}
async function compile() {
  return page.evaluate(async () => {
    const { compileWorkspace } = await import(
      "/src/renderer/lib/workspace-compile.ts"
    );
    await compileWorkspace({ force: true });
    const { useDocumentStore, getCurrentPdfBytes } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { getSynctexSourceMap } = await import(
      "/src/renderer/lib/latex-compiler.ts"
    );
    const state = useDocumentStore.getState();
    return {
      error: state.compileError,
      bytes: getCurrentPdfBytes()?.byteLength ?? 0,
      map: await getSynctexSourceMap(state.projectRoot),
    };
  });
}
try {
  await launch();
  await open();
  await page
    .getByRole("button", { name: "Compilation options", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^LaTeX root/ }).hover();
  await page.getByRole("menuitemradio", { name: "paper", exact: true }).click();
  await page
    .getByRole("button", { name: "Compilation options", exact: true })
    .click();
  await page.getByRole("menuitem", { name: /^Main file/ }).hover();
  await page
    .getByRole("menuitemradio", { name: "article.tex", exact: true })
    .click();
  assert.deepEqual(await choices(), {
    rootFolder: "paper",
    mainFile: "paper/article.tex",
  });
  const result = await compile();
  assert.equal(result.error, null);
  assert.ok(result.bytes > 0);
  assert.ok(Object.values(result.map.inputs).includes("paper/article.tex"));
  assert.ok(Object.values(result.map.inputs).includes("shared.tex"));
  await page
    .getByRole("button", { name: "Compilation options", exact: true })
    .click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(artifacts, "menu.png") });
  await page.keyboard.press("Escape");
  const popped = app.waitForEvent("window");
  await page.evaluate(async () => {
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    openPanelWindow("preview", "sidecar");
  });
  const preview = await popped;
  await preview.waitForFunction(() => Boolean(window.catalex));
  await expect.poll(() => choices(preview)).toEqual(await choices());
  await preview.evaluate(async (project) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore
      .getState()
      .setLatexProjectOptions(project, { rootFolder: "paper", mainFile: null });
  }, project);
  await expect
    .poll(() => choices())
    .toEqual({ rootFolder: "paper", mainFile: null });
  await preview.evaluate(async (project) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore.getState().setLatexProjectOptions(project, {
      rootFolder: "paper",
      mainFile: "paper/article.tex",
    });
    const { compileWorkspace } = await import(
      "/src/renderer/lib/workspace-compile.ts"
    );
    await compileWorkspace({ force: true });
  }, project);
  await expect
    .poll(() => choices())
    .toEqual({ rootFolder: "paper", mainFile: "paper/article.tex" });
  await preview.close();
  // A second native window sees the saved choice through the existing persistence bridge.
  const opened = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await opened;
  await second.waitForFunction(() => Boolean(window.catalex));
  await expect.poll(() => choices(second)).toEqual(await choices());
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore
      .getState()
      .renameFile("paper/article.tex", "renamed.tex");
    await useDocumentStore.getState().renameFolder("paper", "manuscript");
  });
  const renamed = {
    rootFolder: "manuscript",
    mainFile: "manuscript/renamed.tex",
  };
  await expect.poll(() => choices(second)).toEqual(renamed);
  assert.equal((await compile()).error, null);
  await quit();
  await launch();
  assert.deepEqual(await choices(), renamed);
  await open();
  assert.equal((await compile()).error, null);
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().deleteFile("manuscript/renamed.tex");
  });
  const missing = await compile();
  assert.match(missing.error, /Main file not found/);
  assert.equal(missing.bytes, 0);
  console.log(
    JSON.stringify({
      ok: true,
      profile,
      artifacts,
      checks: [
        "native root-folder compilation with parent inputs",
        "project-relative SyncTeX",
        "cross-window settings",
        "rename file and folder",
        "full restart persistence",
        "missing main file blocks fallback",
      ],
    }),
  );
} finally {
  if (app) await app.close();
  await vite.close();
}
