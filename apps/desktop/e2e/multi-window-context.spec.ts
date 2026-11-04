import { expect, type Page, test } from "@playwright/test";

async function stores(page: Page) {
  await page.evaluate(async () => {
    const url = (path: string) =>
      performance
        .getEntriesByType("resource")
        .find((entry) => new URL(entry.name).pathname === path)?.name ?? path;
    const { useAgentChatStore: chat } = await import(
      /* @vite-ignore */ url("/src/renderer/stores/agent-chat-store.ts")
    );
    const { useDocumentStore: doc } = await import(
      /* @vite-ignore */ url("/src/renderer/stores/document-store.ts")
    );
    const { openPanelWindow: open } = await import(
      /* @vite-ignore */ url("/src/renderer/lib/panel-windows.ts")
    );
    const { useAgentReviewQueueStore: reviews } = await import(
      /* @vite-ignore */ url("/src/renderer/stores/agent-review-queue-store.ts")
    );
    Object.assign(window, { panelTest: { chat, doc, open, reviews } });
  });
}
async function open(page: Page, kind: string, id?: string) {
  const opened = page.waitForEvent("popup");
  await page.evaluate(
    ({ kind, id }) => {
      const { chat, doc, open } = (window as any).panelTest;
      if (id)
        (kind === "chat"
          ? chat.getState().setActiveTab
          : doc.getState().setActiveFile)(id);
      open(kind, "duet");
    },
    { kind, id },
  );
  const child = await opened;
  await expect(child.locator("[data-panel-window-title]")).toBeVisible();
  return child;
}
async function selectEditor(page: Page) {
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("Shift+End");
  await expect(page.locator("[data-selection-toolbar]")).toBeVisible();
}
async function selectPdf(page: Page) {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(line).toBeVisible();
  await line.evaluate((element) => {
    const node = element.firstChild!;
    const start = node.textContent!.indexOf("Your");
    window
      .getSelection()!
      .setBaseAndExtent(
        node,
        start,
        node,
        start + "Your abstract here.".length,
      );
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

for (const source of ["editor", "pdf"] as const) {
  test(`${source} selection reaches every open chat but Proofread only targets the main chat`, async ({
    page,
  }) => {
    await page.goto("/?debug=comment-workspace&pdf");
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    await stores(page);
    await page.evaluate(() => {
      const { chat } = (window as any).panelTest;
      const original = chat.getState().tabs[0];
      (window as any).requests = [];
      chat.setState({
        tabs: ["main", "other", "third"].map((id) => ({
          ...original,
          id,
          runtimeSessionKey: id,
          title: id,
          draft: { input: "", pinnedContexts: [] },
        })),
        activeTabId: "main",
        sendPrompt: (prompt: string, context: unknown) =>
          (window as any).requests.push({
            tab: chat.getState().activeTabId,
            prompt,
            context,
          }),
      });
    });
    const other = await open(page, "chat", "other");
    const third = await open(page, "chat", "third");
    await page.evaluate(() =>
      (window as any).panelTest.chat.getState().setActiveTab("main"),
    );
    if (source === "editor") await selectEditor(page);
    else await selectPdf(page);
    const chip = (target: Page) =>
      target.locator('[data-selection-chip="true"]:visible');
    await expect(chip(other)).toHaveCount(1);
    await expect(chip(third)).toHaveCount(1);
    const selection = await page.evaluate(() => {
      const doc = (window as any).panelTest.doc.getState();
      return { editor: doc.selectionRange, pdf: doc.pdfSelectionContext };
    });
    await page.locator("[data-selection-toolbar]").hover();
    await page.getByRole("button", { name: "Proofread", exact: true }).click();
    expect(await page.evaluate(() => (window as any).requests)).toEqual([
      expect.objectContaining({
        tab: "main",
        prompt: "Proofread and fix any errors in this text",
        context: expect.objectContaining({ selectedText: expect.any(String) }),
      }),
    ]);
    await expect(chip(other)).toHaveCount(1);
    await expect(chip(third)).toHaveCount(1);
    expect(
      await page.evaluate(() => {
        const doc = (window as any).panelTest.doc.getState();
        return { editor: doc.selectionRange, pdf: doc.pdfSelectionContext };
      }),
    ).toEqual(selection);
    await chip(other)
      .getByRole("button", { name: "Pin selection", exact: true })
      .click();
    await page.evaluate(() => {
      const doc = (window as any).panelTest.doc.getState();
      doc.setSelectionRange(null);
      doc.setPdfSelectionContext(null);
    });
    await expect(chip(other)).toHaveCount(1);
    await expect(chip(third)).toHaveCount(0);
    await other.screenshot({
      path: test.info().outputPath("pinned-context.png"),
    });
    await other.close();
    await third.close();
  });
}

test("reference editor and PDF windows keep comments without agent-send actions", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await stores(page);
  const editor = await open(page, "editor");
  await selectEditor(editor);
  await expect(
    editor.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /Proofread|Fix Selected Issues/ }),
  ).toHaveCount(0);
  const pdf = await open(page, "preview");
  await selectPdf(pdf);
  await expect(
    pdf.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(
    pdf.getByRole("button", { name: "Proofread", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const doc = (window as any).panelTest.doc.getState();
      return { editor: doc.selectionRange, pdf: doc.pdfSelectionContext };
    }),
  ).toEqual({ editor: null, pdf: null });
  await page.evaluate(() => {
    const { doc } = (window as any).panelTest;
    doc
      .getState()
      .setCompileError(
        "Compilation failed: test error",
        doc.getState().activeFileId,
      );
  });
  await expect(
    pdf.getByText("Compilation Failed", { exact: true }),
  ).toBeVisible();
  await expect(
    pdf.getByRole("button", { name: "Fix with Chat", exact: true }),
  ).toHaveCount(0);
  await expect(
    pdf.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await editor.screenshot({
    path: test.info().outputPath("reference-editor.png"),
  });
  await editor.close();
  await pdf.close();
});

test("a pinned editor survives source-to-review transitions and applies its shared proposal", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview");
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await stores(page);
  await page.evaluate(async () =>
    (window as any).panelTest.doc.getState().restoreSourceWorkspace(),
  );
  const editor = await open(page, "editor", "manuscript.md");
  await page.evaluate(async () =>
    (window as any).panelTest.reviews.getState().show("figure-review"),
  );
  await expect(editor.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.evaluate(() =>
    (window as any).panelTest.doc.getState().setActiveFile("results.png"),
  );
  await expect(editor.locator("[data-panel-window-title]")).toHaveText(
    "manuscript.md",
  );
  await editor
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: /Accept All/ })
    .click();
  await expect(editor.locator("[data-proposed-changes-panel]")).toHaveCount(0);
  await expect(editor.locator(".cm-content")).toBeVisible();
  expect(editor.isClosed()).toBe(false);
  await editor.screenshot({
    path: test.info().outputPath("accepted-editor.png"),
  });
  await editor.close();
});

for (const decision of ["accept", "reject", "failure"] as const) {
  test(`a deletion pop-out stays open until successful acceptance: ${decision}`, async ({
    page,
  }) => {
    await page.goto("/?debug=agent-file-review&extras");
    await expect(page.locator("[data-agent-file-review]")).toBeVisible();
    await stores(page);
    await page.evaluate(async () =>
      (window as any).panelTest.doc.getState().restoreSourceWorkspace(),
    );
    const editor = await open(page, "editor", "removed.png");
    await page.evaluate(async () =>
      (window as any).panelTest.reviews.getState().show("figure-review"),
    );
    await expect(
      editor.getByRole("button", { name: "Accept deletion", exact: true }),
    ).toBeVisible();
    await page.evaluate((fail) => {
      const bridge = (window as any).__TAURI_INTERNALS__;
      const invoke = bridge.invoke;
      bridge.invoke = async (
        command: string,
        args: unknown,
        options: unknown,
      ) => {
        if (command === "apply_agent_workspace") {
          await new Promise<void>((resolve) => {
            (window as any).releaseDecision = resolve;
          });
          if (fail) throw new Error("Test deletion failed");
        }
        return invoke(command, args, options);
      };
    }, decision === "failure");
    await editor
      .getByRole("button", {
        name: decision === "reject" ? "Keep file" : "Accept deletion",
        exact: true,
      })
      .click();
    await expect
      .poll(() => page.evaluate(() => !!(window as any).releaseDecision))
      .toBe(true);
    expect(editor.isClosed()).toBe(false);
    const closed = decision === "accept" ? editor.waitForEvent("close") : null;
    await page.evaluate(() => (window as any).releaseDecision());
    if (closed) await closed;
    else {
      if (decision === "failure")
        await expect(editor.getByRole("alert")).toContainText(
          "Test deletion failed",
        );
      else
        await expect(
          editor.getByRole("button", { name: "Keep file", exact: true }),
        ).toHaveCount(0);
      expect(editor.isClosed()).toBe(false);
      await editor.close();
    }
  });
}

test("edits during review remain synchronized between the main editor and its pop-out", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview");
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await stores(page);
  const editor = await open(page, "editor", "manuscript.md");
  await expect(editor.locator("[data-proposed-changes-panel]")).toBeVisible();
  await editor.locator(".cm-content").focus();
  await editor.keyboard.press("ControlOrMeta+Home");
  await editor.keyboard.insertText("Shared review edit. ");
  await expect(page.locator(".cm-content")).toContainText(
    "Shared review edit.",
  );
  await page.locator(".cm-content").focus();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\nAnother shared edit.");
  await editor.locator(".cm-content").focus();
  await editor.keyboard.press("ControlOrMeta+End");
  await expect(editor.locator(".cm-content")).toContainText(
    "Another shared edit.",
  );
  await editor.close();
});

test("accepting one review block in a pop-out updates the shared review baseline", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview");
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await stores(page);
  const editor = await open(page, "editor", "manuscript.md");
  const summary = (target: Page) =>
    target.locator("[data-proposed-changes-panel]");
  const initial = (await summary(page).textContent())!;
  await editor
    .locator('.cm-chunkButtons button[name="accept"]')
    .first()
    .click();
  await expect(summary(page)).not.toHaveText(initial);
  const remaining = (await summary(page).textContent())!;
  await expect(summary(editor)).toHaveText(remaining);
  await expect(summary(page)).toBeVisible();
  await editor.screenshot({
    path: test.info().outputPath("partial-review.png"),
  });
  await editor.close();
});
