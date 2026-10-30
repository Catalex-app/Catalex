import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";

// Requires a running normal Vite app and a freshly compiled native debug helper.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-refinement-ipc-"),
);
const projectRoot = path.join(profile, "Review refinement project");
await fs.mkdir(projectRoot);
await fs.writeFile(path.join(projectRoot, "notes.md"), "Original source\n");
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: process.env.CATALEX_DEV_URL ?? "http://127.0.0.1:4173",
  CATALEX_SERVICE_PATH:
    process.env.CATALEX_SERVICE_PATH ??
    path.join(desktopRoot, "backend/target/debug/catalex-desktop"),
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: [desktopRoot], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(
    () =>
      !!window.catalex && document.querySelector("#root")?.children.length > 0,
  );
  const result = await page.evaluate(async (root) => {
    const invoke = async (command, args) => {
      const reply = await window.catalex.invoke(command, args);
      if ("error" in reply) throw new Error(JSON.stringify(reply.error));
      return reply.result;
    };
    const session = await invoke("prepare_agent_workspace", {
      projectRoot: root,
      tabId: "refinement-ipc",
      sharedSessionId: "refinement-ipc-conversation",
      mode: "ask",
      dirtyBuffers: [],
    });
    const revisions = [];
    const rounds = [];
    for (let round = 1; round <= 2; round++) {
      await invoke("desktop:fs:writeTextFile", {
        path: `${session.candidateRoot}/notes.md`,
        contents: `Refinement round ${round}\n`,
      });
      const review = await invoke("reconcile_agent_workspace", {
        projectRoot: root,
        sessionId: session.sessionId,
        outcome: "success",
      });
      revisions.push(review.changes[0].proposalRevision);
      const resumed = await invoke("resume_agent_workspace", {
        projectRoot: root,
        sessionId: session.sessionId,
        tabId: "refinement-ipc",
      });
      rounds.push({
        sessionId: resumed.sessionId,
        candidateRoot: resumed.candidateRoot,
        status: resumed.status,
        source: await invoke("desktop:fs:readTextFile", {
          path: `${root}/notes.md`,
        }),
        candidate: await invoke("desktop:fs:readTextFile", {
          path: `${session.candidateRoot}/notes.md`,
        }),
      });
    }
    await invoke("reconcile_agent_workspace", {
      projectRoot: root,
      sessionId: session.sessionId,
      outcome: "cancelled",
    });
    await invoke("discard_agent_workspace", {
      projectRoot: root,
      sessionId: session.sessionId,
    });
    return { session, revisions, rounds };
  }, projectRoot);
  assert.equal(result.rounds.length, 2);
  assert.equal(new Set(result.revisions).size, 2);
  for (const [index, round] of result.rounds.entries()) {
    assert.equal(round.sessionId, result.session.sessionId);
    assert.equal(round.candidateRoot, result.session.candidateRoot);
    assert.equal(round.status, "active");
    assert.equal(round.source, "Original source\n");
    assert.equal(round.candidate, `Refinement round ${index + 1}\n`);
  }
  assert.equal(
    await fs.readFile(path.join(projectRoot, "notes.md"), "utf8"),
    "Original source\n",
  );
  console.log(
    "Electron refinement IPC passed: two rounds in the same sandbox, distinct proposal revisions, source unchanged.",
  );
} finally {
  if (app) await app.close();
  await fs.rm(profile, { recursive: true, force: true });
}
