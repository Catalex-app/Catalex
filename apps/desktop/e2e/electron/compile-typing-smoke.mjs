import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-compile-typing-"),
);
const project = path.join(profile, "paper");
await fs.mkdir(project);
const prose =
  "We compare experiments against baselines and report confidence intervals. ";
await fs.writeFile(
  path.join(project, "main.tex"),
  `\\documentclass{article}\n\\begin{document}\n${Array.from({ length: 120 }, (_, i) => `\\section{Experiment ${i}}\n${prose.repeat(8)}\n\n`).join("")}\\end{document}\n`,
);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({ args: [desktopRoot], env });
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, project);
  await page.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.locator("[data-page-number]").first()).toBeVisible({
    timeout: 120_000,
  });
  await page.evaluate(() => {
    window.__compileTyping = { frames: [], longTasks: [] };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        window.__compileTyping.longTasks.push(entry.duration);
    }).observe({ type: "longtask", buffered: false });
    document.addEventListener("keydown", () => {
      const start = performance.now();
      requestAnimationFrame(() =>
        window.__compileTyping.frames.push(performance.now() - start),
      );
    });
  });
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("% \n");
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.type("A comment before compiling. ", { delay: 40 });
  await page.waitForTimeout(1100);
  await page.keyboard.type(
    "Continue typing while compilation and preview refresh run. ".repeat(4),
    { delay: 40 },
  );
  await page.waitForTimeout(3000);
  const result = await page.evaluate(() => {
    const { frames, longTasks } = window.__compileTyping;
    frames.sort((a, b) => a - b);
    return {
      keys: frames.length,
      medianMs: frames[Math.floor(frames.length * 0.5)],
      p95Ms: frames[Math.floor(frames.length * 0.95)],
      maxMs: Math.max(...frames),
      longTasks: longTasks.length,
      longestTaskMs: Math.max(0, ...longTasks),
    };
  });
  const binary = await page.evaluate(async (project) => {
    const compiled = await window.catalex.invoke("compile_latex", {
      projectDir: project,
      mainFile: "main.tex",
      backend: "latexmk",
      engine: "xelatex",
      diagnostics: { __channel: 999999 },
      installation: null,
    });
    if (compiled.error) throw Error(JSON.stringify(compiled.error));
    const reply = await window.catalex.invoke("get_compiled_pdf", {
      projectDir: project,
    });
    if (reply.error) throw Error(JSON.stringify(reply.error));
    const bytes = new Uint8Array(reply.result);
    const binary = compiled.result;
    return {
      bytes: bytes.length,
      signature: Array.from(bytes.slice(0, 5)),
      typedArray: binary instanceof Uint8Array,
      identical:
        binary.length === bytes.length &&
        bytes.every((byte, i) => byte === binary[i]),
    };
  }, project);
  assert.ok(binary.bytes > 100);
  assert.equal(binary.typedArray, true);
  assert.equal(binary.identical, true);
  assert.deepEqual(binary.signature, [37, 80, 68, 70, 45]);
  const artifacts = path.join(profile, "artifacts");
  await fs.mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "workspace.png") });
  console.log(
    JSON.stringify({
      ...result,
      pdfBytes: binary.bytes,
      binaryBytesIdentical: binary.identical,
      profile,
    }),
  );
} finally {
  await app.close();
}
