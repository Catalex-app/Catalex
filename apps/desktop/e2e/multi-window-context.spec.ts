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
    const { useDocumentStore: doc, getPdfBytes: pdf } = await import(
      /* @vite-ignore */ url("/src/renderer/stores/document-store.ts")
    );
    const { openPanelWindow: open } = await import(
      /* @vite-ignore */ url("/src/renderer/lib/panel-windows.ts")
    );
    const { useAgentReviewQueueStore: reviews } = await import(
      /* @vite-ignore */ url("/src/renderer/stores/agent-review-queue-store.ts")
    );
    Object.assign(window, { panelTest: { chat, doc, open, reviews, pdf } });
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

test("included LaTeX files share one root preview while editors and other roots stay separate", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await stores(page);
  await page.evaluate(() => {
    const { doc } = (window as any).panelTest;
    const source = doc
      .getState()
      .files.find((file: any) => file.id === "sample.tex");
    doc.setState({
      files: [
        ...doc.getState().files,
        ...["intro.tex", "methods.tex", "supplement.tex"].map((id) => ({
          ...source,
          id,
          name: id,
          relativePath: id,
          content:
            id === "supplement.tex"
              ? "\\documentclass{article}\n\\begin{document}Supplement\\end{document}"
              : `% !TEX root = sample.tex\n${id} content.`,
        })),
      ],
    });
  });
  const preview = await open(page, "preview", "intro.tex");
  await expect(preview.locator("[data-panel-window-title]")).toHaveText(
    "sample.tex",
  );
  await expect(preview.locator(".mupdf-text-layer").first()).toBeVisible();
  const zoom = preview.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("125%");
  await zoom.press("Enter");
  const scroller = preview
    .getByTestId("pdf-scroll-container")
    .filter({ visible: true });
  await scroller.evaluate((element) => {
    element.scrollTop = 700;
  });
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(700);
  const windowCount = page.context().pages().length;
  // Observe focus calls as well as window count; reopening must not remount the viewer.
  await page.evaluate(() => {
    const session = [...window.__catalexPanelSessions!.values()].find(
      (s) => s.kind === "preview",
    )!;
    const focus = session.window!.focus.bind(session.window);
    (window as any).previewFocusCount = 0;
    session.window!.focus = () => {
      (window as any).previewFocusCount++;
      focus();
    };
  });
  for (const id of ["methods.tex", "sample.tex"]) {
    await page.evaluate((id) => {
      const { doc, open } = (window as any).panelTest;
      doc.getState().setActiveFile(id);
      open("preview", "duet");
    }, id);
    expect(page.context().pages()).toHaveLength(windowCount);
    await expect(zoom).toHaveValue("125%");
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(700);
  }
  expect(await page.evaluate(() => (window as any).previewFocusCount)).toBe(2);
  const supplement = await open(page, "preview", "supplement.tex");
  await expect(supplement.locator("[data-panel-window-title]")).toHaveText(
    "supplement.tex",
  );
  const intro = await open(page, "editor", "intro.tex");
  const methods = await open(page, "editor", "methods.tex");
  await expect(intro.locator("[data-panel-window-title]")).toHaveText(
    "intro.tex",
  );
  await expect(methods.locator("[data-panel-window-title]")).toHaveText(
    "methods.tex",
  );
  const introClosed = intro.waitForEvent("close");
  await page.evaluate(() => {
    const { doc } = (window as any).panelTest;
    doc.setState({
      files: doc
        .getState()
        .files.filter((file: any) => file.id !== "intro.tex"),
    });
  });
  await introClosed;
  expect(preview.isClosed()).toBe(false);
  await expect(preview.locator(".mupdf-text-layer").first()).toBeVisible();
  await preview.screenshot({
    path: test.info().outputPath("shared-root-preview.png"),
  });
  const previewClosed = preview.waitForEvent("close");
  await page.evaluate(() => {
    const { doc } = (window as any).panelTest;
    doc.setState({
      files: doc
        .getState()
        .files.filter((file: any) => file.id !== "sample.tex"),
    });
  });
  await previewClosed;
  expect(supplement.isClosed()).toBe(false);
  expect(methods.isClosed()).toBe(false);
  await supplement.close();
  await methods.close();
});

test("PDF excerpts from same-named roots retain distinct identities without source mapping", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await stores(page);
  await page.evaluate(() => {
    const { doc, pdf } = (window as any).panelTest;
    const bytes = pdf("sample.tex");
    const original = doc
      .getState()
      .files.find((file: any) => file.id === "sample.tex");
    const content =
      "\\documentclass{article}\n\\begin{document}No source match.\\end{document}";
    doc.setState({
      files: [
        ...doc
          .getState()
          .files.map((file: any) =>
            file.type === "tex" ? { ...file, content } : file,
          ),
        ...["papers/a/main.tex", "papers/b/main.tex"].map((id) => ({
          ...original,
          id,
          name: "main.tex",
          relativePath: id,
          content,
        })),
      ],
    });
    doc.getState().setPdfData(bytes, "papers/a/main.tex");
    doc.getState().setPdfData(bytes, "papers/b/main.tex");
  });
  const chat = await open(page, "chat");
  const a = await open(page, "preview", "papers/a/main.tex");
  const b = await open(page, "preview", "papers/b/main.tex");
  await page.evaluate(() =>
    (window as any).panelTest.doc.getState().setActiveFile("papers/a/main.tex"),
  );
  await selectPdf(page);
  const chips = chat.locator('[data-selection-chip="true"]');
  await expect(chips).toHaveCount(1);
  await selectPdf(a);
  await a.getByRole("button", { name: "Send to chat", exact: true }).click();
  // The same document and excerpt in the main window and pop-out remains one chip.
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute("data-selection-pinned", "true");
  await selectPdf(b);
  await b.getByRole("button", { name: "Send to chat", exact: true }).click();
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: "papers/a/main.tex" })).toHaveCount(1);
  await expect(chips.filter({ hasText: "papers/b/main.tex" })).toHaveCount(1);
  await selectPdf(a);
  await a.getByRole("button", { name: "Send to chat", exact: true }).click();
  await expect(chips).toHaveCount(2);
  const contexts = await page.evaluate(() =>
    JSON.parse(
      JSON.stringify(
        (window as any).panelTest.chat.getState().tabs[0].draft.pinnedContexts,
      ),
    ),
  );
  expect(
    contexts.map((context: any) => context.pdf.documentPath).sort(),
  ).toEqual(["papers/a/main.tex", "papers/b/main.tex"]);
  for (const context of contexts) {
    expect(context.pdf).toMatchObject({ kind: "compiled", page: 1 });
    expect(context.filePath).toBe(context.pdf.documentPath);
    expect(context.selectedText).toBe("Your abstract here.");
  }
  expect(contexts[0].selectionKey).not.toBe(contexts[1].selectionKey);
  await chat.screenshot({
    path: test.info().outputPath("distinct-pdf-excerpts.png"),
    animations: "disabled",
  });
  await a.close();
  await b.close();
  await chat.close();
});

for (const source of ["editor", "pdf"] as const) {
  test(`${source} shares main selection automatically and pins pop-out selection to one chat`, async ({
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
        tabs: ["main", "other", "third", "closed"].map((id) => ({
          ...original,
          id,
          runtimeSessionKey: id,
          title: id,
          draft: { input: `Draft for ${id}`, pinnedContexts: [] },
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
    const mainPopout = await open(page, "chat", "main");
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
    let toolbar = page.locator("[data-selection-toolbar]");
    await toolbar.hover();
    await expect(toolbar.getByRole("button")).toHaveCount(1);
    await expect(
      toolbar.getByRole("button", { name: "Send to chat", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`${source}-main-selection.png`),
      animations: "disabled",
    });
    await expect(
      toolbar.getByRole("button", { name: "Comment", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => (window as any).requests)).toEqual([]);
    await expect(chip(other)).toHaveCount(1);
    await expect(chip(third)).toHaveCount(1);
    expect(
      await page.evaluate(() => {
        const doc = (window as any).panelTest.doc.getState();
        return { editor: doc.selectionRange, pdf: doc.pdfSelectionContext };
      }),
    ).toEqual(selection);
    const reference = await open(
      page,
      source === "editor" ? "editor" : "preview",
    );
    if (source === "editor") await selectEditor(reference);
    else await selectPdf(reference);
    toolbar = reference.locator("[data-selection-toolbar]");
    await toolbar
      .getByRole("button", { name: "Send to chat", exact: true })
      .click();
    const menu = reference.getByRole("menu");
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await reference.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "Comment", exact: true }),
    ).toBeVisible();
    await reference.mouse.move(0, 0);
    await toolbar
      .getByRole("button", { name: "Send to chat", exact: true })
      .click();
    await expect(menu.getByRole("menuitem")).toHaveCount(3);
    await expect(
      menu.getByRole("menuitem", { name: "main Main & Pop-out", exact: true }),
    ).toBeVisible();
    await expect(
      menu.getByRole("menuitem", { name: "closed", exact: true }),
    ).toHaveCount(0);
    await expect(toolbar.getByRole("menu")).toHaveCount(1);
    await expect(reference.locator("[data-selection-toolbar]")).toHaveCount(1);
    await expect(
      reference.locator('[data-slot="dropdown-menu-content"]'),
    ).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "Comment", exact: true }),
    ).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "Back to selection actions" }),
    ).toBeVisible();
    const otherChoice = menu.getByRole("menuitem", {
      name: "other Pop-out",
      exact: true,
    });
    await otherChoice.hover();
    await reference.screenshot({
      path: test.info().outputPath(`${source}-send-menu.png`),
      animations: "disabled",
    });
    await menu
      .getByRole("menuitem", { name: "other Pop-out", exact: true })
      .click();
    // The main window's live selection can coexist with the pop-out excerpt.
    await expect(
      other.locator(
        '[data-selection-chip="true"][data-selection-pinned="true"]:visible',
      ),
    ).toHaveCount(1);
    const drafts = await page.evaluate(() => {
      const state = (window as any).panelTest.chat.getState();
      return {
        active: state.activeTabId,
        tabs: state.tabs.map((tab: any) => ({
          id: tab.id,
          input: tab.draft.input,
          pinned: tab.draft.pinnedContexts.filter(
            (context: any) => context.selectionPinned,
          ).length,
        })),
      };
    });
    expect(drafts.active).toBe("main");
    expect(drafts.tabs).toEqual(
      ["main", "other", "third", "closed"].map((id) => ({
        id,
        input: `Draft for ${id}`,
        pinned: id === "other" ? 1 : 0,
      })),
    );
    expect(await page.evaluate(() => (window as any).requests)).toEqual([]);
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
    await reference.close();
    await mainPopout.close();
    await other.close();
    await third.close();
  });
}

test("reference editor and PDF windows send pinned selections to the main chat", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await stores(page);
  const mainChat = await open(page, "chat");
  const editor = await open(page, "editor");
  await selectEditor(editor);
  const direct = editor.getByRole("button", {
    name: "Send to chat",
    exact: true,
  });
  await direct.hover();
  await expect(direct).toContainText("Main & Pop-out");
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await editor.screenshot({
    path: test.info().outputPath("send-direct.png"),
    animations: "disabled",
  });
  await direct.click();
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).panelTest.chat
            .getState()
            .tabs[0].draft.pinnedContexts.filter((c: any) => c.selectionPinned)
            .length,
      ),
    )
    .toBe(1);
  await expect(
    mainChat.locator(
      '[data-selection-chip="true"][data-selection-pinned="true"]',
    ),
  ).toHaveCount(1);
  await mainChat.close();
  await selectEditor(editor);
  await expect(direct).not.toContainText("Pop-out");
  await expect(
    editor.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("button", { name: /Proofread|Fix Selected Issues/ }),
  ).toHaveCount(0);
  const pdf = await open(page, "preview");
  await selectPdf(pdf);
  await pdf.getByRole("button", { name: "Send to chat", exact: true }).click();
  await expect(pdf.getByRole("menu")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).panelTest.chat
            .getState()
            .tabs[0].draft.pinnedContexts.filter((c: any) => c.selectionPinned)
            .length,
      ),
    )
    .toBe(2);
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

test("selection menu tracks open windows, status, and keyboard dismissal", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".cm-content")).toBeVisible();
  await stores(page);
  await page.evaluate(() => {
    const { chat } = (window as any).panelTest;
    const original = chat.getState().tabs[0];
    chat.setState({
      tabs: ["main", "other"].map((id) => ({
        ...original,
        id,
        title: id,
        pauseState: id === "other" ? "paused" : "idle",
        draft: { input: "", pinnedContexts: [] },
      })),
      activeTabId: "main",
    });
  });
  const other = await open(page, "chat", "other");
  await page.evaluate(() =>
    (window as any).panelTest.chat.getState().setActiveTab("main"),
  );
  const editor = await open(page, "editor");
  await selectEditor(editor);
  const trigger = editor.getByRole("button", {
    name: "Send to chat",
    exact: true,
  });
  await trigger.hover();
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await trigger.click();
  await expect(editor.getByRole("menuitem")).toHaveCount(2);
  await editor.getByRole("menuitem").last().hover();
  await editor
    .getByRole("button", { name: "Back to selection actions" })
    .hover();
  await editor.screenshot({
    path: test.info().outputPath("back-row.png"),
    animations: "disabled",
  });
  await editor.getByText("Send to chat", { exact: true }).click();
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect(
    editor.getByRole("button", { name: "Comment", exact: true }),
  ).toBeVisible();
  await expect(trigger).toBeVisible();
  await trigger.focus();
  await editor.keyboard.press("Enter");
  await expect(editor.getByRole("menuitem")).toHaveCount(2);
  await expect(
    editor.getByRole("img", { name: "Agent paused", exact: true }),
  ).toBeVisible();
  await editor.keyboard.press("ArrowDown");
  await expect(editor.getByRole("menuitem").last()).toBeFocused();
  await editor.keyboard.press("ArrowLeft");
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await editor.keyboard.press("Enter");
  await editor.keyboard.press("Escape");
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await editor.keyboard.press("Enter");
  await other.close();
  await expect(editor.getByRole("menu")).toHaveCount(0);
  await expect(trigger).toContainText("Main");
  await expect(trigger).toBeFocused();
  await editor.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).panelTest.chat
            .getState()
            .tabs[0].draft.pinnedContexts.filter((c: any) => c.selectionPinned)
            .length,
      ),
    )
    .toBe(1);
  await editor.close();
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

test("search in a PDF pop-out keeps its own query and Escape leaves it open", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await stores(page);
  const child = await open(page, "preview");
  const pdf = child.getByTestId("pdf-scroll-container");
  await expect(child.locator(".mupdf-text-layer").first()).toBeVisible();
  await pdf.focus();
  await child.keyboard.press("Control+f");
  const search = child.getByTestId("preview-search-panel");
  const input = search.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("evaluation");
  await expect(search).toContainText(/1\/\d+/);
  await child.keyboard.press("Escape");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("preview-search-panel")).toHaveCount(0);
  await search.getByRole("button", { name: "Close", exact: true }).click();
  await expect(search).toHaveCount(0);
  await child.keyboard.press("Control+f");
  await expect(input).toHaveValue("evaluation");
  await child.close();
});
