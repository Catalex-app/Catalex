import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

// Real Claude runtime -> permission callback -> native question -> answer.
// A local model endpoint requests a read-only tool; no model inference is used.
const freshSetup = process.argv.includes("--fresh-setup");
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-permissions-"),
);
const project = path.join(profile, "project");
const config = path.join(profile, "claude");
await fs.mkdir(project);
await fs.mkdir(config);
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}Test\\end{document}\n",
);
await fs.writeFile(
  path.join(config, "settings.json"),
  JSON.stringify(
    freshSetup
      ? {}
      : { permissions: { ask: ["mcp__catalex__workspace_state"] } },
  ),
);
let resultSeen = null;
const endpoint = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (request.url?.includes("count_tokens")) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ input_tokens: 1 }));
    return;
  }
  const results = (body.messages ?? [])
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((block) => block.type === "tool_result");
  if (results.length) resultSeen = results.at(-1);
  const block = results.length
    ? { type: "text", text: "Done" }
    : {
        type: "tool_use",
        id: "permission_tool",
        name: "mcp__catalex__workspace_state",
        input: {},
      };
  const reason = results.length ? "end_turn" : "tool_use";
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const event = (type, value) =>
    response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`,
    );
  event("message_start", {
    message: {
      id: "msg_permission",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  event("content_block_start", { index: 0, content_block: block });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: reason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  event("message_stop", {});
  response.end();
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}`,
  ANTHROPIC_API_KEY: "local-test-only",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "CATALEX_DEV_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete env[key];
let app;
try {
  const launch = process.env.CATALEX_SMOKE_EXECUTABLE
    ? { executablePath: process.env.CATALEX_SMOKE_EXECUTABLE, args: [] }
    : { args: [root] };
  // Finder launches inherit `/`; metadata checks must remain safe from there.
  app = await electron.launch({ ...launch, cwd: "/", env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
  const invoke = (command, args) =>
    page.evaluate(
      async ({ command, args }) => {
        const reply = await window.catalex.invoke(command, args);
        if ("error" in reply) throw new Error(JSON.stringify(reply.error));
        return reply.result;
      },
      { command, args },
    );
  const status = await invoke("check_claude_status", {});
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  const models = await invoke("list_claude_models", {});
  assert.ok(Array.isArray(models) && models.length > 0);
  console.log(
    "Installed Claude status and model discovery passed from a root-cwd app launch.",
  );
  const workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId: "permission",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  await invoke("execute_claude_code", {
    projectPath: workspace.candidateRoot,
    sourceProjectPath: project,
    prompt: "Inspect workspace state",
    tabId: "permission",
    runtimeSessionKey: "permission",
    model: "sonnet",
    effortLevel: null,
    compileContext: null,
  });
  if (!freshSetup) {
    let question;
    await expect
      .poll(
        async () => {
          const questions = await invoke("list_agent_questions", {});
          question = questions[0];
          return questions.length;
        },
        { timeout: 60_000 },
      )
      .toBe(1);
    assert.deepEqual(
      question.options.slice(0, 2).map((choice) => choice.label),
      ["Deny", "Approve once"],
    );
    assert.ok(question.options.length <= 3);
    if (question.options.length === 3) {
      assert.equal(question.options[2].label, "Approve suggested rule");
      assert.match(question.details, /Suggested permissions:/);
    }
    assert.match(question.details, /workspace_state/);
    await invoke("answer_agent_question", {
      requestId: question.requestId,
      tabId: question.tabId,
      sessionId: question.sessionId,
      answer: "Approve once",
    });
  }
  await expect.poll(() => resultSeen, { timeout: 30_000 }).not.toBeNull();
  assert.notEqual(resultSeen.is_error, true, JSON.stringify(resultSeen));
  assert.ok(!JSON.stringify(resultSeen).includes("haven't granted"));
  assert.deepEqual(await invoke("list_agent_questions", {}), []);
  await invoke("dispose_claude_session", { tabId: "permission" });
  console.log(
    freshSetup
      ? "Fresh Claude config: app MCP tool ran without manual approval."
      : "Claude permission callback, native choice UI protocol, approval, and tool execution passed.",
  );
} finally {
  await app?.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
