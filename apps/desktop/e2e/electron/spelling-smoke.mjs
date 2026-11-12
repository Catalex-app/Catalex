import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-spelling-"));
const project = path.join(profile, "Spelling project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/spelling-electron",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(
  path.join(project, "main.tex"),
  String.raw`\documentclass{article}
\begin{document}
This sentnce has a speling mistake. Colour and color.
The model produces embeddings.
\cite{badcite} $badmath$ \url{https://badurl.invalid}
\end{document}
`,
);
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const devUrl = process.env.CATALEX_SMOKE_DEV_URL;
if (devUrl) env.CATALEX_DEV_URL = devUrl;
else delete env.CATALEX_DEV_URL;
const launch = process.env.CATALEX_SMOKE_EXECUTABLE
  ? { executablePath: process.env.CATALEX_SMOKE_EXECUTABLE, args: [] }
  : { args: [desktopRoot] };
let app;
const errors = [];
async function start() {
  app = await electron.launch({ ...launch, env, timeout: 30000 });
  // Allow the local renderer in development and keep external requests blocked.
  await app
    .context()
    .route(/^https?:/, (route) =>
      devUrl && new URL(route.request().url()).origin === new URL(devUrl).origin
        ? route.continue()
        : route.abort(),
    );
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().startsWith("Spell check:"))
      console.log("Renderer:", message.text());
  });
  page.on("worker", (worker) => console.log("Worker:", worker.url()));
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  return page;
}
async function openSettings(page) {
  const ready = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("open_settings_window", {}));
  const settings = await ready;
  await settings.locator("#loading-screen").waitFor({ state: "hidden" });
  return settings;
}
const spelling = (page) => page.locator(".cm-spelling-error");
const spellCheckSettings = (settings) =>
  settings.getByRole("region", { name: "Spell Check settings" });
const openSpellCheck = (settings) =>
  settings.getByRole("button", { name: "Spell Check", exact: true }).click();
try {
  let page = await start();
  await page.evaluate(() => {
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    );
    const settings = JSON.parse(
      localStorage.getItem("catalex-settings") ?? "{}",
    );
    settings.state = {
      ...settings.state,
      defaultAutoCompile: false,
      spellingWords: ["This"],
    };
    localStorage.setItem("catalex-settings", JSON.stringify(settings));
  });
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, project) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
  }, project);
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await expect(spelling(page).filter({ hasText: /^speling$/ })).toBeVisible({
    timeout: 20000,
  });
  assert.ok(!(await spelling(page).allTextContents()).includes("badcite"));
  assert.ok(!(await spelling(page).allTextContents()).includes("badmath"));
  await expect(page.locator(".cm-content")).toContainText("embeddings");
  assert.ok(!(await spelling(page).allTextContents()).includes("embeddings"));
  await spelling(page)
    .filter({ hasText: /^speling$/ })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "spelling", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "suggestions.png") });
  await page.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("a spelling mistake");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+z" : "Control+z",
  );
  await expect(page.locator(".cm-content")).toContainText("a speling mistake");
  let settings = await openSettings(page);
  await openSpellCheck(settings);
  await expect(
    spellCheckSettings(settings).getByRole("button", { name: "Remove This" }),
  ).toBeVisible();
  await spelling(page)
    .filter({ hasText: /^sentnce$/ })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add to Dictionary", exact: true })
    .click();
  await expect(spelling(page).filter({ hasText: /^sentnce$/ })).toHaveCount(0);
  await expect(
    spellCheckSettings(settings).getByRole("button", {
      name: "Remove sentnce",
    }),
  ).toBeVisible();
  await settings.screenshot({
    path: path.join(artifacts, "dictionary-populated.png"),
  });
  const toggle = settings.getByRole("switch", {
    name: "Spell Check",
    exact: true,
  });
  await toggle.click();
  await expect(spelling(page)).toHaveCount(0);
  await settings.getByRole("combobox", { name: "Spelling language" }).click();
  await settings
    .getByRole("option", { name: "English (UK)", exact: true })
    .click();
  await settings.screenshot({ path: path.join(artifacts, "settings.png") });
  await app.close();
  page = await start();
  const restored = await page.evaluate(
    () => JSON.parse(localStorage.getItem("catalex-settings")).state,
  );
  assert.equal(restored.spellCheck, false);
  assert.equal(restored.spellingLanguage, "en-GB");
  assert.ok(restored.spellingWords.includes("sentnce"));
  await page.getByText("Spelling project", { exact: true }).first().click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(spelling(page)).toHaveCount(0);
  settings = await openSettings(page);
  await openSpellCheck(settings);
  await settings
    .getByRole("switch", { name: "Spell Check", exact: true })
    .click();
  await expect(spelling(page).filter({ hasText: /^color$/ })).toBeVisible();
  await expect(spelling(page).filter({ hasText: /^Colour$/ })).toHaveCount(0);
  await expect(spelling(page).filter({ hasText: /^sentnce$/ })).toHaveCount(0);
  for (const word of ["This", "sentnce"]) {
    await spellCheckSettings(settings)
      .getByRole("button", { name: `Remove ${word}` })
      .click();
  }
  await expect(
    spellCheckSettings(settings).getByText("No added words"),
  ).toBeVisible();
  await expect(spelling(page).filter({ hasText: /^sentnce$/ })).toBeVisible();
  await expect(spelling(page).filter({ hasText: /^This$/ })).toHaveCount(0);
  await settings.screenshot({
    path: path.join(artifacts, "dictionary-empty.png"),
  });
  await app.close();
  page = await start();
  await page.getByText("Spelling project", { exact: true }).first().click();
  await expect(spelling(page).filter({ hasText: /^sentnce$/ })).toBeVisible();
  settings = await openSettings(page);
  await openSpellCheck(settings);
  await expect(
    spellCheckSettings(settings).getByText("No added words"),
  ).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "restored.png") });
  assert.deepEqual(errors, []);
  console.log(
    `Hunspell (${devUrl ? "development renderer" : "offline built assets"}), suggestions/undo, cross-window dictionary and settings, and full-restart persistence passed (${process.platform}).`,
  );
} catch (error) {
  await app
    ?.windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
