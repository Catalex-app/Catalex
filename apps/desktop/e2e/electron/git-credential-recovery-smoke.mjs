import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-auth-recovery-"),
);
const source = path.join(profile, "source");
const remote = path.join(profile, "remote.git");
const project = path.join(profile, "project");
const config = path.join(profile, "gitconfig");
const credentials = path.join(profile, "credentials");
await fs.mkdir(source);
await fs.writeFile(config, "");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: config,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};
delete env.OVERLEAF_TOKEN;
delete env.OVERLEAF_ACCESS_TOKEN;
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
git(source, ["config", "--global", "user.name", "Fixture"]);
git(source, ["config", "--global", "user.email", "fixture@example.invalid"]);
git(source, [
  "config",
  "--global",
  "credential.helper",
  `store --file='${credentials}'`,
]);
// This self-signed localhost fixture never connects to a real Git host.
git(source, ["config", "--global", "http.sslVerify", "false"]);
git(source, ["init", "-b", "main"]);
await fs.writeFile(path.join(source, "notes.md"), "Original\n");
git(source, ["add", "."]);
git(source, ["commit", "-m", "Initial"]);
git(profile, ["clone", "--bare", source, remote]);
git(remote, ["config", "http.receivepack", "true"]);
git(profile, ["clone", source, project]);
await fs.writeFile(path.join(project, "notes.md"), "Local commit\n");
git(project, ["commit", "-am", "Local"]);
const key = path.join(profile, "key.pem"),
  cert = path.join(profile, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "pipe" },
);
let permissionDenied = false;
const server = https.createServer(
  { key: await fs.readFile(key), cert: await fs.readFile(cert) },
  async (req, res) => {
    if (permissionDenied) {
      res.writeHead(403);
      res.end("Permission denied");
      return;
    }
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("alex:fake-token").toString("base64")}`
    ) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Test Git"' });
      res.end("Authentication required");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, "https://localhost");
    const output = execFileSync("git", ["http-backend"], {
      input: Buffer.concat(chunks),
      env: {
        ...env,
        GIT_PROJECT_ROOT: profile,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        REMOTE_USER: "alex",
      },
      maxBuffer: 10 * 1024 * 1024,
    });
    const split = output.indexOf("\r\n\r\n");
    const headers = output.subarray(0, split).toString().split("\r\n");
    for (const header of headers) {
      const colon = header.indexOf(":");
      if (colon < 0) continue;
      const name = header.slice(0, colon),
        value = header.slice(colon + 1).trim();
      if (name === "Status") res.statusCode = Number(value.split(" ")[0]);
      else res.setHeader(name, value);
    }
    res.end(output.subarray(split + 4));
  },
);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `https://127.0.0.1:${server.address().port}/remote.git`;
git(project, ["remote", "set-url", "origin", url]);
let app, vite;
try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const appEnv = {
    ...env,
    CATALEX_USER_DATA_DIR: path.join(profile, "app"),
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete appEnv.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env: appEnv });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
  }, project);
  async function start(command, args = {}) {
    await page.evaluate(
      async ({ command, args, project }) => {
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        window.__authResult = null;
        void invoke(command, { projectRoot: project, ...args }).then(
          (result) => {
            window.__authResult = { result };
          },
          (error) => {
            window.__authResult = { error: String(error) };
          },
        );
      },
      { command, args, project },
    );
  }
  const dialog = page.getByRole("dialog", { name: "Update credentials" });
  await start("git_panel_push");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`127.0.0.1:${server.address().port}`);
  await dialog.getByLabel("Username", { exact: true }).fill("alex");
  await dialog.getByLabel("Access token").fill("wrong-token");
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Authentication failed",
  );
  await assert.rejects(fs.readFile(credentials));
  await fs.mkdir(path.join(desktopRoot, "test-results"), { recursive: true });
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: path.join(desktopRoot, "test-results", "git-credential-native.png"),
  });
  await dialog.getByLabel("Access token").fill("fake-token");
  await dialog.getByRole("button", { name: "Show git command" }).click();
  await expect(dialog.getByTestId("git-command-preview")).toContainText(
    "git push",
  );
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.__authResult))
    .toMatchObject({ result: { success: true } });
  assert.equal(
    git(remote, ["rev-parse", "main"]).trim(),
    git(project, ["rev-parse", "HEAD"]).trim(),
  );
  assert.ok((await fs.readFile(credentials, "utf8")).includes("fake-token"));
  // An interrupted compound flow resumes only the failed pull, not the preceding stash.
  await fs.unlink(credentials);
  await fs.writeFile(path.join(project, "notes.md"), "Uncommitted work\n");
  await start("git_panel_pull_flow", {
    message: "Test stash",
    stashSelectedFiles: ["notes.md"],
    reapplyMode: "pop",
  });
  await expect(dialog).toBeVisible();
  assert.equal(git(project, ["stash", "list"]).trim().split("\n").length, 1);
  await dialog.getByLabel("Username", { exact: true }).fill("alex");
  await dialog.getByLabel("Access token").fill("fake-token");
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authResult))
    .toMatchObject({ result: { success: true } });
  assert.equal(git(project, ["stash", "list"]).trim(), "");
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    "Uncommitted work\n",
  );
  await fs.unlink(credentials);
  await start("git_panel_push");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authResult?.error))
    .toBeTruthy();
  git(source, ["config", "--global", "--unset-all", "credential.helper"]);
  await start("git_panel_push");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Username", { exact: true }).fill("alex");
  await dialog.getByLabel("Access token").fill("fake-token");
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Git could not remember the token",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__authResult?.error))
    .toBeTruthy();
  permissionDenied = true;
  await start("git_panel_push");
  await expect
    .poll(() => page.evaluate(() => window.__authResult?.error))
    .toBeTruthy();
  await expect(dialog).toBeHidden();
  console.log(
    "Electron HTTPS recovery passed: wrong-token validation, credential storage, exact push/pull retry, stash continuity, cancellation, and no popup for 403.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  await new Promise((resolve) => server.close(resolve));
}
