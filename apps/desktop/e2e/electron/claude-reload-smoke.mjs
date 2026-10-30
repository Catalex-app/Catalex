import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";

// Real Electron -> Rust -> Agent SDK -> installed Claude CLI, with a local
// rejected-credential endpoint. No real account or model request is used.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-claude-reload-"),
);
const project = path.join(profile, "project");
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, "main.tex"),
  "\\documentclass{article}\n\\begin{document}Test\\end{document}\n",
);
const endpoint = http.createServer((_request, response) => {
  response.writeHead(401, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "OAuth access token has been revoked.",
      },
    }),
  );
});
await new Promise((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CLAUDE_CONFIG_DIR: path.join(profile, "claude"),
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${endpoint.address().port}`,
  ANTHROPIC_API_KEY: "test-only-invalid-key",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
};
for (const key of [
  "ELECTRON_RUN_AS_NODE",
  "CATALEX_DEV_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete env[key];
const processRows = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((row) => {
      const [, pid, ppid, command] = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: Number(pid), ppid: Number(ppid), command };
    });
let app;
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
  const helper = processRows().find(
    (row) =>
      row.ppid === app.process().pid && row.command.includes("catalex-desktop"),
  );
  assert.ok(helper, "real Rust helper is running");
  const bridges = () =>
    processRows()
      .filter(
        (row) =>
          row.ppid === helper.pid &&
          row.command.toLowerCase().includes("electron"),
      )
      .map((row) => row.pid);
  await expect.poll(bridges, { timeout: 45_000 }).toEqual([]);
  const start = (tabId) =>
    invoke("execute_claude_code", {
      projectPath: project,
      sourceProjectPath: project,
      prompt: "Reply OK only",
      tabId,
      runtimeSessionKey: `reload-${tabId}`,
      model: "sonnet",
      effortLevel: null,
      compileContext: null,
    });
  await start("a");
  await expect.poll(() => bridges().length).toBe(1);
  const [first] = bridges();
  await expect
    .poll(() =>
      processRows().some(
        (row) => row.ppid === first && row.command.includes("claude"),
      ),
    )
    .toBe(true);
  const cliPid = processRows().find(
    (row) => row.ppid === first && row.command.includes("claude"),
  ).pid;
  await start("b");
  await expect.poll(() => bridges().length).toBe(2);
  const second = bridges().find((pid) => pid !== first);
  await invoke("dispose_claude_session", { tabId: "a" });
  await expect.poll(bridges).toEqual([second]);
  assert.ok(
    !processRows().some((row) => row.pid === first),
    "old bridge exited",
  );
  await expect
    .poll(() => processRows().some((row) => row.pid === cliPid))
    .toBe(false);
  await start("a");
  await expect.poll(() => bridges().length).toBe(2);
  assert.ok(
    !bridges().includes(first),
    "a fresh bridge replaces the disposed connection",
  );
  assert.ok(bridges().includes(second), "other chat stays running");
  await invoke("dispose_claude_session", { tabId: "a" });
  await invoke("dispose_claude_session", { tabId: "b" });
  await expect.poll(bridges, { timeout: 45_000 }).toEqual([]);
  console.log(
    "PASS: native Claude disposal exits the affected bridge, preserves another chat, and allows a fresh process without restarting Electron.",
  );
} finally {
  await app?.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
