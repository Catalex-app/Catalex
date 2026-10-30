#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

const evidence = async (record) =>
  fs.appendFile(
    process.env.CATALEX_PI_FIXTURE_LOG,
    `${JSON.stringify({ pid: process.pid, ...record })}\n`,
  );
await evidence({
  event: "launched",
  executable: process.argv[1],
  configDirectory: process.env.PI_CODING_AGENT_DIR,
});

// Deterministic Pi peer; all MCP calls go through the actual native service.
// Never makes a model request or writes credentials to its evidence log.
if (process.argv.includes("--version")) {
  await evidence({ event: "version-check" });
  // Real Pi initializes stdin even for --version. An inherited service socket
  // would become nonblocking and break the next native RPC read on macOS.
  process.stdin.resume();
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log("1.2.0");
  process.exit(0);
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const flag = (name) => process.argv[process.argv.indexOf(name) + 1];
const discovery = process.argv.includes("--no-session");
assert.ok(process.argv.includes("--no-approve"));
assert.equal(process.argv.includes("--approve"), false);
const model = {
  id: "fixture-model",
  provider: "fixture",
  name: "Pi fixture model",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" },
  contextWindow: 1000,
};
let connection;
let session;
let turn = 0;
let holding = false;
let rpcId = 0;
if (discovery && process.env.CATALEX_PI_MODELS) {
  const scope = await fs.readFile(process.env.CATALEX_PI_FIXTURE_SCOPE, "utf8");
  const otherProvider = {
    ...model,
    provider: "fixture-other",
    thinkingLevelMap: { low: null },
  };
  const excluded = { ...model, id: "outside-scope" };
  const extension = await import(pathToFileURL(flag("--extension")).href);
  extension.default({
    on(event, handler) {
      assert.equal(event, "session_start");
      handler(
        {},
        {
          model,
          scopedModels:
            scope === "unsupported"
              ? undefined
              : scope === "all"
                ? []
                : [{ model: otherProvider }, { model }],
          modelRegistry: {
            getAvailable: () => [model, excluded, otherProvider],
          },
        },
      );
    },
  });
} else if (!discovery) {
  session = flag("--session");
  assert.ok(session?.endsWith(".jsonl"));
  assert.ok(process.argv.includes("--offline"));
  assert.equal(flag("--provider"), "fixture");
  assert.equal(flag("--model"), "fixture-model");
  assert.equal(flag("--thinking"), "medium");
  assert.match(flag("--append-system-prompt"), /Use the Catalex MCP tools/);
  const extension = await import(pathToFileURL(flag("--extension")).href);
  extension.default({
    registerMcpServer(name, config) {
      assert.equal(name, "catalex");
      assert.equal(config.exposure, "direct");
      connection = config;
    },
  });
  assert.ok(connection);
  assert.equal(process.env.CATALEX_PI_MCP, undefined);
  assert.equal(process.env.CATALEX_PI_SANDBOX, undefined);
  const extensionPaths = process.argv.flatMap((value, index) =>
    value === "--extension" ? [process.argv[index + 1]] : [],
  );
  assert.equal(extensionPaths.length, 1);
  const contents = await fs.readFile(session, "utf8").catch(() => "");
  const records = contents.trim().split("\n").filter(Boolean).map(JSON.parse);
  turn = records.filter((record) => record.type === "fixture-turn").length + 1;
  if (records.length === 0) {
    await fs.writeFile(
      session,
      `${JSON.stringify({ type: "session", id: "pi-smoke-native-session", cwd: process.cwd() })}\n`,
    );
  } else {
    assert.equal(
      await fs.realpath(records[0].cwd),
      await fs.realpath(process.cwd()),
    );
  }
  await evidence({ event: "started", turn, session, cwd: process.cwd() });
}
async function rpc(method, params = {}) {
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      ...connection.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.ok(!reply.error, JSON.stringify(reply.error));
  return reply.result;
}
async function tool(name, args = {}) {
  const toolCallId = `${name}-${turn}`;
  send({ type: "tool_execution_start", toolCallId, toolName: name, args });
  const result = await rpc("tools/call", { name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  send({
    type: "tool_execution_end",
    toolCallId,
    toolName: name,
    result,
    isError: false,
  });
  return {
    result,
    value: JSON.parse(
      result.content.find((block) => block.type === "text").text,
    ),
  };
}
async function prompt(message) {
  assert.ok(!message.message.includes("Use the Catalex MCP tools"));
  if (message.message.endsWith("fixture:after-compact")) {
    assert.match(await fs.readFile(session, "utf8"), /"type":"compaction"/);
  }
  await fs.appendFile(
    session,
    `${JSON.stringify({ type: "fixture-turn", turn })}\n`,
  );
  send({
    type: "response",
    id: message.id,
    command: "prompt",
    success: true,
    data: { disposition: "started" },
  });
  send({ type: "message_start", message: { role: "assistant" } });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      delta: "Inspecting the fixture.",
    },
  });
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: `Pi fixture turn ${turn}.\u2028`,
    },
  });
  if (message.message.endsWith("fixture:hold")) {
    holding = true;
    await evidence({ event: "holding", turn });
    return;
  }
  if (message.message.endsWith("fixture:tools")) {
    send({ type: "compaction_start", reason: "threshold" });
    send({
      type: "compaction_end",
      reason: "threshold",
      result: { estimatedTokensAfter: 42 },
      aborted: false,
      willRetry: false,
    });
    send({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10,
      errorMessage: "Temporary fixture failure",
    });
    send({ type: "auto_retry_end", success: true, attempt: 1 });
    const catalog = await rpc("tools/list");
    assert.equal(catalog.tools.length, 10);
    const workspace = await tool("workspace_state");
    assert.equal(workspace.value.root.file, "main.tex");
    const compiled = await tool("compile");
    assert.equal(compiled.value.status, "success");
    const rendered = await tool("render_page", { pages: [1] });
    const image = rendered.result.content.find(
      (block) => block.type === "image",
    );
    assert.equal(image.mimeType, "image/png");
    assert.ok(Buffer.from(image.data, "base64").length > 100);
    const created = await tool("create_comment", {
      filePath: "main.tex",
      passage: "Pi smoke fixture",
      text: "Pi review comment",
      lineHint: 3,
    });
    assert.equal(created.value.status, "created");
    assert.equal(created.value.comment.origin.provider, "pi");
    const listed = await tool("list_comments", { filePath: "main.tex" });
    assert.ok(
      listed.value.comments.some(
        ({ comment }) => comment.id === created.value.comment.id,
      ),
    );
    const answer = await tool("ask_user", {
      question: "Continue the Pi fixture?",
      options: [{ label: "Continue" }, { label: "Stop" }],
    });
    assert.equal(answer.value.answer, "Continue");
    await evidence({
      event: "tools",
      compiled: true,
      rendered: true,
      commentProvider: "pi",
      answer: answer.value.answer,
    });
  }
  const failed = message.message.endsWith("fixture:fail");
  send({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: failed ? "error" : "stop",
      errorMessage: failed ? "Fixture provider failed" : undefined,
      content: [
        { type: "thinking", thinking: "Inspected the fixture." },
        { type: "text", text: `Pi fixture turn ${turn} complete.\u2028` },
      ],
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0 },
    },
  });
  send({ type: "agent_settled", aborted: false });
}
async function compact(message) {
  const mode = await fs.readFile(
    process.env.CATALEX_PI_FIXTURE_COMPACTION,
    "utf8",
  );
  await evidence({ event: "compacting", mode, session });
  if (mode === "hold") {
    holding = true;
    return;
  }
  if (mode === "fail") {
    send({
      type: "response",
      id: message.id,
      success: false,
      error: "Fixture compaction failed",
    });
    return;
  }
  // Unrelated completion events must not finish the RPC before its response.
  send({ type: "agent_settled", aborted: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const data = {
    summary: "Fixture summary",
    firstKeptEntryId: "fixture",
    tokensBefore: 35,
    estimatedTokensAfter: 12,
    usage: { input: 400, output: 100 },
  };
  await fs.appendFile(
    session,
    `${JSON.stringify({ type: "compaction", ...data })}\n`,
  );
  send({
    type: "response",
    id: message.id,
    command: "compact",
    success: true,
    data,
  });
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "get_commands") {
    const skills = [
      {
        name: "skill:configured-skill",
        description: "Configured package skill",
        source: "skill",
        sourceInfo: {
          path: path.join(
            process.env.PI_CODING_AGENT_DIR,
            "package/nested/SKILL.md",
          ),
          scope: "user",
        },
      },
      {
        name: "skill:review-document",
        source: "skill",
        sourceInfo: {
          path: path.join(flag("--skill"), "review-document/SKILL.md"),
          scope: "temporary",
        },
      },
      { name: "extension-command", source: "extension" },
    ];
    send({
      type: "response",
      id: message.id,
      success: true,
      data: { commands: skills },
    });
  } else if (message.type === "get_state") {
    if (!discovery)
      send({
        type: "extension_error",
        event: "session_start",
        extensionPath: "/fixture/extension.mjs",
        error: "Nonfatal fixture hook error",
      });
    send({ type: "response", id: message.id, success: true, data: { model } });
  } else if (message.type === "prompt") {
    void prompt(message).catch((error) => {
      send({
        type: "response",
        id: "fixture-error",
        success: false,
        error: error.message,
      });
    });
  } else if (message.type === "compact") {
    void compact(message).catch((error) => {
      send({
        type: "response",
        id: message.id,
        success: false,
        error: error.message,
      });
    });
  } else if (message.type === "abort") {
    void evidence({ event: "aborted" });
    send({ type: "response", id: message.id, success: true, data: {} });
  }
});
lines.on("close", async () => {
  if (holding) {
    const revoked = await rpc("tools/call", {
      name: "workspace_state",
      arguments: {},
    }).then(
      (result) => result.isError === true,
      () => true,
    );
    await evidence({ event: "cancelled", revoked });
  }
  process.exit(0);
});
