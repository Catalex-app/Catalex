import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// A local endpoint holds an isolated agent turn open. Tool calls go through the
// real authenticated MCP server; no model inference or personal project is used.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-agent-pdf-"));
const project = path.join(profile, "project");
const bytes = await fs.readFile(
  path.join(root, "public/examples/paper-standard/main.pdf"),
);
for (const folder of ["a", "b"]) {
  await fs.mkdir(path.join(project, folder), { recursive: true });
  await fs.writeFile(path.join(project, folder, "paper.pdf"), bytes);
}
await fs.writeFile(
  path.join(project, "notes.md"),
  "A plain Markdown passage.\n",
);
const endpoint = http.createServer((request) => request.resume());
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const vite = await createServer({
  root,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0 },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  CLAUDE_CONFIG_DIR: path.join(profile, "claude"),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}`,
  ANTHROPIC_API_KEY: "local-test-only",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete env[key];
const artifacts = path.resolve(
  root,
  "../../output/playwright/electron/agent-pdf-comments",
);
await fs.mkdir(artifacts, { recursive: true });
let app, page, connection;
const errors = [];
async function invoke(command, args) {
  return page.evaluate(
    async ({ command, args }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke(command, args);
    },
    { command, args },
  );
}
async function call(name, args, expectedError) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      ...connection.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(55_000),
  });
  assert.equal(response.status, 200);
  const rpc = await response.json();
  assert.ok(!rpc.error, JSON.stringify(rpc.error));
  const result = rpc.result;
  const value = JSON.parse(result.content.find((c) => c.type === "text").text);
  if (expectedError) {
    assert.equal(result.isError, true);
    assert.match(value.message, expectedError);
  } else assert.ok(!result.isError, JSON.stringify(value));
  return value;
}
async function openApp() {
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await page.evaluate(async (project) => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useOnboardingStore.getState().finish();
    await useDocumentStore.getState().closeProject();
    await useDocumentStore.getState().openProject(project);
    useDocumentStore.getState().setActiveFile("a/paper.pdf");
  }, project);
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
}
try {
  await openApp();
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const state = useAgentChatStore.getState();
    useAgentChatStore.setState({
      tabs: [
        {
          ...state.tabs[0],
          id: "pdf-agent",
          runtimeSessionKey: "pdf-agent",
          isStreaming: true,
        },
      ],
      activeTabId: "pdf-agent",
    });
    window.pdfAgentReady = false;
    window.catalex.listen("claude-output", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "system" && message.subtype === "init")
        window.pdfAgentReady = true;
    });
  });
  const workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId: "pdf-agent",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  await invoke("execute_claude_code", {
    projectPath: workspace.candidateRoot,
    sourceProjectPath: project,
    prompt: "Reply OK only",
    tabId: "pdf-agent",
    runtimeSessionKey: "pdf-agent",
    model: "sonnet",
    effortLevel: null,
    compileContext: null,
  });
  await page.waitForFunction(() => window.pdfAgentReady, undefined, {
    timeout: 45_000,
  });
  const cli = execFileSync("ps", ["-axo", "args="], { encoding: "utf8" })
    .split("\n")
    .find(
      (row) =>
        row.includes(workspace.candidateRoot) && row.includes("--mcp-config {"),
    );
  assert.ok(cli, "isolated agent MCP connection exists");
  connection = JSON.parse(cli.split("--mcp-config ")[1].split(" --")[0])
    .mcpServers.catalex;
  const read = await call("read_pdf", { filePath: "a/paper.pdf", pages: [1] });
  assert.match(read.fingerprint, /^[a-f0-9]{40}$/);
  assert.ok(read.pages[0].text.includes("Your abstract here."));
  const args = {
    filePath: "a/paper.pdf",
    passage: "Your abstract here.",
    text: "Agent PDF feedback",
    pdf: { page: 1, fingerprint: read.fingerprint },
  };
  const created = await call("create_comment", args);
  assert.equal(created.comment.origin.provider, "claude");
  assert.equal(created.comment.pdf.regions[0].page, 1);
  await expect(
    page.getByRole("button", {
      name: "Show agent comment: Agent PDF feedback",
      exact: true,
    }),
  ).toHaveCount(1);
  const summary = page.getByRole("button", {
    name: "Show comments: 0 human, 1 agent",
    exact: true,
  });
  if (await summary.isVisible()) await summary.click();
  await page.getByRole("button", { name: /Go to comment/ }).click();
  await expect(
    page
      .getByRole("dialog", { name: "PDF comment", exact: true })
      .getByText("Agent PDF feedback", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "agent-comment.png") });
  for (const [name, extra] of [
    ["edit_comment", { text: "Edited agent PDF feedback" }],
    ["resolve_comment", { resolved: true }],
    ["resolve_comment", { resolved: false }],
  ]) {
    const listed = await call("list_comments", { filePath: args.filePath });
    const entry = listed.comments.find(
      (entry) => entry.comment.id === created.comment.id,
    );
    const updated = await call(name, {
      filePath: args.filePath,
      id: created.comment.id,
      revision: entry.revision,
      ...extra,
    });
    assert.deepEqual(updated.comment.pdf, created.comment.pdf);
  }
  const second = await call("create_comment", {
    ...args,
    text: "Delete this test comment",
  });
  const listed = await call("list_comments", { filePath: args.filePath });
  const entry = listed.comments.find(
    (entry) => entry.comment.id === second.comment.id,
  );
  await call("delete_comment", {
    filePath: args.filePath,
    id: second.comment.id,
    revision: entry.revision,
  });
  await call(
    "create_comment",
    { ...args, passage: "Definitely absent passage" },
    /missing_passage/,
  );
  await call("create_comment", { ...args, passage: "e" }, /ambiguous_passage/);
  await call(
    "read_pdf",
    { filePath: args.filePath, pages: [999] },
    /invalid_page/,
  );
  await call(
    "read_pdf",
    { filePath: "../paper.pdf", pages: [1] },
    /invalid_path/,
  );
  await call(
    "create_comment",
    { ...args, pdf: { ...args.pdf, fingerprint: "0".repeat(40) } },
    /changed_pdf/,
  );
  await call("create_comment", { ...args, pdf: undefined }, /read_pdf first/);
  assert.equal(
    (await call("list_comments", { filePath: "b/paper.pdf" })).comments.length,
    0,
  );
  const other = await call("read_pdf", { filePath: "b/paper.pdf", pages: [1] });
  await call("create_comment", {
    ...args,
    filePath: "b/paper.pdf",
    pdf: { page: 1, fingerprint: other.fingerprint },
    text: "Other PDF feedback",
  });
  // Text-based creation remains generic, with no LaTeX compiler or source file.
  await call("create_comment", {
    filePath: "notes.md",
    passage: "plain Markdown",
    text: "Markdown still works",
  });
  assert.deepEqual(await fs.readFile(path.join(project, "a/paper.pdf")), bytes);
  const replacement = await fs.readFile(
    path.join(root, "public/examples/blank/main.pdf"),
  );
  await fs.writeFile(path.join(project, "a/paper.pdf"), replacement);
  await call("create_comment", args, /changed_pdf/);
  const snapshot = await invoke("read_project_comments_anchored", {
    projectRoot: project,
    includeDisconnected: true,
  });
  assert.equal(snapshot.disconnected["a/paper.pdf"].length, 1);
  assert.equal(snapshot.files["b/paper.pdf"].length, 1);
  await invoke("dispose_claude_session", { tabId: "pdf-agent" });
  await app.close();
  app = null;
  await openApp();
  const restored = await invoke("read_project_comments_anchored", {
    projectRoot: project,
    includeDisconnected: true,
  });
  assert.equal(restored.files["b/paper.pdf"][0].origin.provider, "claude");
  assert.equal(
    restored.disconnected["a/paper.pdf"][0].text,
    "Edited agent PDF feedback",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Native MCP PDF read/create/list/edit/resolve/reopen/delete, passage errors, same-name isolation, Markdown regression, replacement safety and restart passed.",
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  console.error({ profile, errors });
  throw error;
} finally {
  if (app) {
    await invoke("dispose_claude_session", { tabId: "pdf-agent" }).catch(
      () => {},
    );
    await app.close();
  }
  await vite.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
}
