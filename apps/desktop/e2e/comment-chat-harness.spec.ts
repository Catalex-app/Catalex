import { expect, test } from "@playwright/test";

test("a selected excerpt goes with custom answers only", async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toBeVisible();
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();

  const ask = (requestId: string) =>
    page.evaluate(async (requestId) => {
      const load = (name: string) =>
        import(/* @vite-ignore */ `/src/renderer/stores/${name}.ts`);
      const { useAgentChatStore } = await load("agent-chat-store");
      const { useAgentQuestionStore } = await load("agent-question-store");
      const { useDocumentStore } = await load("document-store");
      const { activeTabId, tabs } = useAgentChatStore.getState();
      const tab = tabs.find((item: { id: string }) => item.id === activeTabId);
      useAgentChatStore.setState({
        isStreaming: true,
        tabs: [{ ...tab, isStreaming: true }],
      });

      const host = window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
        lastQuestionAnswer?: string;
      };
      const original = host.__TAURI_INTERNALS__.invoke.bind(
        host.__TAURI_INTERNALS__,
      );
      host.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "answer_agent_question") {
          host.lastQuestionAnswer = (args as { answer: string }).answer;
          return;
        }
        return original(command, args);
      };
      useAgentQuestionStore.getState().receive({
        requestId,
        tabId: tab.id,
        sessionId: tab.runtimeSessionKey,
        projectRoot: useDocumentStore.getState().projectRoot,
        question: "Which outline should I use?",
        options: [
          { label: "Use the existing outline" },
          { label: "Draft a new outline" },
        ],
      });
    }, requestId);

  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const question = drawer.getByRole("region", { name: "Agent question" });
  const draftSelection = drawer.locator(
    "[data-chat-composer-surface] > [data-context-row-shell] [data-selection-chip]",
  );
  const preset = question.getByRole("button", {
    name: "Use the existing outline",
  });
  const custom = question.getByRole("textbox", { name: "Custom answer" });
  const customSelection = question.locator("form [data-selection-chip]");
  const readAnswer = () =>
    page.evaluate(
      () =>
        (window as typeof window & { lastQuestionAnswer?: string })
          .lastQuestionAnswer,
    );

  await ask("selection-preset");
  await expect(preset).toBeVisible();
  const second = question.getByRole("button", { name: "Draft a new outline" });
  await preset.focus();
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await expect(second).toHaveCSS("outline-style", "none");
  await expect(second.locator("..")).toHaveCSS("outline-offset", "-3px");
  await page.keyboard.press("ArrowUp");
  await expect(preset).toBeFocused();
  await expect(preset).toHaveCSS("outline-style", "none");
  await expect(preset.locator("..")).toHaveCSS("outline-offset", "-3px");
  await question.screenshot({
    path: test.info().outputPath("question-keyboard-focus.png"),
  });
  const form = question.locator("form");
  const formHeight = async () => (await form.boundingBox())!.height;
  const emptyHeight = await formHeight();
  expect(emptyHeight).toBe(52);
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await expect(customSelection).toBeVisible();
  await expect(draftSelection).toHaveCount(0);
  await expect.poll(formHeight).toBe(64);
  const selectionHeight = await formHeight();
  const chipBox = (await customSelection.boundingBox())!;
  expect(chipBox.y + chipBox.height).toBeLessThan(
    (await custom.boundingBox())!.y,
  );
  await customSelection.getByRole("button", { name: "Pin selection" }).click();
  await expect(customSelection).toHaveAttribute(
    "data-selection-pinned",
    "true",
  );
  await page.screenshot({
    path: test.info().outputPath("question-with-selection.png"),
  });
  await preset.click();
  await expect(question).toHaveCount(0);
  expect(await readAnswer()).toBe("Use the existing outline");
  await expect(draftSelection).toBeVisible();

  await ask("selection-custom");
  const addComment = page.getByRole("button", {
    name: "Add comment H-8 to chat",
    exact: true,
  });
  const customComment = question.locator("form [data-comment-chip]");
  await addComment.click();
  await expect(customComment).toBeVisible();
  await expect.poll(formHeight).toBeGreaterThan(selectionHeight);
  await customComment.getByRole("button", { name: "Remove context" }).click();
  await expect(customComment).toHaveCount(0);
  await expect.poll(formHeight).toBe(selectionHeight);
  await expect(question).toBeVisible();
  await addComment.click();
  await expect(customComment).toBeVisible();
  await custom.fill("Use this as a reference.");
  await custom.press("Enter");
  await expect(question).toHaveCount(0);
  const answer = await readAnswer();
  expect(answer).toContain("[Selected text]");
  expect(answer).toContain("Text:\n\\documentclass[12pt]");
  expect(answer).toContain("[Attached comment — snapshot]");
  expect(answer).toContain("Describe the problem and main finding.");
  expect(answer).toContain("[User request]\nUse this as a reference.");

  await ask("selection-skip");
  await expect(customSelection).toBeVisible();
  await question.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(question).toHaveCount(0);
  expect(await readAnswer()).toBe("Skip this question (no option selected).");
});

test("Duet workspace editor cards select, switch, and clear comment focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-editor").first().waitFor();
  // Let the fixture's initial settings and workspace layout settle.
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Duet", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(800);
  await page
    .getByRole("tablist", { name: "Chat workspace content" })
    .getByRole("tab", { name: "Editor", exact: true })
    .press("Enter");
  const editor = page.locator(".cm-editor").first();
  await expect
    .poll(async () => (await editor.boundingBox())?.width ?? 0)
    .toBeGreaterThan(400);
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  const agent = editor.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  const human = editor.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
  );
  const chips = page
    .locator('[data-comment-chip="true"]')
    .filter({ visible: true });
  await agent.click({ position: { x: 6, y: 6 } });
  await expect(agent).toHaveClass(/cm-inlineCommentSelected/);
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("@A-7");
  await human.click({ position: { x: 6, y: 6 } });
  await expect(human).toHaveClass(/cm-inlineCommentSelected/);
  await expect(agent).not.toHaveClass(/cm-inlineCommentSelected/);
  await expect(chips).toContainText("@H-1");
  await expect(
    page.getByRole("tab", { name: "Duet", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.screenshot({
    path: test.info().outputPath("vibe-comment-focused.png"),
  });
  await editor.locator(".cm-line").first().click();
  await expect(human).not.toHaveClass(/cm-inlineCommentSelected/);
  await expect(chips).toHaveCount(0);
});

test("comments attach beneath selections, pin, replace, remove and send their identities", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toBeVisible();
  await editor.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const chips = drawer.locator('[data-comment-chip="true"]');
  const selection = drawer.locator('[data-selection-chip="true"]');
  await expect(selection).toHaveCount(1);
  await editor
    .getByRole("button", { name: "Add comment H-1 to chat", exact: true })
    .click();
  await expect(selection).toHaveCount(0);
  await expect(chips).toHaveCount(1);
  await editor.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await expect(selection).toHaveCount(1);
  await expect(chips).toHaveCount(0);
  await selection
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await editor
    .getByRole("button", { name: "Add comment A-7 to chat", exact: true })
    .click();
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("A-7");
  expect(
    await chips.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(114, 82, 181)");
  await expect(selection).toHaveCount(1);
  expect((await chips.boundingBox())!.y).toBeGreaterThan(
    (await selection.boundingBox())!.y,
  );
  await chips.getByRole("button", { name: "Pin comment", exact: true }).click();
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await editor
    .getByRole("button", { name: "Add comment H-1 to chat", exact: true })
    .click();
  await expect(chips).toHaveCount(2);
  expect(
    await chips.last().evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgb(234, 179, 8)");
  await editor
    .getByRole("button", { name: "Add comment H-3 to chat", exact: true })
    .click();
  await expect(chips).toHaveCount(2);
  await expect(chips.last()).toContainText("H-3");
  await chips.last().getByRole("button", { name: "Remove context" }).click();
  await expect(chips).toHaveCount(1);
  await chips.first().click();
  await expect(
    editor.locator('[data-inline-comment-id="A-7"].cm-inlineCommentCard'),
  ).toBeInViewport();
  await expect(selection).toHaveCount(1);
  await page.screenshot({ path: "test-results/comment-chat-pinned.png" });
  const draft = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const state = useAgentChatStore.getState();
    return state.tabs.find((t: { id: string }) => t.id === state.activeTabId)
      .draft;
  });
  expect(
    draft.pinnedContexts.find((c: { comment?: { id: string } }) => c.comment)
      ?.comment.id,
  ).toBe("A-7");
  const originalTab = await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const id = useAgentChatStore.getState().activeTabId;
    useAgentChatStore.getState().createTab();
    return id;
  });
  await expect(chips).toHaveCount(0);
  await page.evaluate(async (id) => {
    // @ts-expect-error Vite browser module
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.getState().setActiveTab(id);
  }, originalTab);
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser module
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    // @ts-expect-error Vite browser module
    const { useCodexSetupStore } = await import(
      "/src/renderer/stores/codex-setup-store.ts"
    );
    useCodexSetupStore.setState({
      status: "ready",
      modelsStatus: "ready",
      models: [
        {
          model: "fixture",
          display_name: "Fixture",
          description: "",
          supported_reasoning_efforts: [{ value: "medium", description: "" }],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ],
    });
    useAgentChatStore.setState({
      selectedCodexModel: "fixture",
      sendPrompt: async (prompt: string, context: unknown) => {
        document.body.dataset.sentCommentContext = JSON.stringify({
          prompt,
          context,
        });
      },
    });
  });
  await drawer.locator("textarea").fill("Resolve this comment");
  await drawer.locator("textarea").press("Enter");
  await expect
    .poll(() => page.evaluate(() => document.body.dataset.sentCommentContext))
    .toBeTruthy();
  const sent = await page.evaluate(() =>
    JSON.parse(document.body.dataset.sentCommentContext!),
  );
  expect(sent.prompt).toBe("Resolve this comment");
  expect(sent.context).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filePath: "manuscript.md",
        comment: expect.objectContaining({ id: "A-7", agent: true }),
      }),
      expect.objectContaining({
        label: expect.stringMatching(/^@manuscript.md:/),
      }),
    ]),
  );
  await expect(chips).toHaveCount(0);
});

test("a PDF comment can be attached from its preview card", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/?debug=pdf-comments&mode=duet");
  await page
    .getByRole("button", { name: "Toggle chat drawer", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const passage = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(passage).toBeVisible();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await expect(async () => {
    const box = await passage.boundingBox();
    await page.mouse.click(box!.x + 4, box!.y + box!.height / 2);
    await expect(card).toBeVisible({ timeout: 500 });
  }).toPass();
  const chip = page.locator(
    '[data-chat-drawer-panel="true"] [data-comment-chip="true"]',
  );
  const focusBox = page.getByTestId("pdf-comment-focus-box");
  const commentCard = card.locator(".cm-inlineCommentCard");
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText("chapter.tex");
  await expect(focusBox).toHaveCount(1);
  await expect(focusBox).toHaveCSS("outline-style", "dashed");
  await expect(focusBox).toHaveCSS("outline-offset", "2px");
  await expect(commentCard).toHaveClass(/cm-inlineCommentSelected/);
  await chip.getByRole("button", { name: "Remove context" }).click();
  await expect(focusBox).toHaveCount(0);
  await expect(commentCard).not.toHaveClass(/cm-inlineCommentSelected/);
  await card.getByRole("button", { name: /Add comment .* to chat/ }).click();
  await expect(chip).toHaveCount(1);
  await expect(focusBox).toHaveCount(1);
  await expect(commentCard).toHaveClass(/cm-inlineCommentSelected/);
  await page.locator('[data-chat-drawer-panel="true"]').evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: "test-results/comment-chat-pdf.png" });
  await page
    .locator('[data-testid="pdf-scroll-container"]')
    .click({ position: { x: 20, y: 20 } });
  await expect(chip).toHaveCount(0);
  await expect(focusBox).toHaveCount(0);
});

test("selecting annotated text attaches its comments alongside the excerpt", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const editor = page.locator(".cm-editor").first();
  await expect(editor).toBeVisible();
  await editor.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ControlOrMeta+Shift+End");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const selection = drawer.locator('[data-selection-chip="true"]');
  const comments = drawer.locator('[data-comment-chip="true"]');
  await expect(selection).toHaveCount(1);
  await expect(comments).toHaveCount(5);
  expect((await comments.first().boundingBox())!.y).toBeGreaterThan(
    (await selection.boundingBox())!.y,
  );
  await drawer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({
    path: "test-results/comment-chat-text-and-comments.png",
  });
  await page.keyboard.press("ArrowLeft");
  await expect(selection).toHaveCount(0);
  await expect(comments).toHaveCount(0);
});

test("read-only comment cards select from their padding and show chat selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  const editor = page.locator(".cm-editor").first();
  const first = editor.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  const second = editor.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="H-1"]',
  );
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const chips = drawer.locator('[data-comment-chip="true"]');
  await first.click({ position: { x: 6, y: 6 } });
  await expect(chips).toHaveCount(1);
  await expect(drawer.locator('[data-selection-chip="true"]')).toHaveCount(0);
  await expect(first).toHaveClass(/cm-inlineCommentSelected/);
  await expect(first.locator(".cm-inlineCommentAttach")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await second.click({ position: { x: 6, y: 6 } });
  await expect(second).toHaveClass(/cm-inlineCommentSelected/);
  await expect(first).not.toHaveClass(/cm-inlineCommentSelected/);
  await expect(chips).toHaveCount(1);
  await drawer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  await page.screenshot({ path: "test-results/comment-card-selected.png" });
  await chips.getByRole("button", { name: "Remove context" }).click();
  await expect(second).not.toHaveClass(/cm-inlineCommentSelected/);
  await second
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await expect(second.locator(".cm-inlineCommentAttach")).toHaveCount(0);
  await second
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Updated baseline question");
  await expect(chips).toHaveCount(0);
  await second
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect(second.locator(".cm-inlineCommentAttach")).toHaveCount(1);
  await second.locator(".cm-inlineCommentAttach").focus();
  await page.keyboard.press("Enter");
  await expect(chips).toHaveCount(1);
  await expect(second).toHaveClass(/cm-inlineCommentSelected/);
});

test("comment selection stays in the compact drawer and clears on a cursor click", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  const editor = page.locator(".cm-editor").first();
  const card = editor.locator(
    '.cm-inlineCommentCard[data-inline-comment-id="A-7"]',
  );
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const chip = drawer.locator('[data-comment-chip="true"]');
  const line = editor.locator(".cm-line").first();
  await expect(card).toBeVisible();
  await editor.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  const textChip = drawer.locator('[data-selection-chip="true"]');
  await expect(textChip).toHaveCount(1);
  await drawer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    );
  });
  const textHeight = (await drawer.boundingBox())!.height;
  await card.click({ position: { x: 6, y: 6 } });
  await expect(chip).toHaveCount(1);
  await expect(textChip).toHaveCount(0);
  await expect(drawer.locator("textarea")).not.toBeFocused();
  await drawer.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((a) => a.finished.catch(() => {})),
    );
  });
  expect(
    Math.abs((await drawer.boundingBox())!.height - textHeight),
  ).toBeLessThan(3);
  await expect(card).toHaveCSS("outline-style", "none");
  const colors = await card.evaluate((el) => ({
    stroke: getComputedStyle(el.querySelector(".cm-inlineCommentAttach")!)
      .boxShadow,
    button: getComputedStyle(el.querySelector(".cm-inlineCommentButton")!)
      .backgroundColor,
  }));
  expect(colors.stroke).toContain("inset");
  expect(colors.stroke).toContain(colors.button);
  await page.screenshot({ path: "test-results/comment-card-inset.png" });
  await line.click();
  await expect(chip).toHaveCount(0);
  await expect(card).not.toHaveClass(/cm-inlineCommentSelected/);
  await expect(drawer.locator("textarea")).not.toBeFocused();
  await card.click({ position: { x: 6, y: 6 } });
  await chip.getByRole("button", { name: "Pin comment", exact: true }).click();
  await line.click();
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-selection-pinned", "true");
});

test("comment toolbar navigation selects the card and chat badge", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  const panel = page.locator('[data-comments-panel="true"]').first();
  await panel
    .getByRole("button", { name: "Go to comment A-7", exact: true })
    .click();
  await expect(
    page.locator(
      '.cm-editor .cm-inlineCommentCard[data-inline-comment-id="A-7"]',
    ),
  ).toHaveClass(/cm-inlineCommentSelected/);
  const chips = page.locator('[data-comment-chip="true"]');
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("@A-7");
  await panel
    .getByRole("button", { name: "Next comment", exact: true })
    .click();
  await expect(
    page.locator(
      '.cm-editor .cm-inlineCommentCard[data-inline-comment-id="H-1"]',
    ),
  ).toHaveClass(/cm-inlineCommentSelected/);
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText("@H-1");
  await page.screenshot({
    path: test.info().outputPath("toolbar-selected.png"),
  });
});

test("Markdown preview cards follow chat comment selection without a width toggle", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace");
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "Preview", exact: true })
    .click();
  const toolbar = page.locator('[data-comments-panel="true"]').last();
  await toolbar
    .getByRole("button", { name: "Go to comment A-7", exact: true })
    .click();
  const popup = page.getByRole("dialog", { name: "PDF comment", exact: true });
  const card = popup.locator(".cm-inlineCommentCard");
  await expect(card).toHaveClass(/cm-inlineCommentSelected/);
  await expect(card.locator(".cm-inlineCommentBadge")).toHaveCSS(
    "background-color",
    "rgb(255, 250, 255)",
  );
  await expect(
    popup.getByRole("button", { name: "Full comment width" }),
  ).toHaveCount(0);
  const chip = page.locator('[data-comment-chip="true"]');
  await expect(chip).toContainText("@A-7");
  await page.screenshot({
    path: test.info().outputPath("markdown-selected.png"),
  });
  await chip.getByRole("button", { name: "Remove context" }).click();
  await expect(
    page.locator(".inline-comment-popup .cm-inlineCommentSelected"),
  ).toHaveCount(0);
  await expect(chip).toHaveCount(0);
});

for (const action of ["resolve", "delete"] as const) {
  for (const pinned of [false, true]) {
    test(`${action} removes ${pinned ? "pinned" : "live"} comment badges from drafts`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto("/?debug=comment-workspace");
      const editor = page.locator(".cm-editor").first();
      const chips = page.locator(
        '[data-chat-drawer-panel="true"] [data-comment-chip="true"]',
      );
      await editor
        .getByRole("button", { name: "Add comment A-7 to chat", exact: true })
        .click();
      await expect(chips).toHaveCount(1);
      if (pinned)
        await chips
          .getByRole("button", { name: "Pin comment", exact: true })
          .click();
      await page.evaluate(async (action) => {
        // @ts-expect-error Vite browser module
        const { useAgentChatStore } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        const state = useAgentChatStore.getState();
        const active = state.tabs.find(
          (tab: { id: string }) => tab.id === state.activeTabId,
        );
        useAgentChatStore.setState({
          tabs: [
            ...state.tabs,
            {
              ...active,
              id: "inactive-draft",
              draft: { ...active.draft, input: "Keep this draft" },
            },
          ],
        });
        // @ts-expect-error Vite browser module
        const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
        const projectRoot = "/browser-demo/Comment Review";
        const before = JSON.parse(
          localStorage.getItem(`catalex-harness-comments:${projectRoot}`)!,
        )["manuscript.md"].find((c: { id: string }) => c.id === "A-7");
        await invoke("update_project_comment", {
          projectRoot,
          patch: {
            filePath: "manuscript.md",
            id: before.id,
            before,
            after: action === "resolve" ? { ...before, resolved: true } : null,
          },
        });
      }, action);
      await expect(chips).toHaveCount(0);
      const drafts = await page.evaluate(async () => {
        // @ts-expect-error Vite browser module
        const { useAgentChatStore } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        // @ts-expect-error Vite browser module
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        return {
          drafts: useAgentChatStore
            .getState()
            .tabs.map((tab: { draft: unknown }) => tab.draft),
          live: useDocumentStore.getState().commentSelectionContext,
        };
      });
      expect(drafts.live).toBeNull();
      expect(
        drafts.drafts.every(
          (draft: { pinnedContexts: unknown[] }) =>
            draft.pinnedContexts.length === 0,
        ),
      ).toBe(true);
      expect(drafts.drafts.at(-1).input).toBe("Keep this draft");
      await page.screenshot({
        path: test.info().outputPath(`${action}-${pinned}.png`),
      });
    });
  }
}

for (const action of ["Resolve comment", "Delete comment"]) {
  test(`${action} in the editor removes a pinned badge`, async ({ page }) => {
    await page.goto("/?debug=comment-workspace");
    const card = page
      .locator('.cm-editor .cm-inlineCommentCard[data-inline-comment-id="A-7"]')
      .first();
    await card
      .getByRole("button", { name: "Add comment A-7 to chat", exact: true })
      .click();
    const chips = page.locator(
      '[data-chat-drawer-panel="true"] [data-comment-chip="true"]',
    );
    await chips
      .getByRole("button", { name: "Pin comment", exact: true })
      .click();
    await card.getByRole("button", { name: action, exact: true }).click();
    await card
      .getByRole("button", {
        name: `Confirm ${action.toLowerCase()}`,
        exact: true,
      })
      .click();
    await expect(chips).toHaveCount(0);
  });
}
