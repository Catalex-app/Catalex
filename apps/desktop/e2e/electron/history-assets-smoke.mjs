import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-history-assets-"),
);
const project = path.join(profile, "Asset project");
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/history-assets",
);
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
const originalImage =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="#e87932"/><text x="30" y="130" fill="white" font-size="28">Original saved figure</text></svg>';
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}\nAsset history smoke.\n\\end{document}\n",
);
await fs.writeFile(path.join(project, "figure.svg"), originalImage);
await fs.copyFile(
  path.join(desktopRoot, "public/examples/letter-formal/main.pdf"),
  path.join(project, "reference.pdf"),
);
const originalPdf = await fs.readFile(path.join(project, "reference.pdf"));
const git = (...args) =>
  execFileSync("git", ["-C", project, ...args], { encoding: "utf8" }).trim();
git("init", "-q");
git("add", "main.tex");
git(
  "-c",
  "user.name=History Test",
  "-c",
  "user.email=history@example.invalid",
  "commit",
  "-qm",
  "User baseline",
);
git("remote", "add", "origin", "https://github.com/example/paper.git");
git("remote", "add", "overleaf", "https://git.overleaf.com/example");
await fs.writeFile(path.join(project, "staged.txt"), "User staged content");
git("add", "staged.txt");
const userHead = git("rev-parse", "HEAD");
const userIndex = await fs.readFile(path.join(project, ".git/index"));
const userConfig = await fs.readFile(path.join(project, ".git/config"));
const env = { ...process.env, CATALEX_USER_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CATALEX_DEV_URL;
const app = await electron.launch({ args: [desktopRoot], env });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const window = await app.browserWindow(page);
  await window.evaluate((window) => {
    window.setSize(1440, 1000);
    window.show();
  });
  await page.waitForFunction(
    () =>
      !!window.catalex && document.querySelector("#root")?.children.length > 0,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await app.evaluate(({ dialog }, projectPath) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [projectPath],
    });
  }, project);
  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Open Folder" }).click();
  await page.locator(".cm-content").first().waitFor();
  const invoke = (command, args = {}) =>
    page.evaluate(
      async ({ command, args }) => {
        const response = await window.catalex.invoke(command, args);
        if (response.error) throw new Error(response.error);
        return response.result;
      },
      { command, args: { projectRoot: project, ...args } },
    );
  await invoke("history_init");
  await invoke("history_snapshot", { message: "Asset baseline" });
  const initial = (await invoke("history_list", { limit: 10, offset: 0 }))[0]
    .id;
  const files = await invoke("history_snapshot_files", { snapshotId: initial });
  assert.ok(files.includes("figure.svg"));
  assert.ok(files.includes("reference.pdf"));
  assert.ok(
    !files.some(
      (file) => file.startsWith(".git/") || file.startsWith(".catalex/"),
    ),
  );
  await fs.unlink(path.join(project, "figure.svg"));
  await fs.writeFile(
    path.join(project, "reference.pdf"),
    "%PDF changed current file",
  );
  await invoke("history_snapshot", { message: "Assets changed" });
  assert.deepEqual(
    Buffer.from(
      await invoke("history_file_bytes", {
        snapshotId: initial,
        filePath: "reference.pdf",
      }),
      "base64",
    ),
    originalPdf,
  );
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Project rewind",
    exact: true,
  });
  await dialog.getByTestId(`history-snapshot-${initial}`).click();
  const card = dialog.getByTestId("history-front-card");
  await card.getByTestId("history-file-figure.svg").click();
  const asset = card.getByTestId("history-recorded-asset");
  await expect(asset.locator("img")).toBeVisible();
  await expect
    .poll(() => asset.locator("img").evaluate((image) => image.naturalWidth))
    .toBeGreaterThan(0);
  assert.equal(
    Buffer.from(
      (await asset.locator("img").getAttribute("src")).split(",")[1],
      "base64",
    ).toString(),
    originalImage,
  );
  await page.screenshot({ path: path.join(artifacts, "saved-image.png") });
  await card.getByTestId("history-file-reference.pdf").click();
  await expect.poll(() => asset.locator("canvas").count()).toBeGreaterThan(0);
  await expect(asset).toContainText("Saved project asset");
  await page.screenshot({ path: path.join(artifacts, "saved-pdf.png") });
  await page.keyboard.press("Escape");
  await invoke("history_restore", { snapshotId: initial });
  assert.equal(
    await fs.readFile(path.join(project, "figure.svg"), "utf8"),
    originalImage,
  );
  assert.deepEqual(
    await fs.readFile(path.join(project, "reference.pdf")),
    originalPdf,
  );
  assert.equal(git("rev-parse", "HEAD"), userHead);
  assert.deepEqual(
    await fs.readFile(path.join(project, ".git/index")),
    userIndex,
  );
  assert.deepEqual(
    await fs.readFile(path.join(project, ".git/config")),
    userConfig,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Electron asset history: native capture, saved previews, byte-exact restore and user Git isolation passed.",
  );
} finally {
  await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
