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
// Draft files are written directly, as an agent would write them.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-comment-acceptance-"),
);
const project = path.join(profile, "project");
const text = "# Notes\n\nThis paragraph needs a clearer claim before review.\n";
await fs.mkdir(project, { recursive: true });
for (const file of ["fourth.md", "main.md", "other.md", "third.md"])
  await fs.writeFile(path.join(project, file), text);
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
  "../../output/playwright/electron/comment-acceptance",
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
    useDocumentStore.getState().setActiveFile("main.md");
  }, project);
  await expect(page.locator(".cm-content").first()).toBeVisible();
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
          id: "accept-agent",
          runtimeSessionKey: "accept-agent",
          isStreaming: true,
        },
      ],
      activeTabId: "accept-agent",
    });
    window.acceptAgentReady = false;
    window.catalex.listen("claude-output", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "system" && message.subtype === "init")
        window.acceptAgentReady = true;
    });
  });
  const workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId: "accept-agent",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  await invoke("execute_claude_code", {
    projectPath: workspace.candidateRoot,
    sourceProjectPath: project,
    prompt: "Reply OK only",
    tabId: "accept-agent",
    runtimeSessionKey: "accept-agent",
    model: "sonnet",
    effortLevel: null,
    compileContext: null,
  });
  await page.waitForFunction(() => window.acceptAgentReady, undefined, {
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
  const stored = () =>
    invoke("read_project_comments_anchored", { projectRoot: project });
  const comment = async (filePath) =>
    (await stored()).files[filePath].find((item) => !item.resolved);
  for (const filePath of ["fourth.md", "main.md", "other.md", "third.md"])
    await call("create_comment", {
      filePath,
      passage: "needs a clearer claim",
      text: `Clarify the claim in ${filePath}`,
    });
  // The whole project is listed without naming a file.
  const all = await call("list_comments", {});
  assert.equal(all.truncated, false);
  assert.deepEqual(
    all.files.map((file) => [file.filePath, file.comments.length]),
    [
      ["fourth.md", 1],
      ["main.md", 1],
      ["other.md", 1],
      ["third.md", 1],
    ],
  );
  // The agent rewrites each passage in its draft and asks for the comments to
  // be resolved once the user accepts the change.
  for (const file of all.files) {
    await fs.writeFile(
      path.join(workspace.candidateRoot, file.filePath),
      text.replace("needs a clearer claim", "states its claim clearly"),
    );
    const { comment: item, revision } = file.comments[0];
    const requested = await call("resolve_comment", {
      filePath: file.filePath,
      id: item.id,
      revision,
      when: "accepted",
    });
    assert.equal(requested.status, "resolves_on_acceptance");
    assert.equal(requested.comment.resolved, false);
  }
  const listed = await call("list_comments", { filePath: "main.md" });
  assert.equal(listed.comments[0].resolvesOnAcceptance, true);
  assert.equal((await comment("main.md")).resolved, false);
  // The request for third.md is withdrawn again.
  await call("resolve_comment", {
    filePath: "third.md",
    id: all.files[3].comments[0].comment.id,
    revision: all.files[3].comments[0].revision,
    when: "accepted",
    resolved: false,
  });
  await invoke("dispose_claude_session", { tabId: "accept-agent" });
  const review = await invoke("reconcile_agent_workspace", {
    projectRoot: project,
    sessionId: workspace.sessionId,
    outcome: "success",
  });
  assert.equal(review.changes.length, 4);
  const decide = (filePath, accept) => {
    const change = review.changes.find((item) => item.filePath === filePath);
    return {
      changeId: change.id,
      accept,
      proposalRevision: change.proposalRevision,
    };
  };
  // Nothing is resolved before the user decides.
  assert.equal((await stored()).files["main.md"][0].resolved, false);
  // Rejected text leaves its comment open.
  const rejected = await invoke("apply_agent_workspace", {
    projectRoot: project,
    sessionId: workspace.sessionId,
    decisions: [decide("other.md", false)],
  });
  assert.equal(rejected.applied, true);
  assert.equal((await stored()).files["other.md"][0].resolved, false);
  // The remaining files are accepted in the app's own review.
  await page.evaluate(async (session) => {
    const { useAgentChatStore: chat } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    chat.setState((state) => ({
      tabs: state.tabs.map((tab) => ({ ...tab, isStreaming: false })),
    }));
    chat.getState()._setAgentWorkspace(session.tabId, session);
    const { useAgentReviewQueueStore: reviews } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    await reviews.getState().enqueue(session);
  }, review.session);
  const panel = page.locator("[data-proposed-changes-panel]");
  await expect(panel).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "review.png") });
  // The review shows one file at a time. One file is decided with the edit's
  // own Accept, one with its Reject, and one with Accept All.
  const active = () =>
    page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const state = useDocumentStore.getState();
      return state.files.find((file) => file.id === state.activeFileId)
        ?.relativePath;
    });
  const content = (file) => fs.readFile(path.join(project, file), "utf8");
  const decided = [];
  for (let step = 0; step < 3; step++) {
    await expect(panel).toBeVisible();
    await expect.poll(async () => decided.includes(await active())).toBe(false);
    const file = await active();
    const button =
      file === "third.md"
        ? panel.getByRole("button", { name: "Accept All", exact: true })
        : page.getByRole("button", {
            name: file === "main.md" ? "Accept" : "Reject",
            exact: true,
          });
    await button.click();
    if (file === "fourth.md") {
      // Reverting the only edit leaves nothing of this file to review.
      await expect.poll(async () => (await active()) !== file).toBe(true);
    } else
      await expect
        .poll(() => content(file))
        .toMatch(/states its claim clearly/);
    decided.push(file);
  }
  assert.deepEqual([...decided].sort(), ["fourth.md", "main.md", "third.md"]);
  assert.match(await content("fourth.md"), /needs a clearer claim/);
  await expect
    .poll(async () => (await stored()).files["main.md"][0].resolved)
    .toBe(true);
  const settled = (await stored()).files;
  // A withdrawn request leaves its comment open although the text was accepted.
  assert.equal(settled["other.md"][0].resolved, false);
  assert.equal(settled["third.md"][0].resolved, false);
  // So does an edit that was rejected in the review editor.
  assert.equal(settled["fourth.md"][0].resolved, false);
  await page.screenshot({ path: path.join(artifacts, "after-acceptance.png") });
  await app.close();
  app = null;
  await openApp();
  const restored = (await stored()).files;
  assert.equal(restored["main.md"][0].resolved, true);
  assert.equal(restored["other.md"][0].resolved, false);
  assert.deepEqual(errors, []);
  console.log(
    "Project-wide comment listing, resolve on acceptance by file and by edit, a rejected edit, a rejected file, withdrawal, and restart passed.",
  );
} catch (error) {
  await page
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  console.error({ profile, errors });
  throw error;
} finally {
  if (app) {
    await invoke("dispose_claude_session", { tabId: "accept-agent" }).catch(
      () => {},
    );
    await app.close();
  }
  await vite.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
}
