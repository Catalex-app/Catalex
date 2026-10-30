import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// Exercise the real renderer stores and native service, without provider calls or
// test-only product hooks. Keep one Vite origin across independent app processes.
const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-persistence-"),
);
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/persistence",
);
const project = path.join(profile, "Persistence project");
const source =
  "# Saved source\n\nThis stays unchanged while reviewing a draft.\n";
const draft = "# Pending review\n\nAn unaccepted agent change.\n";
const editedDraft =
  "# Pending review\n\nA human edit that must survive quitting.\n";
await fs.mkdir(project);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(project, "notes.md"), source);
await fs.writeFile(path.join(project, "appendix.md"), "# Appendix\n");
let vite;
let app;
const pageErrors = [];

async function launch() {
  const address = vite.httpServer.address();
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${address.port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [desktopRoot], env, timeout: 30_000 });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  // This test exercises a returning user's workspace, not first-run onboarding.
  await page.evaluate(async () => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
  const window = await app.browserWindow(page);
  await window.evaluate((window) => {
    window.unmaximize();
    window.setSize(1440, 1000);
  });
  return page;
}

async function close() {
  const closed = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await closed;
  app = undefined;
}

async function openProject(page) {
  await page.evaluate(async (projectRoot) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    const { recoverLatestAgentWorkspace } = await import(
      "/src/renderer/lib/agent-workspace.ts"
    );
    await useDocumentStore.getState().openProject(projectRoot);
    useProjectStore.getState().addRecentProject(projectRoot);
    // openProject starts recovery asynchronously; inspect only after it settles.
    await recoverLatestAgentWorkspace(projectRoot);
  }, project);
  await page.locator(".cm-content").first().waitFor();
}

async function readState(page) {
  return page.evaluate(async (projectRoot) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useProposedChangesStore } = await import(
      "/src/renderer/stores/proposed-changes-store.ts"
    );
    const { useAgentReviewQueueStore } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const settings = useSettingsStore.getState();
    const chats = useAgentChatStore.getState();
    const doc = useDocumentStore.getState();
    return {
      fontSize: settings.editorFontSize,
      modeThemes: settings.modeThemes,
      colorScheme: settings.editorColorScheme,
      defaultModel: settings.defaultClaudeModel,
      recent: useProjectStore.getState().recentProjects,
      preference: localStorage.getItem("catalex.skipFileMoveConfirmation"),
      zoom: localStorage.getItem("catalex-app-zoom"),
      tabs: chats.tabs.map((tab) => ({
        id: tab.id,
        draft: tab.draft,
        messages: tab.messages,
        sharedSessionId: tab.sharedSessionId,
      })),
      activeTabId: chats.activeTabId,
      selectedModel: chats.selectedClaudeModel,
      proposals:
        useProposedChangesStore.getState().changesByProject[projectRoot] ?? [],
      reviews: useAgentReviewQueueStore.getState().entries,
      activeFile: doc.activeFileId,
      document: doc.files.find((file) => file.relativePath === "notes.md")
        ?.content,
    };
  }, project);
}

async function verifyWindowSync(page) {
  const anotherProject = path.join(profile, "Another project");
  await fs.mkdir(anotherProject);
  const opened = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await opened;
  second.on("pageerror", (error) => pageErrors.push(error.message));
  await second.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect(page.locator("[data-project-sidebar]")).toHaveCSS(
    "width",
    "240px",
  );
  const sidebarHandle = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await sidebarHandle.focus();
  for (let step = 0; step < 9; step++) await sidebarHandle.press("ArrowRight");
  await expect(page.locator("[data-project-sidebar]")).toHaveCSS(
    "width",
    "330px",
  );
  await expect
    .poll(() =>
      second.evaluate(async (root) => {
        const { useProjectStore } = await import(
          "/src/renderer/stores/project-store.ts"
        );
        return useProjectStore.getState().sidebarWidthsByProject[root];
      }, project),
    )
    .toBe(330);

  await second.evaluate(async (projectRoot) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore.getState().addRecentProject(projectRoot);
  }, anotherProject);
  await expect
    .poll(async () => (await readState(page)).recent.map((item) => item.path))
    .toContain(anotherProject);
  await page.evaluate(async (projectRoot) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore
      .getState()
      .setRecentProjectLastActiveFile(projectRoot, "notes.md");
  }, project);
  await expect
    .poll(
      async () =>
        (await readState(second)).recent.find((item) => item.path === project)
          ?.lastActiveFile,
    )
    .toBe("notes.md");
  assert.deepEqual(
    new Set((await readState(second)).recent.map((item) => item.path)),
    new Set([project, anotherProject]),
  );
  await second.evaluate(async (projectRoot) => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore.getState().removeRecentProject(projectRoot);
  }, anotherProject);
  await expect
    .poll(async () => (await readState(page)).recent.map((item) => item.path))
    .toEqual([project]);
  // Two live renderer adapters save independent records at the same time.
  const addRecord = async (window, root) =>
    window.evaluate(async (root) => {
      const { useProposedChangesStore } = await import(
        "/src/renderer/stores/proposed-changes-store.ts"
      );
      const { flushWorkspaceState } = await import(
        "/src/renderer/lib/workspace-state-storage.ts"
      );
      useProposedChangesStore.setState((state) => ({
        changesByProject: { ...state.changesByProject, [root]: [] },
      }));
      await flushWorkspaceState();
    }, root);
  await Promise.all([
    addRecord(page, project),
    addRecord(second, anotherProject),
  ]);
  for (const window of [page, second]) {
    await expect
      .poll(() =>
        window.evaluate(async () => {
          const { useProposedChangesStore } = await import(
            "/src/renderer/stores/proposed-changes-store.ts"
          );
          return Object.keys(
            useProposedChangesStore.getState().changesByProject,
          ).sort();
        }),
      )
      .toEqual([project, anotherProject].sort());
  }
  await page.evaluate(async () => {
    const { useProposedChangesStore } = await import(
      "/src/renderer/stores/proposed-changes-store.ts"
    );
    const { flushWorkspaceState } = await import(
      "/src/renderer/lib/workspace-state-storage.ts"
    );
    useProposedChangesStore.setState({ changesByProject: {} });
    await flushWorkspaceState();
  });
  const closed = second.waitForEvent("close");
  await second.evaluate(() => window.catalex.invoke("desktop:window:close"));
  await closed;
  console.log(
    "Separate workspace windows synchronized recent-project edits and removals.",
  );
}

try {
  vite = await createServer({
    root: desktopRoot,
    server: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  await vite.listen();
  let page = await launch();
  await openProject(page);
  await verifyWindowSync(page);
  await page
    .locator('[data-chat-composer-input="true"]:visible')
    .last()
    .fill("First unsent draft α");
  const created = await page.evaluate(
    async ({ projectRoot, candidate }) => {
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { useAgentChatStore } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      const { useHistoryStore } = await import(
        "/src/renderer/stores/history-store.ts"
      );
      const { useAgentReviewQueueStore } = await import(
        "/src/renderer/stores/agent-review-queue-store.ts"
      );
      const { prepareAgentWorkspace, reconcileAgentWorkspace } = await import(
        "/src/renderer/lib/agent-workspace.ts"
      );
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      const settings = useSettingsStore.getState();
      settings.setEditorFontSize(18);
      settings.setModeTheme("artisan", "modern");
      settings.setModeTheme("duet", "classic");
      settings.setEditorColorScheme("forest");
      settings.setDefaultClaudeModel("claude-sonnet-4-6");
      settings.addCustomModel({
        provider: "claude",
        id: "claude-opus-4-6",
        effort: "high",
      });
      localStorage.setItem("catalex.skipFileMoveConfirmation", "true");
      const { persistAppZoom } = await import("/src/renderer/lib/app-zoom.ts");
      await persistAppZoom(1.1);

      const chats = useAgentChatStore.getState();
      const firstTab = chats.activeTabId;
      chats._appendMessage(firstTab, {
        type: "user",
        uuid: "persistence-user",
        message: {
          content: [{ type: "text", text: "Remember this conversation." }],
        },
      });
      chats._appendMessage(firstTab, {
        type: "assistant",
        uuid: "persistence-assistant",
        message: {
          content: [{ type: "text", text: "Saved without a provider call." }],
        },
      });
      const secondTab = chats.createTab();
      chats.saveDraft(secondTab, {
        input: "Second unsent draft 测试",
        pinnedContexts: [
          {
            label: "notes.md",
            filePath: "notes.md",
            selectedText: "Saved source",
          },
        ],
      });
      chats.setSelectedClaudeModel("claude-opus-4-6");
      const doc = useDocumentStore.getState();
      doc.setActiveFile(
        doc.files.find((file) => file.relativePath === "notes.md").id,
      );
      await useHistoryStore.getState().init(projectRoot);
      await useHistoryStore.getState().loadSnapshots(projectRoot);
      const historyIds = useHistoryStore
        .getState()
        .snapshots.map((snapshot) => snapshot.id);

      // A real native draft keeps review recovery honest; only its contents are synthetic.
      const session = await prepareAgentWorkspace(
        projectRoot,
        secondTab,
        null,
        "ask",
        [],
      );
      await invoke("desktop:fs:writeTextFile", {
        path: `${session.candidateRoot}/notes.md`,
        contents: candidate,
      });
      const reconciled = await reconcileAgentWorkspace(
        projectRoot,
        session.sessionId,
        "success",
      );
      chats._setAgentWorkspace(secondTab, reconciled.session);
      await useAgentReviewQueueStore.getState().enqueue(reconciled.session);
      return {
        firstTab,
        secondTab,
        sessionId: session.sessionId,
        candidateRoot: session.candidateRoot,
        historyIds,
      };
    },
    { projectRoot: project, candidate: draft },
  );
  assert.ok(created.historyIds.length, "Native project history initialized");
  await page.evaluate(async () => {
    const { flushWorkspaceState } = await import(
      "/src/renderer/lib/workspace-state-storage.ts"
    );
    await flushWorkspaceState();
  });
  // Fault injection at the real filesystem boundary, confined to this test profile.
  const recoveryDirectory = path.join(profile, "workspace-state");
  if (process.platform !== "win32") await fs.chmod(recoveryDirectory, 0o500);
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+a" : "Control+a",
  );
  await page.keyboard.insertText(editedDraft);
  await expect(editor).toContainText(
    "A human edit that must survive quitting.",
  );
  await expect
    .poll(async () => (await readState(page)).document)
    .toBe(editedDraft);
  if (process.platform !== "win32") {
    const warning = page.getByText(
      "Could not save draft recovery data. Keep this window open and retry saving.",
      { exact: true },
    );
    await expect(warning).toBeVisible();
    await expect(warning).toBeInViewport();
    // Capture at native 100%: Electron's CDP screenshots crop at app zoom > 1.
    const browserWindow = await app.browserWindow(page);
    await browserWindow.evaluate((window) =>
      window.webContents.setZoomFactor(1),
    );
    const toast = warning.locator("xpath=ancestor::li[1]");
    await expect(toast).toHaveAttribute("data-mounted", "true");
    await toast.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await toast.screenshot({ path: path.join(artifacts, "save-warning.png") });
    assert.equal(
      await fs.readFile(path.join(project, "notes.md"), "utf8"),
      source,
    );
    await page.screenshot({ path: path.join(artifacts, "save-failure.png") });
    await fs.chmod(recoveryDirectory, 0o700);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(warning).toBeHidden();
    await browserWindow.evaluate((window) =>
      window.webContents.setZoomFactor(1.1),
    );
  }
  await page.screenshot({ path: path.join(artifacts, "created.png") });
  // Do not explicitly flush the stores: the actual app shutdown must do that.
  await close();
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );

  page = await launch();
  const hydrated = await readState(page);
  assert.equal(hydrated.fontSize, 18);
  assert.deepEqual(hydrated.modeThemes, {
    artisan: "modern",
    duet: "classic",
  });
  assert.equal(hydrated.colorScheme, "forest");
  assert.equal(hydrated.defaultModel, "claude-sonnet-4-6");
  assert.equal(hydrated.preference, "true");
  assert.equal(hydrated.zoom, "1.1");
  assert.equal(hydrated.recent[0]?.path, project);
  assert.equal(hydrated.reviews[0]?.session.sessionId, created.sessionId);
  assert.equal(hydrated.proposals.length, 1);
  await openProject(page);
  await page.waitForFunction(
    () => document.documentElement.dataset.uiTheme === "classic",
  );
  await expect(page.locator("[data-project-sidebar]")).toHaveCSS(
    "width",
    "330px",
  );
  // Idle conversations now reopen as metadata with a fresh composer. Select
  // the saved review explicitly and load the inactive transcript for this check.
  await page.evaluate(async ({ firstTab, secondTab }) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.getState().setActiveTab(secondTab);
    await useAgentChatStore.getState().loadHistory(firstTab, 0, 200);
  }, created);
  const restored = await readState(page);
  assert.deepEqual(
    restored.tabs
      .filter(
        (tab) => tab.id === created.firstTab || tab.id === created.secondTab,
      )
      .map((tab) => tab.id),
    [created.firstTab, created.secondTab],
  );
  assert.equal(restored.tabs[0].draft.input, "First unsent draft α");
  assert.equal(restored.tabs[0].messages.length, 2);
  assert.equal(restored.tabs[1].draft.input, "Second unsent draft 测试");
  assert.equal(
    restored.tabs[1].draft.pinnedContexts[0].selectedText,
    "Saved source",
  );
  assert.equal(restored.activeTabId, created.secondTab);
  assert.equal(restored.selectedModel, "claude-opus-4-6");
  assert.equal(restored.activeFile, hydrated.recent[0].lastActiveFile);
  assert.equal(restored.document, editedDraft);
  assert.equal(restored.proposals[0]?.newContent, editedDraft);
  assert.equal(restored.reviews[0].phase, "review");
  assert.equal(
    Object.values(restored.reviews[0].editedContents ?? {})[0],
    editedDraft,
  );
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );
  const native = await page.evaluate(
    async ({ projectRoot, sessionId }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return {
        snapshots: await invoke("history_list", {
          projectRoot,
          limit: 50,
          offset: 0,
        }),
        conversation: await invoke("desktop:chat:messages", {
          projectRoot,
          tabId: sessionId,
          start: 0,
          limit: 200,
        }),
      };
    },
    { projectRoot: project, sessionId: created.firstTab },
  );
  assert.ok(
    native.snapshots.some((snapshot) => snapshot.id === created.historyIds[0]),
  );
  assert.equal(native.conversation.length, 2);
  await expect(
    page.locator('[data-chat-composer-input="true"]:visible').last(),
  ).toHaveValue("Second unsent draft 测试");
  await expect(page.locator(".cm-content").first()).toContainText(
    "A human edit that must survive quitting.",
  );
  await page.screenshot({ path: path.join(artifacts, "restored-review.png") });
  console.log(
    "Restart restored settings, recents, chat tabs, messages, drafts, models, native history and pending review edits.",
  );

  await page.evaluate(async (firstTab) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useProposedChangesStore } = await import(
      "/src/renderer/stores/proposed-changes-store.ts"
    );
    await useProposedChangesStore.getState().undoAll();
    const chats = useAgentChatStore.getState();
    chats.closeTab(firstTab);
    useSettingsStore.getState().setEditorFontSize(16);
    useSettingsStore.getState().setModeTheme("duet", "modern");
    localStorage.removeItem("catalex.skipFileMoveConfirmation");
  }, created.firstTab);
  await page
    .locator('[data-chat-composer-input="true"]:visible')
    .last()
    .fill("Updated surviving draft");
  await close();
  page = await launch();
  const updatedHydration = await readState(page);
  assert.equal(updatedHydration.fontSize, 16);
  assert.equal(updatedHydration.modeThemes.duet, "modern");
  assert.equal(updatedHydration.preference, null);
  assert.equal(updatedHydration.reviews.length, 0);
  assert.equal(updatedHydration.proposals.length, 0);
  await openProject(page);
  await expect(page.locator("[data-project-sidebar]")).toHaveCSS(
    "width",
    "330px",
  );
  await page.evaluate(async (tabId) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.getState().setActiveTab(tabId);
  }, created.secondTab);
  const updated = await readState(page);
  assert.equal(updated.tabs.length, 1);
  assert.equal(updated.tabs[0].id, created.secondTab);
  assert.equal(updated.tabs[0].draft.input, "Updated surviving draft");
  assert.equal(updated.document, source);
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );
  await page.screenshot({ path: path.join(artifacts, "updated.png") });
  assert.deepEqual(pageErrors, [], "No renderer exceptions across restarts");
  console.log(
    "Third launch retained edits and removals without reviving rejected drafts or closed tabs.",
  );
  await assert.rejects(fs.stat(path.dirname(created.candidateRoot)), {
    code: "ENOENT",
  });
  // A paused runtime's persisted state and a deliberately retained resume backup.
  // Sandbox creation and writes are native; no live provider request is needed.
  const paused = await page.evaluate(async (projectRoot) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { usePausedReviewStore } = await import(
      "/src/renderer/stores/paused-review-store.ts"
    );
    const { prepareAgentWorkspace } = await import(
      "/src/renderer/lib/agent-workspace.ts"
    );
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const tabId = useAgentChatStore.getState().activeTabId;
    const active = await prepareAgentWorkspace(
      projectRoot,
      tabId,
      null,
      "ask",
      [],
    );
    const backup = await prepareAgentWorkspace(
      projectRoot,
      tabId,
      null,
      "ask",
      [],
    );
    await invoke("desktop:fs:writeTextFile", {
      path: `${active.candidateRoot}/notes.md`,
      contents: "Unfinished paused edit",
    });
    await invoke("desktop:fs:writeTextFile", {
      path: `${backup.candidateRoot}/notes.md`,
      contents: "Retained previous draft",
    });
    await invoke("set_agent_workspace_backup", {
      projectRoot,
      sessionId: backup.sessionId,
      backup: true,
    });
    usePausedReviewStore.setState({ backups: { [tabId]: [backup] } });
    useAgentChatStore.getState()._setAgentWorkspace(tabId, active);
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, pauseState: "paused", isStreaming: false }
          : tab,
      ),
    }));
    return { tabId, active, backup };
  }, project);
  await close();
  page = await launch();
  await openProject(page);
  const pausedRestored = await page.evaluate(async (tabId) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { usePausedReviewStore } = await import(
      "/src/renderer/stores/paused-review-store.ts"
    );
    const tab = useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId);
    return {
      phase: tab?.pauseState,
      streaming: tab?.isStreaming,
      sessionId: tab?.agentWorkspace?.sessionId,
      backups: usePausedReviewStore.getState().backups[tabId],
    };
  }, paused.tabId);
  assert.equal(pausedRestored.phase, "paused");
  assert.equal(pausedRestored.streaming, false);
  assert.equal(pausedRestored.sessionId, paused.active.sessionId);
  assert.equal(pausedRestored.backups[0].sessionId, paused.backup.sessionId);
  assert.equal(
    await fs.readFile(
      path.join(paused.active.candidateRoot, "notes.md"),
      "utf8",
    ),
    "Unfinished paused edit",
  );
  assert.equal(
    await fs.readFile(
      path.join(paused.backup.candidateRoot, "notes.md"),
      "utf8",
    ),
    "Retained previous draft",
  );
  assert.equal(
    await fs.readFile(path.join(project, "notes.md"), "utf8"),
    source,
  );
  assert.deepEqual(
    pageErrors,
    [],
    "No renderer exceptions after paused sandbox recovery",
  );
  console.log(
    "Fourth launch preserved the paused sandbox and resume backup without restarting an agent; rejected sandbox was removed.",
  );
  await fs.rm(path.join(artifacts, "failure.png"), { force: true });
  await fs.rm(path.join(artifacts, "failure-state.json"), { force: true });
  const handoff = await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { saveProjectChats } = await import(
      "/src/renderer/lib/project-chat-lifecycle.ts"
    );
    const tabId = useAgentChatStore.getState().createTab();
    const messages = Array.from({ length: 600 }, (_, index) => ({
      type: index % 2 ? "assistant" : "user",
      provider: index < 300 ? "claude" : "codex",
      message: {
        content: [
          { type: "text", text: `Handoff ${index}: ${"文".repeat(100)}` },
        ],
      },
    }));
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              messages,
              provider: "claude",
              sessionId: "claude-handoff",
              providerSessionIds: {
                claude: "claude-handoff",
                codex: "codex-handoff",
              },
              providerSyncCursors: { claude: 300, codex: 600 },
            }
          : tab,
      ),
    }));
    await saveProjectChats();
    return { tabId };
  });
  await close();
  page = await launch();
  await openProject(page);
  const handoffResult = await page.evaluate(async ({ tabId }) => {
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    const tab = useAgentChatStore
      .getState()
      .tabs.find((tab) => tab.id === tabId);
    const args = {
      projectRoot: useDocumentStore.getState().projectRoot,
      tabId,
      runtimeSessionKey: tab.runtimeSessionKey,
      retry: false,
    };
    const unseen = await invoke("desktop:chat:prepare-turn", {
      ...args,
      cursor: tab.providerSyncCursors.claude,
    });
    const synced = await invoke("desktop:chat:prepare-turn", {
      ...args,
      cursor: tab.providerSyncCursors.codex,
    });
    const first = await invoke("desktop:chat:prepare-turn", {
      ...args,
      cursor: 0,
    });
    return {
      ids: tab.providerSessionIds,
      unseen: unseen.transcript,
      synced: synced.transcript,
      first: first.transcript,
    };
  }, handoff);
  assert.deepEqual(handoffResult.ids, {
    claude: "claude-handoff",
    codex: "codex-handoff",
  });
  const transcript = (start) =>
    Array.from({ length: 600 - start }, (_, offset) => {
      const index = start + offset;
      const role = index % 2 ? (index < 300 ? "Claude" : "Codex") : "User";
      return `${role}: Handoff ${index}: ${"文".repeat(100)}`;
    }).join("\n\n");
  assert.equal(handoffResult.unseen, transcript(300));
  assert.equal(handoffResult.first, transcript(0));
  assert.equal(handoffResult.synced, "");
  console.log(
    "PASS: full unseen handoff and provider sessions survive an Electron restart",
  );
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (app?.windows()[0]) {
    const state = await readState(app.windows()[0]).catch(() => null);
    await fs.writeFile(
      path.join(artifacts, "failure-state.json"),
      JSON.stringify(state, null, 2),
    );
  }
  await app
    ?.windows()[0]
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  await vite?.close();
  await fs.chmod(path.join(profile, "workspace-state"), 0o700).catch(() => {});
  await fs.rm(profile, { recursive: true, force: true });
}
