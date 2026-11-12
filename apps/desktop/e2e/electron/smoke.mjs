import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-electron-smoke-"),
);
const artifacts = path.resolve(desktopRoot, "../../output/playwright/electron");
await fs.mkdir(artifacts, { recursive: true });
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const launch = process.env.CATALEX_SMOKE_EXECUTABLE
  ? { executablePath: process.env.CATALEX_SMOKE_EXECUTABLE, args: [] }
  : { args: [desktopRoot] };
const project = path.join(profile, "Smoke project");
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}\nElectron migration smoke test.\n\\end{document}\n",
);
await fs.writeFile(
  path.join(project, "notes.md"),
  "# Electron migration\n\nNative file access works.\n",
);
await fs.copyFile(
  path.join(
    desktopRoot,
    "src/renderer/dev/fixtures/pdf-comments/multipage.pdf",
  ),
  path.join(project, "reference.pdf"),
);
// Exercise the real OS appearance instead of Playwright's default light emulation.
const launchOptions = { ...launch, env, timeout: 30_000, colorScheme: null };
let app = await electron.launch(launchOptions);
app.process().stderr.on("data", (chunk) => process.stderr.write(chunk));

function readBackgroundToken(page) {
  return page.locator("html").evaluate((html) =>
    getComputedStyle(html)
      .getPropertyValue("--background")
      .trim()
      .replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3")
      .toUpperCase(),
  );
}

function readNativeThemeSource() {
  return app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
}

try {
  const page = await app.firstWindow();
  const window = await app.browserWindow(page);
  await window.evaluate((window) => {
    window.unmaximize();
    window.setSize(1440, 1000);
    window.show();
    window.focus();
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () =>
      !!window.catalex && document.querySelector("#root")?.children.length > 0,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect.poll(readNativeThemeSource).toBe("light");
  // This suite exercises workspace I/O; the setup wizard has its own coverage.
  await page.evaluate(() =>
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    ),
  );
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  // Let welcome-screen detection save its installation before leaving the
  // screen; otherwise the restart can legitimately populate this setting.
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
        ?.latexInstallation,
    undefined,
    { timeout: 30_000 },
  );
  await page.screenshot({ path: path.join(artifacts, "startup.png") });
  console.log("Welcome screen ready.");
  console.log(
    "Isolation:",
    await page.evaluate(() => ({
      node: typeof window.require,
      electron: typeof window.process,
      bridge: !!window.catalex,
    })),
  );
  const reply = await page.evaluate(() =>
    window.catalex.invoke("get_system_info"),
  );
  assert.ok(reply.result?.app_version);
  console.log("System bridge passed:", reply.result);
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, project);
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await page.locator(".cm-content").first().waitFor();
  await page.screenshot({ path: path.join(artifacts, "workspace.png") });
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+End" : "Control+End",
  );
  await page.keyboard.insertText("\n% Saved through the editor\n");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+s" : "Control+s",
  );
  await expect
    .poll(() => fs.readFile(path.join(project, "main.tex"), "utf8"))
    .toContain("Saved through the editor");
  await page.evaluate(() => {
    window.__smokeFileChanged = false;
    window.__stopSmokeWatch = window.catalex.listen(
      "project-files-changed",
      () => {
        window.__smokeFileChanged = true;
      },
    );
  });
  await fs.writeFile(
    path.join(project, "notes.md"),
    "# Electron migration\n\nExternal edit detected.\n",
  );
  await page.waitForFunction(() => window.__smokeFileChanged === true);
  await page.evaluate(() => window.__stopSmokeWatch());
  console.log("Editor save and native file watcher passed.");
  const io = await page.evaluate(async (projectPath) => {
    const invoke = async (command, args) => {
      const value = await window.catalex.invoke(command, args);
      if ("error" in value) throw new Error(JSON.stringify(value.error));
      return value.result;
    };
    const filePath = `${projectPath}/native-save.txt`;
    await invoke("desktop:fs:writeTextFile", {
      path: filePath,
      contents: "Saved by Electron",
    });
    return invoke("desktop:fs:readTextFile", { path: filePath });
  }, project);
  assert.equal(io, "Saved by Electron");
  await page.getByText("reference.pdf", { exact: true }).first().click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("canvas")].some((canvas) => {
      if (canvas.width < 100 || canvas.height < 100) return false;
      const pixels = canvas
        .getContext("2d")
        ?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return false;
      for (let index = 0; index < pixels.length; index += 4) {
        if (
          pixels[index + 3] > 0 &&
          pixels[index] < 180 &&
          pixels[index + 1] < 180 &&
          pixels[index + 2] < 180
        )
          return true;
      }
      return false;
    }),
  );
  await page.screenshot({ path: path.join(artifacts, "pdf.png") });
  console.log("Native file save/read and MuPDF canvas passed.");
  await page.getByText("notes.md", { exact: true }).first().click();
  const exportButton = page.getByRole("button", {
    name: "Export Markdown as PDF",
  });
  await exportButton.waitFor();
  const markdownPdf = path.join(profile, "markdown.pdf");
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, markdownPdf);
  await exportButton.click();
  await expect
    .poll(
      async () =>
        (await fs.readFile(markdownPdf).catch(() => Buffer.alloc(0)))
          .subarray(0, 5)
          .toString(),
      { timeout: 30_000 },
    )
    .toBe("%PDF-");
  await fs.copyFile(markdownPdf, path.join(artifacts, "markdown.pdf"));
  await page.screenshot({ path: path.join(artifacts, "markdown.png") });
  console.log("Native Markdown PDF export passed.");
  const settingsReady = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("open_settings_window", {}));
  const settings = await settingsReady;
  if (settings)
    await settings.locator("#loading-screen").waitFor({ state: "hidden" });
  assert.equal(app.windows().length, 2);
  console.log("Settings window passed.");

  const settingsWindow = await app.browserWindow(settings);
  const lightBackground = await readBackgroundToken(page);
  assert.equal(
    await window.evaluate((win) => win.getBackgroundColor()),
    lightBackground,
  );
  await settings
    .locator('[data-settings-row-id="appearance-editor-font-size"] button')
    .click();
  await settings.getByRole("option", { name: "18px", exact: true }).click();
  const appearancePicker = settings
    .locator('[data-settings-row-id="appearance-theme"]')
    .getByRole("combobox");
  const chooseAppearance = async (name) => {
    await appearancePicker.click();
    await settings.getByRole("option", { name, exact: true }).click();
  };
  await chooseAppearance("Dark");
  await expect.poll(readNativeThemeSource).toBe("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  const darkBackground = await readBackgroundToken(page);
  assert.notEqual(darkBackground, lightBackground);
  await expect
    .poll(() => window.evaluate((win) => win.getBackgroundColor()))
    .toBe(darkBackground);
  await expect
    .poll(() => settingsWindow.evaluate((win) => win.getBackgroundColor()))
    .toBe(await readBackgroundToken(settings));

  const override = await page.addStyleTag({
    content: ":root.dark.test-background { --background: #18232e; }",
  });
  await page
    .locator("html")
    .evaluate((html) => html.classList.add("test-background"));
  await expect
    .poll(() => window.evaluate((win) => win.getBackgroundColor()))
    .toBe("#18232E");
  await page
    .locator("html")
    .evaluate((html) => html.classList.remove("test-background"));
  await override.evaluate((style) => style.remove());
  await expect
    .poll(() => window.evaluate((win) => win.getBackgroundColor()))
    .toBe(darkBackground);
  const resize = await window.evaluate(async (win) => {
    const backgrounds = [];
    win.focus();
    for (const width of [1280, 1120, 960, 800]) {
      win.setSize(width, 750);
      await new Promise((resolve) => setTimeout(resolve, 40));
      backgrounds.push(win.getBackgroundColor());
    }
    return { width: win.getSize()[0], backgrounds };
  });
  assert.equal(resize.width, 800);
  assert.deepEqual(resize.backgrounds, Array(4).fill(darkBackground));
  await page.screenshot({
    path: path.join(artifacts, "dark-minimum-width.png"),
  });
  await window.evaluate((win) => win.setSize(1440, 1000));

  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect.poll(readNativeThemeSource).toBe("light");
  await expect(settings.locator("html")).toHaveClass(/\blight\b/);
  await chooseAppearance("System");
  await expect.poll(readNativeThemeSource).toBe("system");
  const osIsDark = await app.evaluate(
    ({ nativeTheme }) => nativeTheme.shouldUseDarkColors,
  );
  await expect(page.locator("html")).toHaveClass(
    osIsDark ? /\bdark\b/ : /\blight\b/,
  );
  await chooseAppearance("Dark");
  await expect.poll(readNativeThemeSource).toBe("dark");

  await expect
    .poll(() =>
      page
        .locator(".cm-content")
        .first()
        .evaluate((element) => getComputedStyle(element).fontSize),
    )
    .toBe("18px");
  const storageBefore = await page.evaluate(() => ({
    settings: localStorage.getItem("catalex-settings"),
    projects: localStorage.getItem("catalex-projects"),
    theme: localStorage.getItem("theme"),
  }));
  const projectStorageBefore = await page.evaluate(
    async (projectRoot) =>
      window.catalex.invoke("prepare_project_storage", { projectRoot }),
    project,
  );
  await app.close();
  app = await electron.launch(launchOptions);
  const restored = await app.firstWindow();
  await restored.locator("#loading-screen").waitFor({ state: "hidden" });
  assert.equal(new URL(restored.url()).protocol, "catalex:");
  assert.deepEqual(
    await restored.evaluate(() => ({
      settings: localStorage.getItem("catalex-settings"),
      projects: localStorage.getItem("catalex-projects"),
      theme: localStorage.getItem("theme"),
    })),
    storageBefore,
    "Production browser state survives a full process restart",
  );
  await expect(restored.locator("html")).toHaveClass(/dark/);
  await expect.poll(readNativeThemeSource).toBe("dark");
  const restoredWindow = await app.browserWindow(restored);
  await expect
    .poll(() => restoredWindow.evaluate((win) => win.getBackgroundColor()))
    .toBe(await readBackgroundToken(restored));
  await restored.getByText("Smoke project", { exact: true }).first().click();
  await restored.locator(".cm-content").first().waitFor();
  await expect(restored.locator(".cm-content").first()).toContainText(
    "External edit detected",
  );
  assert.deepEqual(
    await restored.evaluate(
      async (projectRoot) =>
        window.catalex.invoke("prepare_project_storage", { projectRoot }),
      project,
    ),
    projectStorageBefore,
    "Native project identity survives restart",
  );
  await restored.screenshot({
    path: path.join(artifacts, "restored-workspace.png"),
  });
  console.log(
    "Production restart restored theme, editor settings, recent project, focused file, and native project identity.",
  );
  assert.deepEqual(errors, [], "No renderer exceptions");
} catch (error) {
  await app
    .windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
