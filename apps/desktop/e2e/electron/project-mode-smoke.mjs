import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-project-modes-"),
);
const projects = ["One", "Two"].map((name) => path.join(profile, name));
let app;
let vite;

async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  // Fresh isolated profiles need to finish onboarding before workspace checks.
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
  return page;
}

async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed;
  app = undefined;
}

async function openProject(page, root) {
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().closeProject();
    await useDocumentStore.getState().openProject(root);
  }, root);
  await expect(
    page.getByRole("tablist", { name: "Workspace assistant mode" }),
  ).toBeVisible();
}

function mode(page, name) {
  return page
    .getByRole("tablist", { name: "Workspace assistant mode" })
    .getByRole("tab", { name, exact: true });
}

try {
  for (const root of projects) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "notes.md"), "# Project notes\n");
  }
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await vite.listen();
  let page = await launch();
  await openProject(page, projects[0]);
  await expect(mode(page, "Duet")).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(mode(page, "Duet")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  // A second renderer must receive the new preference through native storage sync.
  const secondWindow = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await secondWindow;
  await second.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await second.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect
    .poll(() =>
      second.evaluate(async (root) => {
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        return useSettingsStore.getState().getWorkspacePreferences(root);
      }, projects[0]),
    )
    .toEqual({ mode: "duet", chatLayout: "workspace" });
  await page.getByRole("button", { name: "Peek", exact: true }).click();
  await expect
    .poll(() =>
      second.evaluate(async (root) => {
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        return useSettingsStore.getState().getWorkspacePreferences(root);
      }, projects[0]),
    )
    .toEqual({ mode: "duet", chatLayout: "drawer" });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  await openProject(page, projects[1]);
  await expect(mode(page, "Duet")).toHaveAttribute("aria-selected", "true");
  await mode(page, "Artisan").click();
  await expect(mode(page, "Artisan")).toHaveAttribute("aria-selected", "true");
  await quit();
  page = await launch();
  await openProject(page, projects[0]);
  await expect(mode(page, "Duet")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  await openProject(page, projects[1]);
  await expect(mode(page, "Artisan")).toHaveAttribute("aria-selected", "true");
  await quit();
  console.log(
    "New projects start in Duet; Duet workspace and Artisan are independently restored after a full Electron quit and restart.",
  );
} finally {
  await app?.close();
  await vite?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
