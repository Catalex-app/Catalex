// Opt-in, synthetic chat-search memory probe in Electron's Node runtime.
// No windows, providers, personal profiles, or project data are opened.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";

const script = fileURLToPath(import.meta.url);
const desktop = path.resolve(path.dirname(script), "../..");

if (!isMainThread) {
  const require = createRequire(import.meta.url);
  const { searchSavedChat } = require(workerData.bundle);
  let sampled = process.memoryUsage();
  const sample = () => {
    const current = process.memoryUsage();
    if (current.heapUsed > sampled.heapUsed) sampled = current;
  };
  const timer = setInterval(sample, 1);
  try {
    const result = await searchSavedChat(workerData.directory, "chat", {
      text: "absent-needle",
      regex: false,
      caseSensitive: false,
      wholeWord: false,
    });
    sample();
    parentPort.postMessage({ result, sampled, after: process.memoryUsage() });
  } finally {
    clearInterval(timer);
  }
} else if (process.argv[2] === "--sample") {
  assert.ok(
    process.versions.electron,
    "Run samples in Electron's Node runtime",
  );
  assert.equal(typeof global.gc, "function");
  const [, , , scenario, bundle, directory] = process.argv;
  global.gc();
  const samples = [{ phase: "baseline", memory: process.memoryUsage() }];
  if (scenario === "import") {
    createRequire(import.meta.url)(bundle);
  } else {
    for (let cycle = 1; cycle <= (scenario === "markdown" ? 8 : 3); cycle++) {
      const worker = new Worker(script, { workerData: { bundle, directory } });
      const exited = new Promise((resolve, reject) => {
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code) reject(new Error(`Worker exited with code ${code}`));
          else resolve();
        });
      });
      const reply = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      await exited;
      assert.equal(reply.result.total, 600);
      assert.equal(reply.result.matches.length, 0);
      assert.equal(reply.result.truncated, false);
      await delay(500);
      global.gc();
      samples.push({
        phase: `query-${cycle}`,
        ...reply,
        memory: process.memoryUsage(),
      });
    }
  }
  await delay(5000);
  global.gc();
  samples.push({ phase: "settled", memory: process.memoryUsage() });
  console.log(
    JSON.stringify({ scenario, electron: process.versions.electron, samples }),
  );
} else {
  const require = createRequire(path.join(desktop, "package.json"));
  const { build } = require("esbuild");
  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "catalex-chat-memory-"),
  );
  const output = path.resolve(
    desktop,
    "../../output/playwright/chat-search-memory",
  );
  try {
    const bundle = path.join(temporary, "checkpoints.cjs");
    await build({
      entryPoints: [path.join(desktop, "src/main/chat-checkpoints.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
    });
    const results = [];
    for (const scenario of ["import", "markdown", "tool-results"]) {
      const directory = path.join(temporary, scenario);
      await fs.mkdir(directory);
      const chunks = [];
      let jsonBytes = 0;
      if (scenario !== "import") {
        for (let start = 0; start < 600; start += 100) {
          const messages = Array.from({ length: 100 }, (_, offset) =>
            scenario === "markdown"
              ? {
                  type: "assistant",
                  message: {
                    content: [
                      {
                        type: "text",
                        text: `**distinct-${start + offset}** ${"ordinary content with no match. ".repeat(130)}`,
                      },
                    ],
                  },
                }
              : {
                  type: "user",
                  message: {
                    content: [
                      {
                        type: "tool_result",
                        content: `tool payload ${"z".repeat(65536)}`,
                      },
                    ],
                  },
                },
          );
          const file = `${start.toString(16).padStart(8, "0")}.json`;
          const json = JSON.stringify(messages);
          jsonBytes += Buffer.byteLength(json);
          await fs.writeFile(path.join(directory, file), json);
          chunks.push(file);
        }
      }
      await fs.writeFile(
        path.join(directory, "aaaa.json"),
        JSON.stringify({
          tab: { id: "chat" },
          chunks,
          total: scenario === "import" ? 0 : 600,
        }),
      );
      await fs.writeFile(
        path.join(directory, "manifest.json"),
        JSON.stringify({
          version: 1,
          tabs: [{ id: "chat", file: "aaaa.json" }],
          state: {},
        }),
      );
      const child = spawnSync(
        require("electron"),
        ["--expose-gc", script, "--sample", scenario, bundle, directory],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          timeout: 120000,
        },
      );
      assert.equal(child.status, 0, child.error?.message ?? child.stderr);
      const result = { jsonBytes, ...JSON.parse(child.stdout) };
      results.push(result);
      const baseline = result.samples[0].memory.rss;
      const settled = result.samples.at(-1).memory.rss;
      console.log(
        `${scenario}: ${jsonBytes} JSON bytes; settled RSS increase ${((settled - baseline) / 2 ** 20).toFixed(1)} MiB`,
      );
    }
    await fs.mkdir(output, { recursive: true });
    await fs.writeFile(
      path.join(output, "results.json"),
      `${JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)}\n`,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
