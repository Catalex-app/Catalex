import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

// Run against built production assets, optionally an actual packaged executable.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-profile-"));
const executablePath = process.env.CATALEX_TEST_EXECUTABLE;
const args = executablePath ? [] : [desktopRoot];
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
let independent;

async function launch(profilePath = profile) {
  const instance = await electron.launch({
    executablePath,
    args,
    env: { ...env, CATALEX_USER_DATA_DIR: profilePath },
  });
  const page = await instance.firstWindow();
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  assert.equal(new URL(page.url()).protocol, "catalex:");
  assert.equal(await instance.evaluate(({ app }) => app.getName()), "Catalex");
  await expect(page).toHaveTitle("Catalex | LaTeX Writing Workspace");
  return { instance, page };
}

async function close(instance, windowOnly = false) {
  const closed = instance.waitForEvent("close");
  await instance.evaluate(({ app, BrowserWindow }, windowOnly) => {
    setImmediate(() =>
      windowOnly ? BrowserWindow.getAllWindows()[0].close() : app.quit(),
    );
  }, windowOnly);
  await closed;
}

async function duplicate(development = false) {
  const child = spawn(app.process().spawnfile, args, {
    env: {
      ...env,
      ...(development ? { CATALEX_DEV_URL: "http://127.0.0.1:1" } : {}),
    },
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          "Duplicate process did not exit before opening shared storage",
        ),
      );
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Duplicate process exited with ${code}`));
    });
  });
  assert.equal(app.windows().length, 1);
}

try {
  let launched = await launch();
  app = launched.instance;
  const project = path.join(profile, "Remembered project");
  await fs.mkdir(project);
  await launched.page.evaluate((project) => {
    // Seed real persisted store envelopes, then reload to exercise hydration.
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    );
    const settings = JSON.parse(
      localStorage.getItem("catalex-settings") ?? '{"state":{},"version":21}',
    );
    settings.state.editorFontSize = 19;
    localStorage.setItem("catalex-settings", JSON.stringify(settings));
    localStorage.setItem(
      "catalex-projects",
      JSON.stringify({
        version: 0,
        state: {
          recentProjects: [
            {
              path: project,
              name: "Remembered project",
              lastOpened: Date.now(),
            },
          ],
          sidebarWidthsByProject: { [project]: 310 },
          lastProjectFolder: project,
        },
      }),
    );
  }, project);
  await launched.page.reload();
  await expect(
    launched.page.getByText("Remembered project", { exact: true }),
  ).toBeVisible();
  await duplicate();
  await duplicate(true);
  independent = (await launch(`${profile}-independent`)).instance;
  await close(independent);
  independent = undefined;
  await close(app, true);
  app = undefined;

  for (let pass = 0; pass < 2; pass++) {
    launched = await launch();
    app = launched.instance;
    await expect(
      launched.page.getByText("Remembered project", { exact: true }),
    ).toBeVisible();
    const saved = await launched.page.evaluate(() => ({
      settings: JSON.parse(localStorage.getItem("catalex-settings")),
      projects: JSON.parse(localStorage.getItem("catalex-projects")),
    }));
    assert.equal(saved.settings.state.editorFontSize, 19);
    assert.equal(saved.projects.state.recentProjects[0].path, project);
    assert.equal(saved.projects.state.sidebarWidthsByProject[project], 310);
    await close(app);
    app = undefined;
  }
  console.log(
    "Production recents/settings survived window close and full quit; duplicate installed/dev launches exited; independent profiles still launch.",
  );
} finally {
  await independent?.close();
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(`${profile}-independent`, { recursive: true, force: true });
}
