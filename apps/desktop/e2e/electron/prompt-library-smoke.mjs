import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-prompts-"));
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
let app;
const errors = [];
async function ready(page) {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  return page;
}
async function launch() {
  app = await electron.launch({ args: [desktopRoot], env });
  const page = await ready(await app.firstWindow());
  assert.equal(new URL(page.url()).protocol, "catalex:");
  return page;
}
async function settings(page) {
  const opened = app.waitForEvent("window");
  await page.evaluate(() =>
    window.catalex.invoke("open_settings_window", { section: "agent" }),
  );
  return ready(await opened);
}
async function saved(page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
        ?.promptLibrary,
  );
}
async function quit() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed;
  app = undefined;
}
try {
  let main = await launch();
  let editor = await settings(main);
  let library = editor.locator('[data-settings-row-id="agent-prompt-library"]');
  await library.getByRole("button", { name: "Add prompt" }).click();
  await editor
    .getByLabel("Prompt title", { exact: true })
    .fill("Restart check");
  await editor
    .getByLabel("Prompt text", { exact: true })
    .fill("Remember this custom prompt.");
  await editor
    .getByRole("button", { name: "Prompt icon: Default icon" })
    .click();
  await editor.getByRole("textbox", { name: "Search icons" }).fill("telescope");
  const telescope = editor.getByRole("button", {
    name: "Telescope",
    exact: true,
  });
  await expect(telescope.locator("svg.lucide-telescope")).toBeVisible();
  await telescope.click();
  await editor.getByRole("button", { name: "Save prompt" }).click();
  for (let index = 0; index < 4; index++)
    await library
      .getByRole("button", { name: "Move Restart check up" })
      .click();
  await library.getByRole("switch", { name: "Enable Restart check" }).click();
  await expect
    .poll(async () => (await saved(main))?.[0])
    .toMatchObject({
      title: "Restart check",
      prompt: "Remember this custom prompt.",
      icon: "telescope",
      enabled: false,
    });
  const expected = await saved(main);
  const opened = app.waitForEvent("window");
  await main.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await ready(await opened);
  await expect.poll(() => saved(second)).toEqual(expected);
  await quit();

  main = await launch();
  await expect.poll(() => saved(main)).toEqual(expected);
  editor = await settings(main);
  library = editor.locator('[data-settings-row-id="agent-prompt-library"]');
  await expect(
    library.locator("[data-library-prompt-id]").first(),
  ).toContainText("Restart check");
  await expect(
    library.getByRole("switch", { name: "Enable Restart check" }),
  ).toHaveAttribute("aria-checked", "false");
  await library.getByRole("button", { name: "Edit Restart check" }).click();
  await expect(
    editor
      .getByRole("button", { name: "Prompt icon: Telescope" })
      .locator("svg.lucide-telescope"),
  ).toBeVisible();
  await expect(editor.getByLabel("Prompt text", { exact: true })).toHaveValue(
    "Remember this custom prompt.",
  );
  await quit();
  assert.deepEqual(errors, []);
  console.log(
    "Prompt text, icon, ordering, and enabled state synchronized across native windows and survived a full production-app restart.",
  );
} finally {
  await app?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
