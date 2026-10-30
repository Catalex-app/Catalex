import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-overleaf-credentials-"),
);
const source = path.join(profile, "source");
const clones = path.join(profile, "clones");
const config = path.join(profile, "gitconfig");
const credentials = path.join(profile, "test-credentials");
await fs.mkdir(source);
await fs.mkdir(clones);
await fs.writeFile(path.join(source, "notes.md"), "Test project\n");
await fs.writeFile(config, "");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
delete gitEnv.OVERLEAF_TOKEN;
delete gitEnv.OVERLEAF_ACCESS_TOKEN;
const git = (args, input) =>
  execFileSync("git", args, {
    cwd: source,
    env: gitEnv,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
for (const args of [
  ["init"],
  ["config", "user.name", "Test"],
  ["config", "user.email", "test@example.invalid"],
  ["add", "."],
  ["commit", "-m", "Initial"],
])
  git(args);
git([
  "config",
  "--global",
  "credential.helper",
  `store --file='${credentials}'`,
]);
git([
  "config",
  "--global",
  `url.file://${source}.insteadOf`,
  "https://git@git.overleaf.com/123456789012345678901234",
]);
let app;
let vite;
try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const env = {
    ...gitEnv,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  async function cloneThroughDialog(name) {
    await page.evaluate(async () => {
      const { useCodexSetupStore } = await import(
        "/src/renderer/stores/codex-setup-store.ts"
      );
      useCodexSetupStore.setState({ status: "ready" });
    });
    await page.getByTestId("welcome-new-project-menu-trigger").click();
    await page.getByRole("menuitem", { name: "Import from Overleaf" }).click();
    const dialog = page.getByRole("dialog", { name: "Import from Overleaf" });
    await dialog
      .getByLabel("Git Clone Command")
      .fill("git clone https://git@git.overleaf.com/123456789012345678901234");
    await dialog
      .getByLabel("Access Token", { exact: true })
      .fill("fake-test-token");
    await dialog.getByLabel("Local Name", { exact: true }).fill(name);
    await dialog.getByLabel("Local Path", { exact: true }).fill(clones);
    await dialog
      .getByRole("button", { name: "Clone Project", exact: true })
      .click();
    await expect(dialog).toBeHidden({ timeout: 20000 });
    assert.equal(
      await fs.readFile(path.join(clones, name, "notes.md"), "utf8"),
      "Test project\n",
    );
  }
  await cloneThroughDialog("saved");
  const detected = await page.evaluate(async () => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("git_overleaf_token_detect");
  });
  assert.equal(detected, "fake-test-token");
  const terminalCredential = git(
    ["credential", "fill"],
    "protocol=https\nhost=git.overleaf.com\nusername=git\n\n",
  );
  assert.ok(terminalCredential.includes("password=fake-test-token"));
  assert.ok(
    !(
      await fs.readFile(path.join(clones, "saved", ".git", "config"), "utf8")
    ).includes("fake-test-token"),
  );
  git(["config", "--global", "--unset-all", "credential.helper"]);
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().closeProject();
  });
  await cloneThroughDialog("no-helper");
  await expect(
    page.getByText(
      /The project was cloned, but Git could not remember the token/,
    ),
  ).toBeVisible();
  await fs.mkdir(path.join(desktopRoot, "test-results"), { recursive: true });
  await page.screenshot({
    path: path.join(
      desktopRoot,
      "test-results",
      "overleaf-credential-warning.png",
    ),
  });
  console.log(
    "Electron clone saved credentials for discovery and terminal Git; missing helper warned without failing the clone.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
}
