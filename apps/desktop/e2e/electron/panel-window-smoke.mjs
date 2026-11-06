import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const desktopRoot = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-panel-window-"),
);
const project = path.join(profile, "Panel project");
await fs.mkdir(project);
await fs.writeFile(
  path.join(project, "notes.md"),
  "# Shared notes\n\nOriginal text.\n",
);
await fs.writeFile(path.join(project, "other.md"), "# Another file\n");
await fs.writeFile(
  path.join(project, "main.tex"),
  String.raw`\documentclass{article}
\begin{document}
Native pop-out PDF.
\end{document}
`,
);
await fs.writeFile(
  path.join(project, "chapter.tex"),
  "% !TEX root = main.tex\nA chapter in the main document.\n",
);
const artifacts = path.resolve(
  desktopRoot,
  "../../output/playwright/electron/panel-window",
);
await fs.mkdir(artifacts, { recursive: true });
const vite = await createServer({
  root: desktopRoot,
  configFile: path.join(desktopRoot, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
await vite.listen();
const env = {
  ...process.env,
  CATALEX_USER_DATA_DIR: profile,
  CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let main;
const errors = [];
async function ready(page) {
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  return page;
}
try {
  app = await electron.launch({ args: [desktopRoot], env });
  main = await ready(await app.firstWindow());
  await main.evaluate(async (project) => {
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
  });
  await expect(
    main.getByRole("button", { name: "New Project", exact: true }),
  ).toBeVisible();
  await main.evaluate(async (project) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({ defaultAutoCompile: false });
    await useDocumentStore.getState().closeProject();
    await useDocumentStore.getState().openProject(project);
    const file = useDocumentStore
      .getState()
      .files.find((file) => file.name === "notes.md");
    useDocumentStore.getState().setActiveFile(file.id);
  }, project);

  await expect(main.locator(".cm-content")).toContainText("Original text.");
  await main
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await expect(
    main.getByRole("button", { name: "Toggle drawer", exact: true }),
  ).toHaveCSS("pointer-events", "none");
  await main.getByRole("button", { name: "Full", exact: true }).click();
  await expect(main.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  const titlebar = main.locator("[data-workspace-titlebar]");
  await main.evaluate(async () => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    store.getState()._appendMessage(store.getState().activeTabId, {
      type: "user",
      provider: "claude",
      model: "claude-sonnet-4-6",
      reasoningEffort: "high",
      startsModelSection: true,
      message: { content: [{ type: "text", text: "A saved Claude reply." }] },
    });
    store.setState((state) => ({
      selectedProvider: "codex",
      tabs: state.tabs.map((tab) => ({ ...tab, provider: "codex" })),
    }));
  });
  await expect(main.locator("[data-chat-last-provider]")).toHaveText("Claude");
  await expect(main.locator("[data-chat-last-model]")).toHaveText(
    "Sonnet 4.6 · High",
  );
  await expect(titlebar).toHaveCSS("-webkit-app-region", "drag");
  assert.equal(
    await titlebar
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.every(
          (button) =>
            getComputedStyle(button).getPropertyValue("-webkit-app-region") ===
            "no-drag",
        ),
      ),
    true,
  );
  const chatTitleSpace = main.locator("[data-chat-panel-title]");
  await chatTitleSpace.dblclick();
  await expect(
    main.getByRole("dialog", { name: "Chat expanded", exact: true }),
  ).toBeVisible();
  await expect(
    main.getByRole("button", { name: "More Chat view actions", exact: true }),
  ).toBeVisible();
  await chatTitleSpace.dblclick();
  await expect(
    main.getByRole("dialog", { name: "Chat expanded", exact: true }),
  ).toHaveCount(0);
  const filePicker = titlebar.getByRole("combobox");
  await filePicker.click();
  await main.getByRole("option", { name: "other.md", exact: true }).click();
  await expect(main.locator(".cm-content")).toContainText("Another file");
  await filePicker.click();
  await main.getByRole("option", { name: "notes.md", exact: true }).click();
  await expect(main.locator(".cm-content")).toContainText("Original text.");
  await main.screenshot({
    path: path.join(artifacts, "chat-workspace-titlebar.png"),
  });
  await main.getByRole("button", { name: "Half", exact: true }).click();
  await expect(main.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "drawer",
  );
  await expect(
    main.locator("[data-workspace-header] [data-window-drag-region]").first(),
  ).toHaveCSS("-webkit-app-region", "drag");
  console.log(
    "Native chat workspace titlebar drag region and file selector passed",
  );

  // Context actions target an unselected file and an unloaded saved session.
  const originalSelection = await main.evaluate(async () => {
    const { useDocumentStore: doc } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useAgentChatStore: chat } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const file = doc.getState().files.find((item) => item.name === "other.md");
    doc.setState({
      files: doc
        .getState()
        .files.map((item) =>
          item.id === file.id ? { ...item, content: undefined } : item,
        ),
    });
    return {
      file: doc.getState().activeFileId,
      chat: chat.getState().activeTabId,
      other: file.id,
    };
  });
  const fileRow = main.locator(
    `[data-sidebar-file-id="${originalSelection.other}"]`,
  );
  await fileRow.click({ button: "right" });
  const fileOpened = app.waitForEvent("window");
  await main
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  const filePopup = await ready(await fileOpened);
  await expect(filePopup.locator(".cm-content")).toContainText("Another file");
  await expect(main.locator(".cm-content")).toContainText("Original text.");
  const windowsBefore = app.windows().length;
  await fileRow.click({ button: "right" });
  await main
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  const fileNative = await app.browserWindow(filePopup);
  await expect
    .poll(() => fileNative.evaluate((win) => win.isFocused()))
    .toBe(true);
  assert.equal(app.windows().length, windowsBefore);
  await filePopup.evaluate(() => window.close());
  await expect.poll(() => filePopup.isClosed()).toBe(true);
  await main.evaluate(async (project) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    await invoke("save_shared_session", {
      projectPath: project,
      sharedSessionId: "sidebar-saved",
      providerSessionIds: {},
      title: "Saved sidebar conversation",
      lastProvider: "claude",
      messages: [
        {
          type: "user",
          message: {
            content: [{ type: "text", text: "Native saved history." }],
          },
        },
      ],
    });
  }, project);
  await main.getByRole("button", { name: "Full", exact: true }).click();
  const savedRow = main
    .locator('[data-sidebar-section="sessions"]')
    .getByRole("button", { name: /Saved sidebar conversation/ });
  await savedRow.click({ button: "right" });
  await main.screenshot({
    path: path.join(artifacts, "session-popout-menu.png"),
  });
  const savedOpened = app.waitForEvent("window");
  await main
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  const savedPopup = await ready(await savedOpened);
  await expect(
    savedPopup.getByText("Native saved history.", { exact: true }),
  ).toBeVisible();
  await expect(
    savedPopup.getByText("Choose LLM for this resumed chat", { exact: true }),
  ).toBeVisible();
  await expect(
    savedPopup.getByRole("button", { name: /Current LLM/ }),
  ).toContainText("Codex");
  assert.deepEqual(
    await main.evaluate(async () => {
      const { useDocumentStore: doc } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { useAgentChatStore: chat } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      return {
        file: doc.getState().activeFileId,
        chat: chat.getState().activeTabId,
      };
    }),
    { file: originalSelection.file, chat: originalSelection.chat },
  );
  const savedWindows = app.windows().length;
  await savedRow.click({ button: "right" });
  await main
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  const savedNative = await app.browserWindow(savedPopup);
  await expect
    .poll(() => savedNative.evaluate((win) => win.isFocused()))
    .toBe(true);
  assert.equal(app.windows().length, savedWindows);
  await savedPopup.evaluate(() => window.close());
  await expect.poll(() => savedPopup.isClosed()).toBe(true);
  await main.getByRole("button", { name: "Half", exact: true }).click();
  console.log(
    "Native sidebar file/session pop-outs, lazy loading, unchanged main selection, and duplicate focus passed",
  );

  const opened = app.waitForEvent("window", { timeout: 15000 });
  await main
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await main
    .getByRole("menuitem", {
      name: "Pop out Editor",
      exact: true,
    })
    .click();
  const child = await ready(await opened);
  const showProject = child.getByRole("button", {
    name: "Show project window: Panel project",
    exact: true,
  });
  await expect(showProject).toBeVisible();
  // Keep another project open to catch accidental focus of the last active window.
  const otherProject = path.join(profile, "Other project");
  await fs.mkdir(otherProject);
  await fs.writeFile(path.join(otherProject, "other.md"), "# Other project\n");
  const otherOpened = app.waitForEvent("window");
  await main.evaluate(() => window.catalex.invoke("create_new_window"));
  const otherWindow = await ready(await otherOpened);
  await otherWindow.evaluate(async (root) => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().openProject(root);
  }, otherProject);
  const ownerWindow = await app.browserWindow(main);
  const otherNativeWindow = await app.browserWindow(otherWindow);
  await otherNativeWindow.evaluate((win) => win.focus());
  await showProject.click();
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  const childNativeWindow = await app.browserWindow(child);
  await childNativeWindow.evaluate((win) => win.focus());
  await expect
    .poll(() => childNativeWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  await ownerWindow.evaluate((win) => win.hide());
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isVisible()))
    .toBe(false);
  await showProject.click();
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isVisible()))
    .toBe(true);
  await expect
    .poll(() => ownerWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  await expect(showProject).toBeVisible();
  await otherWindow.evaluate(() =>
    window.catalex.invoke("desktop:window:close"),
  );
  console.log(
    "Pop-out returns to its exact project window and shows it when hidden",
  );
  const editorElement = await child.locator(".cm-content").elementHandle();
  await expect(child.locator(".cm-content")).toContainText("Original text.");
  await child.locator(".cm-content").focus();
  await child.keyboard.press("ControlOrMeta+End");
  await child.keyboard.insertText("From pop-out.\n");
  await expect(main.locator(".cm-content")).toContainText("From pop-out.");
  await main.locator(".cm-content").focus();
  await main.keyboard.press("ControlOrMeta+End");
  await main.keyboard.insertText("From main.\n");
  await expect(child.locator(".cm-content")).toContainText("From main.");
  await main.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const file = useDocumentStore
      .getState()
      .files.find((file) => file.name === "other.md");
    useDocumentStore.getState().setActiveFile(file.id);
  });
  await expect(main.locator(".cm-content")).toContainText("Another file");
  await expect(child.locator(".cm-content")).toContainText("From main.");
  await child.locator(".cm-content").focus();
  await child.keyboard.press("ControlOrMeta+End");
  await child.keyboard.insertText("Still pinned.\n");
  await expect
    .poll(() => fs.readFile(path.join(project, "notes.md"), "utf8"), {
      timeout: 15000,
    })
    .toContain("Still pinned.");
  assert.equal(
    await fs.readFile(path.join(project, "other.md"), "utf8"),
    "# Another file\n",
  );
  assert.equal(
    await editorElement.evaluate((el) => el.isConnected),
    true,
    "Owner updates preserve the mounted editor",
  );
  console.log("editor synced and pinned");
  // Selection UI is hosted in the child document and remains clickable.
  await child.keyboard.press("ControlOrMeta+Home");
  await child.locator(".cm-content").focus();
  await child.keyboard.press("ControlOrMeta+a");
  await child.keyboard.press("ArrowLeft");
  await child.keyboard.press("Shift+ArrowRight");
  await child.keyboard.press("Shift+ArrowRight");
  await child
    .locator("[data-selection-toolbar]")
    .getByRole("button", { name: "Comment", exact: true })
    .click();
  const comment = child.getByRole("textbox", {
    name: "Comment text",
    exact: true,
  });
  await comment.fill("Comment from native pop-out");
  await comment.press("Enter");
  await expect(
    child.getByText("Comment from native pop-out", { exact: true }).last(),
  ).toBeVisible();
  await child.screenshot({ path: path.join(artifacts, "editor-pinned.png") });
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    s.getState().setActiveFile("notes.md");
  });
  await expect(main.locator(".cm-content")).toContainText("Still pinned.");
  const count = app.windows().length;
  await childNativeWindow.evaluate((win) => win.hide());
  await expect
    .poll(() => childNativeWindow.evaluate((win) => win.isVisible()))
    .toBe(false);
  await main
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await main
    .getByRole("menuitem", {
      name: "Pop out Editor",
      exact: true,
    })
    .click();
  assert.equal(
    app.windows().length,
    count,
    "Opening the same panel focuses its existing window",
  );
  await expect
    .poll(() => childNativeWindow.evaluate((win) => win.isVisible()))
    .toBe(true);
  await expect
    .poll(() => childNativeWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  console.log("editor comment and duplicate focus passed");
  const previewHeader = main.getByTestId("markdown-preview-toolbar");
  const gestureSpace = previewHeader.locator("[data-panel-header-space]");
  assert.equal(
    await gestureSpace.evaluate((element) =>
      getComputedStyle(element).getPropertyValue("-webkit-app-region"),
    ),
    "no-drag",
  );
  await gestureSpace.dblclick();
  await expect(
    main.getByRole("dialog", { name: "Preview expanded" }),
  ).toBeVisible();
  await gestureSpace.dblclick();
  await expect(
    main.getByRole("dialog", { name: "Preview expanded" }),
  ).toHaveCount(0);
  const previewOpened = app.waitForEvent("window", { timeout: 15000 });
  await gestureSpace.dblclick({ modifiers: ["Alt"] });
  const preview = await ready(await previewOpened);
  await expect(preview.frameLocator("iframe").locator("body")).toContainText(
    "Still pinned.",
  );
  await child.locator(".cm-content").focus();
  await child.keyboard.press("ControlOrMeta+End");
  await child.keyboard.insertText("Live preview update.\n");
  await expect(preview.frameLocator("iframe").locator("body")).toContainText(
    "Live preview update.",
  );
  await preview.screenshot({
    path: path.join(artifacts, "markdown-preview.png"),
  });
  console.log("preview synchronized");
  const chatOpened = app.waitForEvent("window", { timeout: 15000 });
  await main.evaluate(async () => {
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    openPanelWindow("chat", "duet");
  });
  const chat = await ready(await chatOpened);
  await expect(chat.locator("[data-chat-title-current]")).toHaveText(
    "ClaudeSonnet 4.6 · High",
  );
  await expect(
    chat.getByRole("button", { name: "More Chat view actions", exact: true }),
  ).toBeVisible();
  await expect(
    chat.getByRole("button", { name: "Session history", exact: true }),
  ).toHaveCount(0);
  await expect(chat.locator("[data-panel-window-title]")).toHaveText(
    "New Chat",
  );
  await chat
    .locator('[data-chat-composer-input="true"]:visible')
    .fill("Shared unsent draft");
  await expect(
    main
      .locator('[data-chat-drawer-panel="true"]:visible')
      .locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Shared unsent draft");
  await expect
    .poll(() =>
      main.evaluate(async () => {
        const { useAgentChatStore: s } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        return s.getState().tabs.find((t) => t.id === s.getState().activeTabId)
          ?.draft.input;
      }),
    )
    .toBe("Shared unsent draft");
  await chat.screenshot({ path: path.join(artifacts, "chat-draft.png") });
  const originalChatId = await main.evaluate(async () => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    return store.getState().activeTabId;
  });
  const secondChatOpened = app.waitForEvent("window", { timeout: 15000 });
  const secondChatId = await main.evaluate(async () => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    const id = store.getState().createTab();
    store.setState((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === id ? { ...tab, title: "Second conversation" } : tab,
      ),
    }));
    openPanelWindow("chat", "duet");
    return id;
  });
  const secondChat = await ready(await secondChatOpened);
  await expect(secondChat.locator("[data-panel-window-title]")).toHaveText(
    "Second conversation",
  );
  await expect(chat.locator("[data-panel-window-title]")).toHaveText(
    "New Chat",
  );
  await secondChat
    .locator('[data-chat-composer-input="true"]:visible')
    .fill("Second chat draft");
  await chat
    .locator('[data-chat-composer-input="true"]:visible')
    .fill("Pinned first chat draft");
  await expect(
    secondChat.locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Second chat draft");
  await expect(
    main
      .locator('[data-chat-drawer-panel="true"]:visible')
      .locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Second chat draft");
  assert.equal(
    await main.evaluate(async () => {
      const { useAgentChatStore: store } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      return store.getState().activeTabId;
    }),
    secondChatId,
  );
  await child.locator(".cm-content").focus();
  await child.keyboard.press("ControlOrMeta+Home");
  await child.keyboard.press("Shift+End");
  await child
    .getByRole("button", { name: "Send to chat", exact: true })
    .click();
  await expect(child.getByRole("menuitem")).toHaveCount(2);
  await child.screenshot({
    path: path.join(artifacts, "send-selection-menu.png"),
    animations: "disabled",
  });
  await child
    .getByRole("menuitem", { name: "New Chat Pop-out", exact: true })
    .click();
  await expect(
    chat.locator('[data-selection-chip="true"][data-selection-pinned="true"]'),
  ).toHaveCount(1);
  await expect(
    secondChat.locator(
      '[data-selection-chip="true"][data-selection-pinned="true"]',
    ),
  ).toHaveCount(0);
  await expect(
    chat.locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Pinned first chat draft");
  const transferredSelection = await main.evaluate(async (id) => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    return store
      .getState()
      .tabs.find((tab) => tab.id === id)
      .draft.pinnedContexts.find((context) => context.selectionPinned);
  }, originalChatId);
  assert.ok(transferredSelection?.selectedText);
  console.log("Native reference-window selection pinned to the requested chat");
  const chatWindowCount = app.windows().length;
  const pinnedNativeWindow = await app.browserWindow(chat);
  await pinnedNativeWindow.evaluate((win) => win.hide());
  await main.evaluate(async (id) => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    store.getState().setActiveTab(id);
    openPanelWindow("chat", "duet");
  }, originalChatId);
  await expect
    .poll(() => pinnedNativeWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  assert.equal(app.windows().length, chatWindowCount);
  await expect(
    chat.locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Pinned first chat draft");
  await chat
    .locator('[data-chat-composer-input="true"]:visible')
    .fill("Shared unsent draft");
  await chat.screenshot({ path: path.join(artifacts, "pinned-chat.png") });
  console.log(
    "Independent pinned chats, isolated drafts and duplicate native focus passed",
  );
  const secondChatClosed = secondChat.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(async (id) => {
    const { useAgentChatStore: store } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    store.getState().closeTab(id);
  }, secondChatId);
  await secondChatClosed;
  assert.equal(chat.isClosed(), false);
  await expect(
    chat.locator('[data-chat-composer-input="true"]:visible'),
  ).toHaveValue("Shared unsent draft");
  console.log("Removing one chat closes only its own native pop-out");
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    s.getState().setActiveFile("chapter.tex");
  });
  const pdfOpened = app.waitForEvent("window", { timeout: 15000 });
  await main
    .getByRole("button", { name: "More PDF view actions", exact: true })
    .click();
  await main
    .getByRole("menuitem", { name: "Pop out PDF", exact: true })
    .click();
  const pdf = await ready(await pdfOpened);
  await expect(pdf.locator("[data-panel-window-title]")).toHaveText("main.tex");
  const pdfWindow = await app.browserWindow(pdf);
  const pdfWindowCount = app.windows().length;
  await pdfWindow.evaluate((win) => win.hide());
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { openPanelWindow } = await import(
      "/src/renderer/lib/panel-windows.ts"
    );
    s.getState().setActiveFile("main.tex");
    openPanelWindow("preview", "duet");
  });
  await expect
    .poll(() => pdfWindow.evaluate((win) => win.isVisible()))
    .toBe(true);
  await expect
    .poll(() => pdfWindow.evaluate((win) => win.isFocused()))
    .toBe(true);
  assert.equal(
    app.windows().length,
    pdfWindowCount,
    "Root and chapter reuse the same native preview",
  );
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    s.getState().setActiveFile("other.md");
  });
  await pdf.evaluate(async () => {
    const { compileWorkspace } = await import(
      "/src/renderer/lib/workspace-compile.ts"
    );
    await compileWorkspace({ force: true });
  });
  await expect(pdf.locator(".mupdf-text-layer").first()).toContainText(
    "Native pop-out PDF.",
    { timeout: 60000 },
  );
  await expect(main.locator(".cm-content")).toContainText("Another file");
  await pdf.screenshot({ path: path.join(artifacts, "pdf-pinned.png") });
  console.log("native pinned PDF compilation passed");
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore
      .getState()
      .setProjectAutoCompile(s.getState().projectRoot, true);
    const file = s.getState().files.find((f) => f.id === "main.tex");
    s.getState().updateFileContent(
      file.id,
      file.content.replace(
        "Native pop-out PDF.",
        "Automatic pinned PDF update.",
      ),
    );
  });
  await expect(pdf.locator(".mupdf-text-layer").first()).toContainText(
    "Automatic pinned PDF update.",
    { timeout: 60000 },
  );
  console.log("pinned PDF auto-compilation passed");
  // A failed owner save must leave the native child open for retry.
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    window.__restoreSave = s.getState().saveAllFiles;
    s.setState({
      saveAllFiles: async () => {
        throw new Error("test save failure");
      },
    });
  });
  await app.evaluate(
    ({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL() === url)
        .close(),
    child.url(),
  );
  await expect(
    child.getByText(/Could not save:.*test save failure/),
  ).toBeVisible();
  assert.equal(child.isClosed(), false);
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    s.setState({ saveAllFiles: window.__restoreSave });
    delete window.__restoreSave;
  });
  const closed = child.waitForEvent("close", { timeout: 10000 });
  await child.evaluate(() => window.close());
  await closed;
  assert.equal(errors.length, 0, errors.join("\n"));
  // Closing the owner closes its dependent views; reopening uses saved source.
  const previewClosed = preview.waitForEvent("close", { timeout: 15000 });
  const pdfClosed = pdf.waitForEvent("close", { timeout: 15000 });
  const chatClosed = chat.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(async () => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await s.getState().closeProject();
  });
  await Promise.all([previewClosed, chatClosed, pdfClosed]);
  await app.close();
  app = await electron.launch({ args: [desktopRoot], env });
  main = await ready(await app.firstWindow());
  await main.evaluate(async (project) => {
    const { useDocumentStore: s } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await s.getState().openProject(project);
    s.getState().setActiveFile("notes.md");
  }, project);
  await expect(main.locator(".cm-content")).toContainText(
    "Live preview update.",
  );
  assert.deepEqual(
    await main.evaluate(async () => {
      const { useAgentChatStore: store } = await import(
        "/src/renderer/stores/agent-chat-store.ts"
      );
      const state = store.getState();
      const saved = state.tabs.find(
        (tab) => tab.lastCommunicationProvider === "claude",
      );
      if (!saved) return null;
      state.setActiveTab(saved.id);
      await store.getState().loadHistory(saved.id);
      const restored = store.getState().tabs.find((tab) => tab.id === saved.id);
      return {
        settings: restored?.lastCommunication,
        startsSection: restored?.messages[0]?.startsModelSection,
        selection: restored?.draft.pinnedContexts.find(
          (context) => context.selectionPinned,
        ),
      };
    }),
    {
      settings: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        effort: "high",
      },
      startsSection: true,
      // Checkpoint JSON omits optional properties whose value is undefined.
      selection: JSON.parse(JSON.stringify(transferredSelection)),
    },
  );
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "Native editor/preview/chat sync, pinned file, comments, duplicate focus, project close and restart persistence passed.",
  );
} catch (error) {
  console.error(error);
  await main
    ?.evaluate(async () => {
      if (!window.__restoreSave) return;
      const { useDocumentStore: s } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      s.setState({ saveAllFiles: window.__restoreSave });
    })
    .catch(() => {});
  console.error("Renderer errors", errors);
  console.error(await main?.locator("body").innerText());
  await main?.screenshot({ path: path.join(artifacts, "failure.png") });
  for (const [index, page] of (app?.windows() ?? []).entries()) {
    console.error(
      "Window",
      index,
      await page
        .locator("body")
        .innerText()
        .catch(() => "closed"),
    );
    if (!page.isClosed())
      await page
        .screenshot({ path: path.join(artifacts, `failure-${index}.png`) })
        .catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
