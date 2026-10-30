import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { createServer } from "vite";

// Exercises real renderer -> Electron -> service cleanup with idle provider handles.
// No model inference or user project/profile is used.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-paused-archive-"),
);
const project = path.join(profile, "project");
await fs.mkdir(project);
await fs.writeFile(path.join(project, "notes.md"), "Original source\n");
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0 },
});
let app;
let page;
async function launch() {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.evaluate(async (project) => {
    (
      await import("/src/renderer/stores/onboarding-store.ts")
    ).useOnboardingStore
      .getState()
      .finish();
    await (
      await import("/src/renderer/stores/document-store.ts")
    ).useDocumentStore
      .getState()
      .openProject(project);
  }, project);
}
try {
  await vite.listen();
  await launch();
  const result = await page.evaluate(async (project) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const { useAgentChatStore: chat } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useAgentReviewQueueStore: queue } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    const { usePausedReviewStore: paused } = await import(
      "/src/renderer/stores/paused-review-store.ts"
    );
    const { useDocumentStore: doc } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { saveProjectChats } = await import(
      "/src/renderer/lib/project-chat-lifecycle.ts"
    );
    const { flushWorkspaceState } = await import(
      "/src/renderer/lib/workspace-state-storage.ts"
    );
    const id = chat.getState().activeTabId;
    const prepare = (tabId) =>
      invoke("prepare_agent_workspace", {
        projectRoot: project,
        tabId,
        mode: "ask",
        dirtyBuffers: [],
      });
    const current = await prepare(id);
    const backup = await prepare(id);
    const next = await prepare("waiting-chat");
    await invoke("desktop:fs:writeTextFile", {
      path: `${next.candidateRoot}/notes.md`,
      contents: "Waiting draft\n",
    });
    const nextReview = await invoke("reconcile_agent_workspace", {
      projectRoot: project,
      sessionId: next.sessionId,
      outcome: "success",
    });
    const messages = [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Shorten paper" }] },
      },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Partial answer" }] },
        roundDurationMs: 4000,
        roundCompletedAt: Date.now(),
      },
    ];
    chat.setState((s) => {
      const base = s.tabs.find((tab) => tab.id === id);
      return {
        isStreaming: false,
        messages,
        tabs: [
          {
            ...base,
            messages,
            title: "Interrupted draft",
            isStreaming: false,
            isSettling: false,
            turnPhase: null,
            pauseState: "paused",
            agentWorkspace: current,
            roundTiming: {
              startIndex: 0,
              elapsedMs: 4000,
              runningSince: null,
              waitingFor: [],
              finished: true,
            },
          },
          {
            ...base,
            id: "waiting-chat",
            runtimeSessionKey: "waiting-runtime",
            title: "Waiting draft",
            messages: [],
            agentWorkspace: nextReview.session,
          },
        ],
      };
    });
    paused.setState({ backups: { [id]: [backup] } });
    queue.setState({
      entries: [
        { session: current, phase: "review", conflicts: [] },
        { session: nextReview.session, phase: "queued", conflicts: [] },
      ],
    });
    await chat.getState().archiveTab(id);
    if (chat.getState().tabs.find((tab) => tab.id === id).archived)
      throw new Error("Acceptance must block archive");
    queue.setState((s) => ({
      entries: s.entries.map((entry, index) =>
        index ? entry : { ...entry, phase: "revising" },
      ),
    }));
    await doc
      .getState()
      .activateAgentWorkspace(current.sessionId, current.candidateRoot);
    await chat.getState().archiveTab(id);
    await saveProjectChats();
    await flushWorkspaceState();
    const tab = chat.getState().tabs.find((tab) => tab.id === id);
    return {
      id,
      sharedSessionId: tab.sharedSessionId,
      archived: tab.archived,
      workspace: tab.agentWorkspace,
      pause: tab.pauseState,
      backups: paused.getState().backups[id],
      queue: queue.getState().entries.map((entry) => ({
        id: entry.session.tabId,
        phase: entry.phase,
      })),
      deletedPaths: [current.candidateRoot, backup.candidateRoot],
      nextPath: next.candidateRoot,
    };
  }, project);
  assert.equal(result.archived, true);
  assert.equal(result.workspace, null);
  assert.equal(result.pause, null);
  assert.deepEqual(result.backups, []);
  assert.deepEqual(result.queue, [{ id: "waiting-chat", phase: "review" }]);
  for (const candidate of result.deletedPaths)
    await assert.rejects(fs.access(candidate));
  await fs.access(result.nextPath);
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    "Original source\n",
  );
  await app.close();
  app = null;
  await launch();
  const restored = await page.evaluate(
    async ({ project, sharedSessionId, id }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const { useAgentChatStore: chat } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      const { useAgentReviewQueueStore: queue } = await import(
        "/src/renderer/stores/agent-review-queue-store.ts"
      );
      const tab = chat.getState().tabs.find((item) => item.id === id);
      const saved = await invoke("load_shared_session", {
        projectPath: project,
        sharedSessionId,
      });
      return {
        archived: saved.archived,
        messages: saved.messages,
        workspace: tab?.agentWorkspace ?? null,
        pause: tab?.pauseState ?? null,
        staleReview: queue
          .getState()
          .entries.some((entry) => entry.session.tabId === id),
      };
    },
    { project, ...result },
  );
  assert.equal(restored.archived, true);
  assert.equal(restored.workspace, null);
  assert.equal(restored.pause, null);
  assert.equal(restored.staleReview, false);
  assert(restored.messages.some((message) => message.roundDurationMs === 4000));
  console.log(
    "Electron paused archive passed: acceptance guard, draft/backup deletion, next review advancement, source/history/timing preservation, and restart recovery. Provider disposal used idle handles.",
  );
} finally {
  if (app) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
