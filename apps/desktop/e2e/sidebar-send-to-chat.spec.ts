import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(async () => {
    const { useAgentChatStore: chat } = await import(
      /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
    );
    const { useDocumentStore: doc } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const { openPanelWindow: open } = await import(
      /* @vite-ignore */ "/src/renderer/lib/panel-windows.ts"
    );
    const base = chat.getState().tabs[0];
    chat.setState({
      chatProjectRoot: doc.getState().projectRoot,
      activeTabId: "main",
      tabs: ["main", "other", "closed"].map((id) => ({
        ...base,
        id,
        title: `${id} chat`,
        runtimeSessionKey: id,
        archived: false,
        draft: { input: `Keep ${id} draft`, pinnedContexts: [] },
      })),
    });
    const source = doc.getState().files[0];
    doc.setState({
      files: [
        ...doc.getState().files,
        ...["reference.tex", "empty.pdf"].map((id) => ({
          ...source,
          id,
          name: id,
          relativePath: id,
          absolutePath: `${doc.getState().projectRoot}/${id}`,
          type: id.endsWith("pdf") ? "pdf" : "tex",
          content: id.endsWith("pdf") ? "" : "Unsaved reference text",
          isDirty: true,
        })),
      ],
    });
    Object.assign(window, { sidebarChatTest: { chat, doc, open } });
  });
}
async function openChat(page: Page, id: string) {
  const opened = page.waitForEvent("popup");
  await page.evaluate((id) => {
    const { chat, open } = (window as any).sidebarChatTest;
    chat.getState().setActiveTab(id);
    open("chat", "duet");
  }, id);
  const child = await opened;
  await expect(child.locator("[data-panel-window-title]")).toBeVisible();
  await page.evaluate(() =>
    (window as any).sidebarChatTest.chat.getState().setActiveTab("main"),
  );
  return child;
}
async function fileMenu(page: Page, file = "reference.tex") {
  await page
    .locator(`[data-sidebar-file-id="${file}"]`)
    .click({ button: "right" });
  return page.getByRole("menu", { name: "File actions", exact: true });
}
async function drafts(page: Page) {
  return page.evaluate(() => {
    const state = (window as any).sidebarChatTest.chat.getState();
    return {
      active: state.activeTabId,
      pending: state.pendingAttachments,
      tabs: state.tabs.map((tab: any) => ({ id: tab.id, draft: tab.draft })),
    };
  });
}

test("single target sends directly with Main and Main & Pop-out badges, preserving drafts", async ({
  page,
}) => {
  await setup(page);
  let menu = await fileMenu(page);
  const send = page.getByRole("menuitem", {
    name: "Send to chat",
    exact: true,
  });
  await expect(send).toContainText("Main");
  await expect(send.locator(".lucide-messages-square")).toHaveCount(1);
  await send.hover();
  await expect(
    menu.getByRole("menuitem", { name: "Copy file path" }),
  ).toBeVisible();
  await send.click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  let state = await drafts(page);
  expect(state.active).toBe("main");
  expect(state.pending).toEqual([]);
  expect(state.tabs[0].draft).toEqual({
    input: "Keep main draft",
    pinnedContexts: [
      {
        label: "@reference.tex",
        filePath: "reference.tex",
        selectedText: "Unsaved reference text",
        selectionKey: "file:reference.tex",
        selectionPinned: true,
      },
    ],
  });
  expect(state.tabs[1].draft).toEqual({
    input: "Keep other draft",
    pinnedContexts: [],
  });
  const child = await openChat(page, "main");
  menu = await fileMenu(page);
  await expect(send).toContainText("Main & Pop-out");
  await menu.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: test.info().outputPath("file-direct-both.png"),
  });
  await send.click();
  await expect
    .poll(async () => (await drafts(page)).tabs[0].draft.pinnedContexts.length)
    .toBe(1);
  await expect(
    child.locator('[data-selection-chip="true"][data-selection-pinned="true"]'),
  ).toContainText("reference.tex");
  await fileMenu(page, "empty.pdf");
  await send.click();
  state = await drafts(page);
  expect(state.tabs[0].draft.pinnedContexts[1]).toMatchObject({
    filePath: "empty.pdf",
    selectedText: "",
    selectionPinned: true,
  });
  await child.close();
});

test("chat choices replace the file menu on click, support back and keyboard, and send only to the chosen chat", async ({
  page,
}) => {
  await setup(page);
  const other = await openChat(page, "other");
  const main = await openChat(page, "main");
  await fileMenu(page);
  const send = page.getByRole("menuitem", {
    name: "Send to chat",
    exact: true,
  });
  await send.hover();
  await page.waitForTimeout(250);
  await expect(
    page.getByRole("menu", { name: "Send file to chat" }),
  ).toHaveCount(0);
  await send.click();
  const choices = page.getByRole("menu", { name: "Send file to chat" });
  await expect(choices).toBeVisible();
  await expect(page.getByRole("menu")).toHaveCount(1);
  await expect(choices.getByRole("menuitem")).toHaveCount(3);
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toHaveCount(0);
  await expect(
    choices.getByRole("menuitem", {
      name: "main chat Main & Pop-out",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    choices.getByRole("menuitem", { name: "other chat Pop-out", exact: true }),
  ).toBeVisible();
  await expect(choices).not.toContainText("closed chat");
  await page.screenshot({
    path: test.info().outputPath("file-chat-choices.png"),
  });
  await choices.getByRole("menuitem", { name: "Back to file actions" }).click();
  await expect(send).toBeFocused();
  await send.press("ArrowRight");
  await expect(
    choices.getByRole("menuitem", {
      name: "main chat Main & Pop-out",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(send).toBeFocused();
  await send.press("Enter");
  await page.keyboard.press("ArrowLeft");
  await expect(send).toBeFocused();
  await send.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(
    choices.getByRole("menuitem", { name: "other chat Pop-out", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect
    .poll(async () => (await drafts(page)).tabs[1].draft.pinnedContexts.length)
    .toBe(1);
  const state = await drafts(page);
  expect(state.active).toBe("main");
  expect(state.tabs[0].draft.pinnedContexts).toEqual([]);
  expect(state.tabs[1].draft.input).toBe("Keep other draft");
  expect(state.tabs[2].draft.pinnedContexts).toEqual([]);
  await expect(
    other.locator('[data-selection-chip="true"][data-selection-pinned="true"]'),
  ).toContainText("reference.tex");
  await fileMenu(page);
  await expect(
    page.getByRole("menuitem", { name: "Rename", exact: true }),
  ).toBeVisible();
  await send.click();
  await other.close();
  await expect(send).toContainText("Main & Pop-out");
  await expect(choices).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await main.close();
});

test("file context opens the clicked file and reuses its window without changing the main selection", async ({
  page,
  context,
}) => {
  await setup(page);
  const active = await page.evaluate(
    () => (window as any).sidebarChatTest.doc.getState().activeFileId,
  );
  await fileMenu(page);
  await page.getByRole("menu").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: test.info().outputPath("file-popout-menu.png"),
  });
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  const child = await opened;
  await expect(child.locator(".cm-content")).toContainText(
    "Unsaved reference text",
  );
  expect(
    await page.evaluate(
      () => (window as any).sidebarChatTest.doc.getState().activeFileId,
    ),
  ).toBe(active);
  await fileMenu(page);
  await page
    .getByRole("menuitem", { name: "Open in pop-out", exact: true })
    .click();
  expect(context.pages()).toHaveLength(2);
  await child.close();
});
