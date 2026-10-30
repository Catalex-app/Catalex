#!/usr/bin/env node
import path from "node:path";
import assert from "node:assert/strict";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli protocol-fixture");
  process.exit(0);
}
if (process.argv.includes("login")) {
  console.log("Logged in using fixture");
  process.exit(0);
}
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const threadId = `fixture-thread-${process.pid}`;
let skillsRoot;
let turnId;
let turns = 0;
let scenario;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) return;
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === "skills/extraRoots/set") skillsRoot = params.extraRoots[0];
  if (method === "skills/list") {
    send({
      id,
      result: {
        data: [
          {
            skills: ["catalex-verify-latex", "review-document"].map((name) => ({
              name,
              enabled: true,
              path: path.join(skillsRoot, name, "SKILL.md"),
            })),
          },
        ],
      },
    });
  } else if (method === "account/rateLimits/read") {
    send({
      id,
      result: {
        rateLimits: {
          primary: null,
          secondary: {
            usedPercent: 32,
            windowDurationMins: 10080,
            resetsAt: 1800000000,
          },
        },
      },
    });
  } else if (method === "thread/start" || method === "thread/resume") {
    send({ id, result: { thread: { id: threadId } } });
  } else if (method === "thread/compact/start") {
    assert.deepEqual(params, { threadId });
    turnId = `fixture-compact-${++turns}`;
    send({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    send({ id, result: {} });
    send({
      method: "item/started",
      params: {
        threadId,
        turnId,
        item: { id: "compact", type: "contextCompaction" },
      },
    });
    setTimeout(() => {
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: { id: "compact", type: "contextCompaction" },
        },
      });
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
    }, 250);
  } else if (method === "turn/start") {
    turnId = `fixture-turn-${++turns}`;
    scenario = params.model;
    assert.equal(
      params.serviceTierForTurn,
      scenario === "compaction-retry" ? "fast" : "default",
    );
    send({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    if (scenario === "terminal-error" || scenario === "retry-terminal-error") {
      if (scenario === "retry-terminal-error")
        send({
          method: "error",
          params: {
            threadId,
            turnId,
            willRetry: true,
            error: { message: "Fixture overloaded" },
          },
        });
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "failed",
            error: {
              message: "Fixture provider connection failed",
              additionalDetails: "Fixture retry budget exhausted",
            },
          },
        },
      });
    } else if (scenario === "retry-success") {
      send({
        method: "error",
        params: {
          threadId,
          turnId,
          willRetry: true,
          error: {
            message:
              "Fixture transient authentication failed during connection retry",
          },
        },
      });
      setTimeout(
        () =>
          send({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turnId, status: "completed", error: null },
            },
          }),
        50,
      );
    } else if (scenario === "compaction-retry") {
      const retry = {
        method: "error",
        params: {
          threadId,
          turnId,
          willRetry: true,
          error: { message: "Fixture throttled" },
        },
      };
      send({ ...retry, params: { ...retry.params, threadId: "other-thread" } });
      send({ ...retry, params: { ...retry.params, turnId: "other-turn" } });
      const compact = {
        threadId,
        turnId,
        item: { id: "compact", type: "contextCompaction" },
      };
      send({ method: "item/started", params: compact });
      send(retry);
      send(retry);
      send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId,
          tokenUsage: {
            last: { totalTokens: 54000 },
            total: { totalTokens: 990000 },
            modelContextWindow: 258400,
          },
        },
      });
      send({
        method: "item/completed",
        params: { threadId, turnId, item: { id: "tool", type: "unknownTool" } },
      });
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: {
            id: "recovered-tool",
            type: "commandExecution",
            source: "agent",
            command: "echo recovered",
            status: "inProgress",
          },
        },
      });
      send({ method: "item/completed", params: compact });
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      });
    } else if (scenario === "transport-closed") {
      send({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { id: "compact", type: "contextCompaction" },
        },
      });
      process.exit(0);
    } else {
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turnId, status: "completed", error: null },
        },
      });
    }
  } else if (method === "turn/interrupt") {
    send({ id, result: {} });
    send({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted" } },
    });
  } else send({ id, result: {} });
});
lines.on("close", () => process.exit(0));
