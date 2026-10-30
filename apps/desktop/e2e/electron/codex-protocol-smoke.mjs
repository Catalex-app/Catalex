import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-codex-protocol-"),
);
const bin = path.join(profile, "bin");
const project = path.join(profile, "project");
await fs.mkdir(bin);
await fs.mkdir(project);
const executable = path.join(bin, "codex");
await fs.copyFile(
  fileURLToPath(new URL("fixtures/codex-protocol.mjs", import.meta.url)),
  executable,
);
await fs.chmod(executable, 0o755);
let app;
let vite;
try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();
  const env = {
    ...process.env,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(
      path.delimiter,
    ),
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
    CATALEX_SERVICE_PATH: path.join(
      desktopRoot,
      "backend/target/debug/catalex-desktop",
    ),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.catalex);
  await page.evaluate(() => {
    window.__codexProtocolEvents = [];
    for (const event of ["codex-output", "codex-complete", "codex-error"])
      window.catalex.listen(event, (payload) =>
        window.__codexProtocolEvents.push({ event, payload }),
      );
  });
  const status = await page.evaluate(() =>
    window.catalex.invoke("check_codex_status"),
  );
  assert.equal(status.result?.binary_path, executable);
  const subscription = await page.evaluate(() =>
    window.catalex.invoke("read_codex_subscription_usage"),
  );
  assert.deepEqual(subscription.result, {
    rateLimits: {
      primary: null,
      secondary: {
        usedPercent: 32,
        windowDurationMins: 10080,
        resetsAt: 1800000000,
      },
    },
  });
  assert.deepEqual(await page.evaluate(() => window.__codexProtocolEvents), []);
  for (const scenario of [
    "terminal-error",
    "retry-terminal-error",
    "retry-success",
    "compaction-retry",
    "transport-closed",
  ]) {
    const reply = await page.evaluate(
      ({ project, scenario }) =>
        window.catalex.invoke("execute_codex_code", {
          projectPath: project,
          sourceProjectPath: project,
          runtimeSessionKey: scenario,
          tabId: scenario,
          prompt: "Protocol fixture, no model request",
          model: scenario,
          reasoningEffort: "low",
          fastMode: scenario === "compaction-retry",
          compileContext: null,
        }),
      { project, scenario },
    );
    assert.ok(!("error" in reply), JSON.stringify(reply));
    await expect
      .poll(
        () =>
          page.evaluate(
            (scenario) =>
              window.__codexProtocolEvents.filter(
                ({ event, payload }) =>
                  event === "codex-complete" && payload.tab_id === scenario,
              ),
            scenario,
          ),
        { timeout: 8000 },
      )
      .toHaveLength(1);
    const events = await page.evaluate(
      (scenario) =>
        window.__codexProtocolEvents.filter(
          ({ payload }) => payload.tab_id === scenario,
        ),
      scenario,
    );
    const completion = events.find(({ event }) => event === "codex-complete");
    assert.equal(
      completion.payload.success,
      ["retry-success", "compaction-retry"].includes(scenario),
    );
    const statuses = events
      .filter(({ event }) => event === "codex-output")
      .map(({ payload }) => JSON.parse(payload.data))
      .filter(({ type }) => type === "provider_status")
      .map(({ status }) => status);
    if (scenario === "compaction-retry") {
      const usage = events
        .filter(({ event }) => event === "codex-output")
        .map(({ payload }) => JSON.parse(payload.data))
        .find(({ method }) => method === "thread/tokenUsage/updated");
      assert.equal(usage.params.tokenUsage.last.totalTokens, 54000);
      assert.equal(usage.params.tokenUsage.modelContextWindow, 258400);
      assert.deepEqual(statuses, ["compacting", "retrying", null]);
    } else if (
      scenario === "retry-success" ||
      scenario === "retry-terminal-error"
    )
      assert.deepEqual(statuses, ["retrying", null]);
    else if (scenario === "transport-closed")
      assert.deepEqual(statuses, ["compacting", null]);
    else assert.deepEqual(statuses, []);
    assert.equal(
      events.filter(({ event }) => event === "codex-error").length,
      0,
    );
    const errors = events
      .filter(
        ({ event, payload }) =>
          event === "codex-output" && JSON.parse(payload.data).type === "error",
      )
      .map(({ payload }) => JSON.parse(payload.data).message);
    if (scenario === "terminal-error" || scenario === "retry-terminal-error") {
      assert.match(errors.join("\n"), /Fixture provider connection failed/);
      assert.match(errors.join("\n"), /Fixture retry budget exhausted/);
    } else if (scenario === "transport-closed") {
      assert.match(errors.join("\n"), /connection closed/i);
    } else assert.equal(errors.length, 0);
    if (scenario === "retry-success") {
      const thread = events
        .filter(({ event }) => event === "codex-output")
        .map(({ payload }) => JSON.parse(payload.data))
        .find((message) => message.type === "thread.started");
      await page.evaluate(() => {
        window.__codexProtocolEvents = [];
      });
      const compact = await page.evaluate(
        ({ project, scenario, sessionId }) =>
          window.catalex.invoke("compact_codex_session", {
            projectPath: project,
            sourceProjectPath: project,
            runtimeSessionKey: scenario,
            sessionId,
            tabId: scenario,
            model: scenario,
            reasoningEffort: "low",
          }),
        { project, scenario, sessionId: thread.thread_id },
      );
      assert.ok(!("error" in compact), JSON.stringify(compact));
      await expect
        .poll(async () =>
          page.evaluate(() =>
            window.__codexProtocolEvents.some(
              ({ event }) => event === "codex-complete",
            ),
          ),
        )
        .toBe(true);
      const completion = await page.evaluate(() =>
        window.__codexProtocolEvents.find(
          ({ event }) => event === "codex-complete",
        ),
      );
      assert.equal(completion.payload.success, true);
      console.log("Real Electron/native Codex explicit compaction passed");
    }
    await page.evaluate(
      (tabId) => window.catalex.invoke("dispose_codex_session", { tabId }),
      scenario,
    );
    console.log(`Real Electron/native Codex protocol: ${scenario} passed`);
  }
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
