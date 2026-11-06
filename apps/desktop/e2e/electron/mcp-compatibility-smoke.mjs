import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Real clients and native server; a local model endpoint holds a turn open.
// No model inference or user-project data is used. Unix process inspection.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-mcp-compat-"));
const project = path.join(profile, "project");
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}Test\\end{document}\n",
);
const endpoint = http.createServer((request) => request.resume());
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CLAUDE_CONFIG_DIR: path.join(profile, "claude"),
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
const evidence = {
  protocols: {},
  claude: null,
  codex: null,
  codexNewVersion: null,
};
let app;
let proxy;
let connection;
const traces = [];
let forceNewVersion = false;
let proxyError;
const expected = [
  "ask_user",
  "compile",
  "create_comment",
  "delete_comment",
  "diagnostics",
  "edit_comment",
  "list_comments",
  "render_page",
  "read_pdf",
  "resolve_comment",
  "workspace_state",
].sort();
const normalize = (value) =>
  JSON.parse(JSON.stringify(value).replaceAll(project, "<project>"));
async function rpc(version, method, params = {}) {
  if (version === "2026-07-28")
    params = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientInfo": {
          name: "compatibility-test",
          version: "1",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  const response = await fetch(connection.url, {
    method: "POST",
    headers: {
      ...connection.headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": version,
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.ok(!reply.error, JSON.stringify(reply.error));
  return normalize(reply.result);
}
async function inspectCodex(url, attemptNewVersion = false) {
  const child = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  const pending = new Map();
  let sequence = 0;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          message.error
            ? waiter.reject(new Error(JSON.stringify(message.error)))
            : waiter.resolve(message.result);
        }
      } catch {}
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  try {
    await request("initialize", {
      clientInfo: { name: "catalex-compatibility", version: "1" },
      capabilities: { experimentalApi: true },
    });
    const started = await request("thread/start", {
      cwd: project,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      config: {
        mcp_servers: { catalex: { url, http_headers: connection.headers } },
      },
    });
    const status = await request("mcpServerStatus/list", {
      threadId: started.thread.id,
    });
    const server = status.data.find((server) => server.name === "catalex");
    const tools = Object.keys(server?.tools ?? {}).sort();
    if (attemptNewVersion && tools.length === 0)
      return { tools, supported: false };
    assert.deepEqual(tools, expected);
    const comments = await request("mcpServer/tool/call", {
      threadId: started.thread.id,
      server: "catalex",
      tool: "list_comments",
      arguments: { filePath: "main.tex" },
    });
    assert.notEqual(comments.isError, true, JSON.stringify(comments));
    return { tools, comments: normalize(comments), supported: true };
  } finally {
    child.stdin.end();
    child.kill();
  }
}
try {
  app = await electron.launch({ args: [root], env, timeout: 30_000 });
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
  await invoke("get_system_info");
  await page.evaluate(() => {
    window.compatInit = null;
    window.catalex.listen("claude-output", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "system" && message.subtype === "init")
        window.compatInit = {
          tools: message.tools.filter((tool) =>
            tool.startsWith("mcp__catalex__"),
          ),
          servers: message.mcp_servers,
        };
    });
  });
  const workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId: "compat",
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  await invoke("execute_claude_code", {
    projectPath: workspace.candidateRoot,
    sourceProjectPath: project,
    prompt: "Reply OK only",
    tabId: "compat",
    runtimeSessionKey: "compat",
    model: "sonnet",
    effortLevel: null,
    compileContext: null,
  });
  await page.waitForFunction(() => window.compatInit, undefined, {
    timeout: 45_000,
  });
  evidence.claude = await page.evaluate(() => window.compatInit);
  const processes = execFileSync("ps", ["-axo", "args="], {
    encoding: "utf8",
  }).split("\n");
  const cli = processes.find(
    (row) =>
      row.includes(workspace.candidateRoot) && row.includes("--mcp-config {"),
  );
  assert.ok(cli, "isolated Claude CLI configuration exists");
  const allowedTools = cli.match(/--allowedTools\s+(.+?)(?=\s+--|$)/)?.[1];
  assert.ok(allowedTools, "Claude receives an explicit tool permission list");
  for (const tool of [
    ...expected.map((name) => `mcp__catalex__${name}`),
    "WebFetch",
    "WebSearch",
  ])
    assert.ok(
      allowedTools.split(/[\s,]+/).includes(tool),
      `${tool} is allowed without an unavailable interactive permission prompt`,
    );
  connection = JSON.parse(cli.split("--mcp-config ")[1].split(" --")[0])
    .mcpServers.catalex;
  for (const version of ["2025-06-18", "2025-11-25", "2026-07-28"]) {
    evidence.protocols[version] = {
      catalog: await rpc(version, "tools/list"),
      comments: await rpc(version, "tools/call", {
        name: "list_comments",
        arguments: { filePath: "main.tex" },
      }),
    };
    assert.notEqual(
      evidence.protocols[version].comments.isError,
      true,
      JSON.stringify(evidence.protocols[version].comments),
    );
  }
  proxy = http.createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const message = body ? JSON.parse(body) : {};
      const headers = { ...request.headers };
      delete headers.host;
      delete headers["content-length"];
      const upstream = await fetch(connection.url, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : body,
      });
      let text = await upstream.text();
      traces.push({
        method: message.method,
        protocol:
          headers["mcp-protocol-version"] ?? message.params?.protocolVersion,
        status: upstream.status,
        forced: forceNewVersion,
      });
      // Diagnostic only: test whether Codex accepts a server choosing the new
      // version. This does not upgrade Codex's own protocol implementation.
      if (forceNewVersion && message.method === "initialize" && upstream.ok) {
        const result = JSON.parse(text);
        result.result.protocolVersion = "2026-07-28";
        text = JSON.stringify(result);
      }
      response.writeHead(upstream.status, {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(text);
    } catch (error) {
      proxyError = error;
      response.writeHead(502);
      response.end();
    }
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}/mcp`;
  evidence.codex = await inspectCodex(proxyUrl);
  forceNewVersion = true;
  try {
    evidence.codexNewVersion = await inspectCodex(proxyUrl, true);
  } catch (error) {
    evidence.codexNewVersion = { supported: false, error: error.message };
  }
  evidence.traces = traces;
  assert.ok(!proxyError, String(proxyError));
  if (process.env.CATALEX_MCP_BASELINE) {
    const baseline = JSON.parse(
      await fs.readFile(process.env.CATALEX_MCP_BASELINE, "utf8"),
    );
    assert.deepEqual(
      evidence.codex,
      baseline.codex,
      "Codex catalog and tool result unchanged",
    );
    for (const version of ["2025-06-18", "2025-11-25"])
      assert.deepEqual(
        evidence.protocols[version],
        baseline.protocols[version],
        `${version} unchanged`,
      );
    assert.deepEqual(
      evidence.claude.tools
        .map((tool) => tool.replace("mcp__catalex__", ""))
        .sort(),
      expected,
    );
    assert.equal(evidence.protocols["2026-07-28"].catalog.ttlMs, 0);
    assert.equal(
      evidence.protocols["2026-07-28"].catalog.cacheScope,
      "private",
    );
  }
  const output =
    process.env.CATALEX_MCP_REPORT ?? "/tmp/catalex-mcp-compatibility.json";
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(
    JSON.stringify({
      claudeTools: evidence.claude.tools.length,
      codexTools: evidence.codex.tools.length,
      codexNewVersion: evidence.codexNewVersion,
      report: output,
    }),
  );
  await invoke("dispose_claude_session", { tabId: "compat" });
} finally {
  await app?.close();
  proxy?.closeAllConnections();
  proxy?.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
