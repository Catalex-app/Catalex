import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-compilation-settings-"),
);
const bin = path.join(profile, "bin");
const builds = path.join(profile, "builds.jsonl");
await fs.mkdir(bin);
// Exercise the real service and subprocess arguments without depending on fonts.
await fs.writeFile(
  path.join(bin, "latexmk"),
  `#!${process.execPath}
const fs = require('node:fs');
const file = process.argv.at(-1);
if (!file.endsWith('.tex')) process.exit(0);
fs.appendFileSync(${JSON.stringify(builds)}, JSON.stringify(process.argv.slice(2)) + '\\n');
fs.copyFileSync(${JSON.stringify(path.join(root, "public/examples/letter-formal/main.pdf"))}, file.replace(/\\.tex$/, '.pdf'));
`,
  { mode: 0o755 },
);
await fs.writeFile(path.join(bin, "pdflatex"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
const projects = {};
for (const name of ["first", "second"]) {
  projects[name] = path.join(profile, name);
  await fs.mkdir(projects[name]);
  await fs.writeFile(
    path.join(projects[name], "main.tex"),
    "% !TEX program = xelatex\n\\documentclass{article}\n\\begin{document}Test\\end{document}\n",
  );
}
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
let app;
let page;
try {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  async function launch() {
    app = await electron.launch({ args: [root], env });
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.catalex));
    await page.evaluate(async () => {
      const { useOnboardingStore } = await import(
        "/src/renderer/stores/onboarding-store.ts"
      );
      useOnboardingStore.getState().finish();
    });
  }
  async function quit() {
    const exited = app.waitForEvent("close");
    await app.evaluate(({ app }) => setImmediate(() => app.quit()));
    await exited;
    app = undefined;
  }
  async function settings() {
    return page.evaluate(
      async ({ projects }) => {
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        const s = useSettingsStore.getState();
        return {
          defaultAutoCompile: s.defaultAutoCompile,
          first: s.getProjectAutoCompile(projects.first),
          second: s.getProjectAutoCompile(projects.second),
          firstEngine: s.getCompilerChoiceForRoot(projects.first, "main.tex")
            ?.engine,
          secondEngine: s.getCompilerChoiceForRoot(projects.second, "main.tex")
            ?.engine,
        };
      },
      { projects },
    );
  }
  async function open(name) {
    await page.evaluate(async (project) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await useDocumentStore.getState().openProject(project);
    }, projects[name]);
    await expect(
      page.getByRole("button", { name: "Compilation options", exact: true }),
    ).toBeVisible({ timeout: 20000 });
  }
  async function options() {
    const menu = page.getByRole("menu", { name: "Compilation options" });
    if (!(await menu.isVisible()))
      await page
        .getByRole("button", { name: "Compilation options", exact: true })
        .click();
  }
  await launch();
  await page.evaluate(async (bin) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      latexInstallation: bin,
      compilerBackend: "latexmk",
      compilerEngine: "auto",
      defaultAutoCompile: false,
    });
  }, bin);
  await open("first");
  await options();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Auto compile" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitemradio", { name: "XeLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  assert.equal(
    await page.getByRole("menuitemradio", { name: /^Auto/ }).count(),
    0,
  );
  // The panel edits this document and project, leaving the defaults alone.
  await page
    .getByRole("menuitemradio", { name: "pdfLaTeX", exact: true })
    .click();
  await page.getByRole("menuitemcheckbox", { name: "Auto compile" }).click();
  assert.equal((await settings()).defaultAutoCompile, false);
  await page.getByRole("menuitemcheckbox", { name: "Auto compile" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          return (await fs.readFile(builds, "utf8"))
            .trim()
            .split("\n")
            .map(JSON.parse)
            .some((args) => args.includes("-pdf"));
        } catch {
          return false;
        }
      },
      { timeout: 20000 },
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useDocumentStore, getCurrentPdfBytes } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        return (
          !useDocumentStore.getState().isCompiling &&
          (getCurrentPdfBytes()?.byteLength ?? 0) > 0
        );
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      defaultAutoCompile: true,
      compilerEngine: "lualatex",
    });
  });
  await open("second");
  await expect.poll(settings).toEqual({
    defaultAutoCompile: true,
    first: false,
    second: true,
    firstEngine: "pdflatex",
    secondEngine: "lualatex",
  });
  await open("first");
  await options();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Auto compile" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitemradio", { name: "pdfLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: path.join(profile, "compilation-settings.png"),
  });
  await quit();
  await launch();
  await expect.poll(settings).toEqual({
    defaultAutoCompile: true,
    first: false,
    second: true,
    firstEngine: "pdflatex",
    secondEngine: "lualatex",
  });
  await open("first");
  await options();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Auto compile" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("menuitemradio", { name: "pdfLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  console.log(
    JSON.stringify({
      ok: true,
      profile,
      checks: [
        "independent project defaults",
        "concrete engine assignment",
        "manual engine overrides source hint through native IPC",
        "project reopen",
        "full Electron restart",
      ],
    }),
  );
} finally {
  if (app) await app.close();
  await vite.close();
}
