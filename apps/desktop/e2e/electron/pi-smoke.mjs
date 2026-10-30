import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// Real Electron, native adapter, renderer, and workspace tools. The Pi peer is
// deterministic: no account, paid inference, or existing user project is touched.
// Requires the normal desktop build plus an installed LaTeX compiler.
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "catalex-pi-smoke-"));
const project = path.join(profile, "project");
const bin = path.join(profile, "bin");
const log = path.join(profile, "fixture.jsonl");
const scope = path.join(profile, "model-scope");
const compactionMode = path.join(profile, "compaction-mode");
const executable = path.join(bin, "pi");
const customInstallation = path.join(profile, "custom pi installation");
const customExecutable = path.join(customInstallation, "bin/pi");
const defaultConfigDirectory = path.join(profile, "default agent");
const customConfigDirectory = path.join(profile, "custom agent");
let selectedConfig;
const tabId = "pi-smoke";
const runtimeSessionKey = "pi-smoke-runtime";
const model = JSON.stringify(["fixture", "fixture-model"]);
const source =
  "\\documentclass{article}\n\\begin{document}\nPi smoke fixture\n\\end{document}\n";
await fs.mkdir(project);
await fs.mkdir(bin);
await fs.writeFile(scope, "scoped");
await fs.writeFile(path.join(project, "main.tex"), source);
await fs.writeFile(
  path.join(project, "AGENTS.md"),
  "Draft instruction fixture.",
);
await fs.copyFile(
  fileURLToPath(new URL("fixtures/pi-protocol.mjs", import.meta.url)),
  executable,
);
await fs.chmod(executable, 0o755);
await fs.mkdir(path.dirname(customExecutable), { recursive: true });
await fs.copyFile(executable, customExecutable);
await fs.chmod(customExecutable, 0o755);
await fs.mkdir(defaultConfigDirectory);
await fs.mkdir(path.join(customConfigDirectory, "package/nested"), {
  recursive: true,
});
await fs.writeFile(
  path.join(customConfigDirectory, "package/nested/SKILL.md"),
  "# Selected configuration skill",
);
let app;
let page;
let vite;
let env;
let workspace;
let sessionId;
let sharedSessionId;

async function versionProbeCount() {
  return (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((record) => record.event === "version-check").length;
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function invoke(command, args) {
  if (
    selectedConfig &&
    [
      "check_pi_status",
      "list_pi_models",
      "slash_commands_list",
      "execute_pi_code",
      "resume_pi_code",
      "compact_pi_session",
    ].includes(command)
  ) {
    args = { piConfig: selectedConfig, ...args };
  }
  return bounded(
    page.evaluate(
      async ({ command, args }) => {
        const response = await window.catalex.invoke(command, args);
        if ("error" in response)
          throw new Error(JSON.stringify(response.error));
        return response.result;
      },
      { command, args },
    ),
    command,
  );
}
async function launch() {
  console.log("Pi smoke: launch Electron");
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  page = await app.firstWindow();
  page.on("pageerror", (error) =>
    console.error("Pi smoke renderer:", error.message),
  );
  page.setDefaultTimeout(30000);
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  console.log("Pi smoke: open fixture project");
  await page.evaluate(async (project) => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({ autoCompileByProject: { [project]: false } });
    if (useDocumentStore.getState().projectRoot !== project)
      await useDocumentStore.getState().openProject(project);
    window.__piEvents = [];
    for (const event of ["pi-output", "pi-activity", "pi-error", "pi-complete"])
      window.catalex.listen(event, (payload) =>
        window.__piEvents.push({ event, payload }),
      );
    window.catalex.listen("catalex-question", async (question) => {
      if (question.tabId !== "pi-smoke") return;
      const reply = await window.catalex.invoke("answer_agent_question", {
        requestId: question.requestId,
        tabId: question.tabId,
        sessionId: question.sessionId,
        answer: "Continue",
      });
      if ("error" in reply) window.__piQuestionError = reply.error;
    });
  }, project);
  console.log("Pi smoke: renderer ready");
}
async function prepareRendererTurn() {
  await bounded(
    page.evaluate(
      async ({
        tabId,
        runtimeSessionKey,
        model,
        sessionId,
        sharedSessionId,
      }) => {
        const { useAgentChatStore: store } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        const previous =
          store.getState().tabs.find((tab) => tab.id === tabId) ??
          store.getState().tabs[0];
        const tab = {
          ...previous,
          id: tabId,
          runtimeSessionKey,
          title: "Pi fixture",
          provider: "pi",
          sessionId: sessionId ?? null,
          sharedSessionId: sharedSessionId ?? null,
          providerSessionIds: sessionId ? { pi: sessionId } : {},
          providerSyncCursors: {},
          history: undefined,
          agentWorkspace: null,
          isStreaming: true,
          isSettling: false,
          error: null,
          cancelledByUser: false,
          pauseState: null,
          pausedRequest: null,
          pendingQuestion: null,
          compacting: false,
        };
        store.setState({
          tabs: [tab],
          activeTabId: tabId,
          selectedProvider: "pi",
          selectedPiModel: model,
          messages: tab.messages,
          sessionId: tab.sessionId,
          isStreaming: true,
          error: null,
        });
        window.__piEvents = [];
      },
      { tabId, runtimeSessionKey, model, sessionId, sharedSessionId },
    ),
    "Prepare Pi renderer turn",
  );
}
function turnArgs(prompt) {
  return {
    projectPath: workspace.candidateRoot,
    sourceProjectPath: project,
    runtimeSessionKey,
    tabId,
    prompt,
    model,
    reasoningEffort: "medium",
    compileContext: {
      rootId: "main",
      targetPath: "main.tex",
      backend: "latexmk",
      engine: "pdflatex",
      autoEngine: false,
    },
    ...(sessionId ? { sessionId } : {}),
  };
}
async function completed(success) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__piEvents.filter(({ event }) => event === "pi-complete"),
        ),
      { timeout: 90000 },
    )
    .toHaveLength(1);
  const events = await page.evaluate(() => window.__piEvents);
  assert.equal(
    events.find(({ event }) => event === "pi-complete").payload.success,
    success,
    JSON.stringify(events.filter(({ event }) => event === "pi-error")),
  );
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { useAgentChatStore } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        const tab = useAgentChatStore
          .getState()
          .tabs.find((tab) => tab.id === "pi-smoke");
        return tab && !tab.isStreaming && !tab.isSettling;
      }),
    )
    .toBe(true);
  return events;
}
async function turn(prompt, success = true) {
  console.log(`Pi smoke: ${prompt}`);
  await prepareRendererTurn();
  console.log("Pi smoke: turn renderer prepared");
  await invoke(
    sessionId ? "resume_pi_code" : "execute_pi_code",
    turnArgs(prompt),
  );
  console.log("Pi smoke: turn admitted");
  return completed(success);
}

async function compact(mode, followUp = "") {
  await fs.writeFile(compactionMode, mode);
  return page.evaluate(
    async ({ model, followUp }) => {
      const { usePiSetupStore } = await import(
        "/src/renderer/stores/pi-setup-store.ts"
      );
      const { useAgentChatStore: store } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      usePiSetupStore.setState({
        models: [
          {
            provider: "fixture",
            id: "fixture-model",
            name: "Pi fixture",
            reasoning: true,
          },
        ],
        modelsStatus: "ready",
      });
      store.setState((state) => ({
        selectedPiModel: model,
        selectedPiReasoningEffort: "medium",
        tabs: state.tabs.map((tab) => ({
          ...tab,
          queuedPrompts: [],
          promptQueuePaused: false,
          error: null,
        })),
      }));
      const before = store.getState().tabs[0];
      window.__piEvents = [];
      await store
        .getState()
        .sendPrompt(`/compact${followUp ? ` ${followUp}` : ""}`);
      const current = store.getState().tabs[0];
      if (
        current.error &&
        !window.__piEvents.some(({ event }) => event === "pi-complete")
      )
        throw new Error(current.error);
      return {
        messages: before.messages,
        cursors: before.providerSyncCursors,
        sessionId: before.sessionId,
      };
    },
    { model, followUp },
  );
}

try {
  vite = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  });
  await vite.listen();
  env = {
    ...process.env,
    PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(
      path.delimiter,
    ),
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
    CATALEX_SERVICE_PATH:
      process.env.CATALEX_SERVICE_PATH ??
      path.join(root, "backend/target/debug/catalex-desktop"),
    PI_CODING_AGENT_DIR: defaultConfigDirectory,
    CATALEX_PI_FIXTURE_LOG: log,
    CATALEX_PI_FIXTURE_SCOPE: scope,
    CATALEX_PI_FIXTURE_COMPACTION: compactionMode,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  await launch();
  const [status] = await Promise.all([
    invoke("check_pi_status"),
    (async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await invoke("list_agent_questions");
      }
    })(),
  ]);
  assert.equal(status.binary_path, executable);
  assert.equal(status.error, null);
  assert.equal(status.config_directory, defaultConfigDirectory);
  console.log("Pi smoke: selected executable and configuration");
  selectedConfig = {
    binaryPath: customExecutable,
    configDirectory: customConfigDirectory,
  };
  const selectedStatus = await invoke("check_pi_status");
  assert.equal(selectedStatus.binary_path, customExecutable);
  assert.equal(selectedStatus.config_directory, customConfigDirectory);
  assert.equal(selectedStatus.version, "1.2.0");
  const missingStatus = await invoke("check_pi_status", {
    piConfig: {
      ...selectedConfig,
      binaryPath: path.join(profile, "missing pi"),
    },
  });
  assert.match(missingStatus.error, /executable not found/);
  const badConfigStatus = await invoke("check_pi_status", {
    piConfig: { ...selectedConfig, configDirectory: customExecutable },
  });
  assert.match(badConfigStatus.error, /config folder not found/);
  const automaticStatus = await invoke("check_pi_status", { piConfig: {} });
  assert.equal(automaticStatus.binary_path, executable);
  assert.equal(automaticStatus.config_directory, defaultConfigDirectory);
  const skills = await invoke("slash_commands_list", {
    projectPath: project,
    provider: "pi",
  });
  assert.equal(skills.length, 2);
  assert.equal(skills[0].full_command, "/configured-skill");
  assert.equal(skills[0].content, "# Selected configuration skill");
  assert.equal(
    skills[1].file_path,
    "catalex://built-in-skills/review-document/SKILL.md",
  );
  const models = await invoke("list_pi_models");
  assert.deepEqual(models[0].thinkingLevelMap, { low: null });
  assert.equal(models[0].isDefault, false);
  assert.deepEqual(models[1].thinkingLevelMap, {
    off: null,
    minimal: null,
    xhigh: "xhigh",
    max: "max",
  });
  assert.equal(models[1].isDefault, true);
  assert.deepEqual(
    models.map(({ provider, id }) => [provider, id]),
    [
      ["fixture-other", "fixture-model"],
      ["fixture", "fixture-model"],
    ],
  );
  await fs.writeFile(scope, "all");
  assert.equal((await invoke("list_pi_models")).length, 3);
  await fs.writeFile(scope, "unsupported");
  await assert.rejects(
    invoke("list_pi_models"),
    /does not expose scoped models/,
  );
  await fs.writeFile(scope, "scoped");
  assert.deepEqual(await page.evaluate(() => window.__piEvents), []);
  // Enabling Pi verifies its setup once. Turns and compaction must not probe it.
  await page.evaluate(async (selectedConfig) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      enabledProviders: { claude: true, codex: true, pi: true },
      piBinaryPath: selectedConfig.binaryPath,
      piConfigDirectory: selectedConfig.configDirectory,
    });
  }, selectedConfig);
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (
            await import("/src/renderer/stores/pi-setup-store.ts")
          ).usePiSetupStore.getState().status,
      ),
    )
    .toBe("ready");
  const setupProbes = await versionProbeCount();
  assert.ok(setupProbes > 0);
  workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId,
    sharedSessionId: null,
    mode: "ask",
    dirtyBuffers: [],
  });
  // A fresh session must already have the same identity as a resumed alias.
  await prepareRendererTurn();
  await invoke("execute_pi_code", turnArgs("fixture:hold"));
  await expect
    .poll(async () =>
      (await fs.readFile(log, "utf8")).includes('"event":"holding"'),
    )
    .toBe(true);
  const initialEvents = await page.evaluate(() => window.__piEvents);
  const initialPath = initialEvents
    .filter(({ event }) => event === "pi-output")
    .map(({ payload }) => JSON.parse(payload.data))
    .find((message) => message.type === "session").session_id;
  assert.equal(initialPath, await fs.realpath(initialPath));
  const alias = path.join(profile, "session-alias");
  await fs.symlink(path.dirname(initialPath), alias);
  await assert.rejects(
    invoke("resume_pi_code", {
      ...turnArgs("fixture:hold"),
      tabId: "other-tab",
      sessionId: path.join(alias, path.basename(initialPath)),
    }),
    /already running/,
  );
  await invoke("cancel_pi_execution", { tabId });
  await completed(false);
  const first = await turn("fixture:tools");
  const nativeEvents = first
    .filter(({ event }) => event === "pi-output")
    .map(({ payload }) => JSON.parse(payload.data));
  for (const type of [
    "extension_error",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
  ]) {
    assert.ok(
      nativeEvents.some((event) => event.type === type),
      `Missing native Pi event: ${type}`,
    );
  }
  const diagnostics = await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.getState().requestDrawerOpen();
    return useAgentChatStore.getState().tabs[0].messages;
  });
  assert.ok(
    diagnostics.some(
      (message) =>
        message.subtype === "error" &&
        message.result?.includes("Nonfatal fixture hook error"),
    ),
  );
  await page
    .getByText(
      "Pi extension error (session_start): Nonfatal fixture hook error",
      { exact: false },
    )
    .first()
    .waitFor();
  await page
    .getByText(
      "Pi extension error (session_start): Nonfatal fixture hook error",
      { exact: false },
    )
    .first()
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(500); // Let the drawer's opening transition finish.
  await page
    .getByText(
      "Pi extension error (session_start): Nonfatal fixture hook error",
      { exact: false },
    )
    .first()
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "/tmp/catalex-pi-diagnostics.png",
    animations: "disabled",
  });
  const launches = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((item) => item.event === "launched");
  assert.equal(launches.at(-1).executable, customExecutable);
  assert.equal(launches.at(-1).configDirectory, customConfigDirectory);
  assert.ok(
    launches.filter((item) => item.executable === customExecutable).length >= 5,
  );

  sessionId = first
    .filter(({ event }) => event === "pi-output")
    .map(({ payload }) => JSON.parse(payload.data))
    .find((message) => message.type === "session").session_id;
  assert.equal(
    await fs.readFile(path.join(project, "main.tex"), "utf8"),
    source,
  );
  const state = await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    return useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === "pi-smoke");
  });
  sharedSessionId = state.sharedSessionId;
  assert.ok(sharedSessionId);
  assert.equal(state.providerSessionIds.pi, sessionId);
  assert.deepEqual(state.contextUsage.pi, {
    tokens: 35,
    capacity: 1000,
    model: undefined,
  });
  assert.ok(
    state.messages.some((message) =>
      message.message?.content?.some(
        (block) => block.type === "tool_use" && block.name === "render_page",
      ),
    ),
  );
  assert.equal(await page.evaluate(() => window.__piQuestionError), undefined);
  console.log("Pi smoke: accept draft and continue the same conversation");
  const acceptedDraft = workspace.candidateRoot;
  await fs.writeFile(
    path.join(acceptedDraft, "accepted.txt"),
    "accepted draft",
  );
  const review = await invoke("reconcile_agent_workspace", {
    projectRoot: project,
    sessionId: workspace.sessionId,
    outcome: "success",
  });
  assert.ok(review.changes.length > 0);
  const applied = await invoke("apply_agent_workspace", {
    projectRoot: project,
    sessionId: workspace.sessionId,
    decisions: review.changes.map((change) => ({
      changeId: change.id,
      accept: true,
    })),
    expectedSourceRevision: null,
    expectedProjectRevision: null,
  });
  assert.equal(applied.applied, true, JSON.stringify(applied));
  assert.equal(
    await fs.readFile(path.join(project, "accepted.txt"), "utf8"),
    "accepted draft",
  );
  workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId,
    sharedSessionId,
    mode: "ask",
    dirtyBuffers: [],
  });
  assert.notEqual(workspace.candidateRoot, acceptedDraft);
  await turn("fixture:resume");
  assert.equal(await versionProbeCount(), setupProbes);

  console.log("Pi smoke: native compaction and preserved session");
  const beforeCompact = await compact("success");
  await completed(true);
  const afterCompact = await page.evaluate(
    async () =>
      (
        await import("/src/renderer/stores/agent-chat-store.ts")
      ).useAgentChatStore.getState().tabs[0],
  );
  assert.deepEqual(
    afterCompact.messages.slice(0, beforeCompact.messages.length),
    beforeCompact.messages,
  );
  assert.equal(afterCompact.messages.length, beforeCompact.messages.length + 1);
  assert.match(
    afterCompact.messages.at(-1).result,
    /Nonfatal fixture hook error/,
  );
  assert.deepEqual(afterCompact.providerSyncCursors, beforeCompact.cursors);
  assert.equal(afterCompact.sessionId, beforeCompact.sessionId);
  assert.equal(
    await fs.realpath(afterCompact.providerSessionIds.pi),
    await fs.realpath(sessionId),
  );
  assert.equal(afterCompact.contextUsage.pi.tokens, 12);
  assert.equal(afterCompact.compacting, false);
  assert.equal(afterCompact.error, null);
  await turn("fixture:after-compact");

  await compact("fail", "Keep working");
  await completed(false);
  const failedCompact = await page.evaluate(
    async () =>
      (
        await import("/src/renderer/stores/agent-chat-store.ts")
      ).useAgentChatStore.getState().tabs[0],
  );
  assert.match(failedCompact.error, /Fixture compaction failed/);
  assert.equal(failedCompact.promptQueuePaused, true);
  assert.equal(failedCompact.queuedPrompts[0].prompt, "Keep working");

  await compact("hold", "Continue later");
  await expect
    .poll(async () =>
      (await fs.readFile(log, "utf8")).includes('"mode":"hold"'),
    )
    .toBe(true);
  await assert.rejects(
    invoke("compact_pi_session", { ...turnArgs(""), tabId: "other-tab" }),
    /already running/,
  );
  await page.evaluate(async () =>
    (await import("/src/renderer/stores/agent-chat-store.ts")).useAgentChatStore
      .getState()
      .cancelExecution(),
  );
  await completed(false);
  const cancelledCompact = await page.evaluate(
    async () =>
      (
        await import("/src/renderer/stores/agent-chat-store.ts")
      ).useAgentChatStore.getState().tabs[0],
  );
  assert.equal(cancelledCompact.compacting, false);
  assert.equal(cancelledCompact.promptQueuePaused, true);
  assert.equal(cancelledCompact.queuedPrompts[0].prompt, "Continue later");
  assert.match(await fs.readFile(log, "utf8"), /"event":"aborted"/);
  await compact("success");
  await completed(true);

  await prepareRendererTurn();
  await invoke("resume_pi_code", turnArgs("fixture:hold"));
  await expect
    .poll(
      async () =>
        (await fs.readFile(log, "utf8")).split('"event":"holding"').length - 1,
    )
    .toBe(2);
  await assert.rejects(
    invoke("execute_pi_code", turnArgs("fixture:resume")),
    /already running/,
  );
  await assert.rejects(
    invoke("resume_pi_code", {
      ...turnArgs("fixture:resume"),
      tabId: "other-tab",
    }),
    /already running/,
  );
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    await useAgentChatStore.getState().cancelExecution();
  });
  await completed(false);
  const records = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    records.some((record) => record.event === "cancelled" && record.revoked),
  );
  await turn("fixture:fail", false);
  assert.match(
    await page.evaluate(
      async () =>
        (
          await import("/src/renderer/stores/agent-chat-store.ts")
        ).useAgentChatStore.getState().tabs[0].error,
    ),
    /Fixture provider failed/,
  );

  assert.equal(await versionProbeCount(), setupProbes);
  const refreshedStatus = await invoke("check_pi_status");
  assert.equal(refreshedStatus.version, "1.2.0");
  assert.equal(await versionProbeCount(), setupProbes + 1);

  console.log("Pi smoke: close before restart");
  await app.close();
  console.log("Pi smoke: closed");
  app = undefined;
  await launch();
  const restored = await invoke("load_shared_session", {
    projectPath: project,
    sharedSessionId,
  });
  assert.equal(restored.last_provider, "pi");
  assert.equal(
    await fs.realpath(restored.provider_session_ids.pi),
    await fs.realpath(sessionId),
  );
  assert.equal(restored.last_pi_model, model);
  // Startup retires the previous draft once it is no longer attached to a chat.
  // Normal prompts create a new draft while retaining the provider session.
  const previousDraft = workspace.candidateRoot;
  workspace = await invoke("prepare_agent_workspace", {
    projectRoot: project,
    tabId,
    sharedSessionId,
    mode: "ask",
    dirtyBuffers: [],
  });
  assert.notEqual(workspace.candidateRoot, previousDraft);
  await turn("fixture:restart");
  const sessions = (await fs.readFile(sessionId, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    sessions
      .filter(({ type }) => type === "fixture-turn")
      .map(({ turn }) => turn),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(sessions.filter(({ type }) => type === "compaction").length, 2);
  assert.equal(
    await fs.realpath(sessions[0].cwd),
    await fs.realpath(workspace.candidateRoot),
  );
  assert.equal(
    await fs.readFile(path.join(workspace.candidateRoot, "AGENTS.md"), "utf8"),
    "Draft instruction fixture.",
  );
  const outside = path.join(project, "outside.jsonl");
  await fs.writeFile(outside, "{}\n");
  await assert.rejects(
    invoke("resume_pi_code", {
      ...turnArgs("fixture:resume"),
      sessionId: outside,
    }),
    /outside Catalex session storage/,
  );
  await invoke("discard_agent_workspace", {
    projectRoot: project,
    sessionId: workspace.sessionId,
  });
  console.log(
    "Electron Pi smoke passed: discovery, streaming, compile/render, comments, questions, compaction, resume, cancellation, errors, shared session and full restart. Deterministic Pi peer; no model inference.",
  );
} finally {
  if (app) await app.close();
  if (vite) await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
