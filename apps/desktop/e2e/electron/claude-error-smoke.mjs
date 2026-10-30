import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
  response.writeHead(400, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Test endpoint rejected request.",
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
let app;
try {
  app = await electron.launch({ args: [root], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
  await page.evaluate(() => {
    window.claudeEvents = [];
    for (const event of [
      "claude-output",
      "claude-error",
      "claude-diagnostic",
      "claude-complete",
    ]) {
      window.catalex.listen(event, (payload) =>
        window.claudeEvents.push({ event, payload }),
      );
    }
  });
  const reply = await page.evaluate(
    async (projectPath) =>
      window.catalex.invoke("execute_claude_code", {
        projectPath,
        sourceProjectPath: projectPath,
        prompt: "Reply OK only",
        tabId: "error-smoke",
        runtimeSessionKey: "error-smoke",
        model: "sonnet",
        effortLevel: null,
        compileContext: null,
      }),
    project,
  );
  assert.ok(!reply.error, JSON.stringify(reply.error));
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          window.claudeEvents.some(
            (item) =>
              item.event === "claude-complete" &&
              item.payload.success === false,
          ),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
  const events = await page.evaluate(() => window.claudeEvents);
  const output = events
    .filter((item) => item.event === "claude-output")
    .map((item) => JSON.parse(item.payload.data));
  assert.ok(
    output.some(
      (message) =>
        message.type === "assistant" &&
        message.error &&
        message.message?.content?.some((block) =>
          block.text?.includes("Test endpoint rejected request."),
        ),
    ),
    "The real SDK failure text reaches Electron unchanged",
  );
  assert.ok(
    output.some((message) => message.type === "result" && message.is_error),
    "SDK failure status preserved",
  );
  console.log(
    "PASS: real Claude SDK failure text and status survive native routing to Electron.",
  );
} catch (error) {
  const page = await app?.firstWindow();
  if (page)
    console.log(JSON.stringify(await page.evaluate(() => window.claudeEvents)));
  throw error;
} finally {
  await app?.close();
  endpoint.closeAllConnections();
  await new Promise((resolve) => endpoint.close(resolve));
  await fs.rm(profile, { recursive: true, force: true });
}
