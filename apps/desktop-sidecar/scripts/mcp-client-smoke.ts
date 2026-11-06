// No inference by default. CATALEX_MCP_AGENT_PROBE=1 also tests a model-triggered call.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  catalexMcpConfig,
  type CatalexMcpConnection,
} from "../src/catalex-mcp.js";
import { reviewSkillName, catalexSkillPlugin } from "../src/catalex-skills.js";

// Exercise the app's actual provider configuration, not a hand-written copy.
const {
  connection,
  codexConfig,
  pluginRoot,
}: {
  connection: CatalexMcpConnection;
  codexConfig: Record<string, unknown>;
  pluginRoot: string;
} = JSON.parse(await Bun.stdin.text());
const expected = [
  "ask_user",
  "compile",
  "create_comment",
  "delete_comment",
  "diagnostics",
  "edit_comment",
  "list_comments",
  "read_pdf",
  "render_page",
  "resolve_comment",
  "workspace_state",
];
const client = new Client({ name: "catalex-smoke", version: "1" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers },
  }),
);
try {
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name).sort(),
    expected,
  );
  const image = await client.callTool({
    name: "render_page",
    arguments: { pages: [1] },
  });
  assert.equal((image.content as Array<{ type: string }>)[1].type, "image");
  const comment = await client.callTool({
    name: "create_comment",
    arguments: {
      filePath: "main.tex",
      passage: "exact passage",
      text: "Review note",
    },
  });
  assert.equal(comment.isError, false);
  for (const name of [
    "list_comments",
    "edit_comment",
    "resolve_comment",
    "delete_comment",
  ]) {
    const result = await client.callTool({
      name,
      arguments:
        name === "list_comments"
          ? { filePath: "main.tex" }
          : {
              filePath: "main.tex",
              id: "A-1",
              revision: "fixture",
              ...(name === "edit_comment" ? { text: "Updated" } : {}),
            },
    });
    assert.equal(result.isError, false);
    assert.equal(
      JSON.parse((result.content as Array<{ text: string }>)[0].text).tool,
      name,
    );
  }
  const question = await client.callTool({
    name: "ask_user",
    arguments: {
      question: "Continue?",
      options: [{ label: "Update" }, { label: "Discard unsaved" }],
    },
  });
  assert.equal(question.isError, false);
} finally {
  await client.close();
}
console.log("MCP TypeScript client: discovery and image content passed");

const codex = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "ignore"],
});
const pending = new Map<
  number,
  { resolve: (result: any) => void; reject: (error: Error) => void }
>();
let nextId = 0;
const notifications: any[] = [];
let onNotification: (() => void) | undefined;
const lines = createInterface({ input: codex.stdout });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method) {
    notifications.push(message);
    onNotification?.();
  }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
function request(method: string, params: unknown): Promise<any> {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(method + " timed out"));
    }, 30_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    codex.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
try {
  await request("initialize", {
    clientInfo: { name: "catalex-smoke", version: "1" },
    capabilities: { experimentalApi: true },
  });
  const skillsRoot = join(pluginRoot, "skills");
  await request("skills/extraRoots/set", { extraRoots: [skillsRoot] });
  const skills = await request("skills/list", {
    cwds: [process.cwd()],
    forceReload: true,
  });
  for (const name of ["review-document", "catalex-verify-latex"]) {
    assert.ok(
      skills.data.some((entry: any) =>
        entry.skills.some(
          (skill: any) =>
            skill.enabled &&
            skill.name === name &&
            skill.path === join(skillsRoot, name, "SKILL.md"),
        ),
      ),
      `Codex must discover bundled ${name}: ${JSON.stringify(
        skills.data.map((entry: any) => ({
          errors: entry.errors,
          skills: entry.skills
            .filter((skill: any) => skill.name === name)
            .map((skill: any) => ({
              name: skill.name,
              path: skill.path,
              enabled: skill.enabled,
            })),
        })),
      )}`,
    );
  }
  console.log(
    "Installed Codex: shared review and verification skills discovered",
  );
  const started = await request("thread/start", {
    cwd: process.cwd(),
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    config: { mcp_servers: codexConfig },
  });
  const threadId = started.thread.id;
  const status = await request("mcpServerStatus/list", { threadId });
  const server = status.data.find((server: any) => server.name === "catalex");
  assert.ok(server, "Codex must discover Catalex MCP");
  assert.deepEqual(Object.keys(server.tools).sort(), expected);
  const called = await request("mcpServer/tool/call", {
    threadId,
    server: "catalex",
    tool: "workspace_state",
    arguments: {},
  });
  assert.equal(called.isError, false, JSON.stringify(called));
  const payload = JSON.parse(called.content[0].text);
  assert.equal(payload.tool, "workspace_state");
  assert.equal(payload.scope, "/draft-smoke");
  const comment = await request("mcpServer/tool/call", {
    threadId,
    server: "catalex",
    tool: "create_comment",
    arguments: {
      filePath: "main.tex",
      passage: "exact passage",
      text: "Review note",
    },
  });
  assert.equal(comment.isError, false, JSON.stringify(comment));
  assert.equal(JSON.parse(comment.content[0].text).tool, "create_comment");
  const question = await request("mcpServer/tool/call", {
    threadId,
    server: "catalex",
    tool: "ask_user",
    arguments: {
      question: "Continue?",
      options: [{ label: "Update" }, { label: "Discard unsaved" }],
    },
  });
  assert.equal(question.isError, false, JSON.stringify(question));
  assert.equal(JSON.parse(question.content[0].text).tool, "ask_user");
  console.log(
    "Installed Codex: thread config, discovery, and direct MCP call passed",
  );
  if (process.env.CATALEX_MCP_AGENT_PROBE === "1") {
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Agent MCP probe timed out")),
        60_000,
      );
      onNotification = () => {
        if (notifications.some((event) => event.method === "turn/completed")) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    await request("turn/start", {
      threadId,
      model: "gpt-5.6-luna",
      effort: "low",
      approvalPolicy: "never",
      input: [
        {
          type: "text",
          text: "Call the Catalex MCP workspace_state tool exactly once with {}. Do not call any other tools, read or edit files, or use skills. Then briefly report whether that call succeeded.",
        },
      ],
    });
    await completed;
    const calls = notifications
      .filter((event) => event.method === "item/completed")
      .map((event) => event.params.item)
      .filter(
        (item) => item.type === "mcpToolCall" && item.server === "catalex",
      );
    assert.equal(calls.length, 1, "Agent must attempt the MCP tool");
    assert.equal(calls[0].status, "completed", JSON.stringify(calls[0]));
    const result = JSON.parse(calls[0].result.content[0].text);
    assert.equal(result.scope, "/draft-smoke");
    console.log(
      "Model-triggered workspace_state executed successfully under approvalPolicy=never",
    );
  }
} finally {
  lines.close();
  codex.kill();
}

// A streaming input with no messages initializes the CLI without inference.
let releaseInput: (() => void) | undefined;
async function* noPrompt(): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => {
    releaseInput = resolve;
  });
}
const claude = query({
  prompt: noPrompt(),
  options: {
    cwd: process.cwd(),
    persistSession: false,
    settingSources: [],
    plugins: [catalexSkillPlugin(pluginRoot)],
    mcpServers: { catalex: catalexMcpConfig(connection) },
  },
});
try {
  await claude.initializationResult();
  const commands = await claude.supportedCommands();
  assert.ok(
    commands.some((command) => command.name === reviewSkillName),
    "Claude must discover the shared review-document skill",
  );
  console.log("Installed Claude SDK: shared review-document skill discovered");
  const statuses = await claude.mcpServerStatus();
  const server = statuses.find((server) => server.name === "catalex");
  assert.equal(server?.status, "connected", server?.error);
  assert.deepEqual(server?.tools?.map((tool) => tool.name).sort(), expected);
  console.log(
    "Installed Claude SDK: HTTP connection and shared catalog passed",
  );
} finally {
  releaseInput?.();
  claude.close();
}
