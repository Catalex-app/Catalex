import { expect, test } from "@playwright/test";

test("text editors label LaTeX support files and retain live statistics and overflow", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".cm-content")).toBeVisible();
  const cases = [
    ["references.BIB", "BibTeX"],
    ["plain.bst", "BibTeX style"],
    ["local.sty", "LaTeX package"],
    ["journal.cls", "LaTeX class"],
    ["options.clo", "LaTeX class options"],
    ["symbols.def", "TeX definitions"],
    ["settings.cfg", "Configuration"],
    ["fonts.fd", "LaTeX font definitions"],
    ["package.dtx", "Documented LaTeX source"],
    ["package.ins", "LaTeX installer"],
    ["style.bbx", "BibLaTeX bibliography style"],
    ["style.cbx", "BibLaTeX citation style"],
    ["locale.lbx", "BibLaTeX localization"],
    ["index.ist", "MakeIndex style"],
    ["index.xdy", "Xindy style"],
    [".latexmkrc", "Latexmk configuration"],
    ["settings.json", "JSON"],
    ["notes.unknown", "Text editor"],
    ["README", "Text editor"],
  ];
  await page.evaluate(
    async (names) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const { getFileType } = await import(
        "/src/renderer/lib/project-files.ts"
      );
      useDocumentStore.setState((state) => ({
        files: [
          ...state.files,
          ...names.map((name) => ({
            id: name,
            name,
            relativePath: name,
            absolutePath: `${state.projectRoot}/${name}`,
            type: getFileType(name)!,
            content: "alpha beta",
            isDirty: false,
          })),
        ],
      }));
    },
    cases.map(([name]) => name),
  );
  for (const [name, label] of cases) {
    await page.evaluate(async (name) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.getState().setActiveFile(name);
    }, name);
    await expect(page.locator("[data-editor-type-label]")).toHaveText(label);
    await expect(page.getByTestId("text-word-count")).toHaveText("2 words");
    await expect(page.getByTestId("text-character-count")).toHaveText(
      "10 chars",
    );
    await expect(
      page.getByRole("button", {
        name: "More Editor view actions",
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("plain.bst");
  });
  const typeArea = page.locator("[data-editor-type-label]");
  const expanded = page.getByRole("dialog", { name: "Editor expanded" });
  // Most blank space belongs to the growing type-label container, not the
  // dedicated 56px strip. Both must support expand and restore.
  await typeArea.dblclick();
  await expect(expanded).toBeVisible();
  await typeArea.dblclick();
  await expect(expanded).toHaveCount(0);
  await page.getByTestId("text-editor-statistics").dblclick();
  await expect(expanded).toHaveCount(0);
  const reservedSpace = page
    .getByTestId("text-editor-toolbar")
    .locator("[data-panel-header-space]");
  await reservedSpace.dblclick();
  await expect(expanded).toBeVisible();
  await reservedSpace.dblclick();
  await expect(expanded).toHaveCount(0);
  const opened = page.waitForEvent("popup");
  await typeArea.dblclick({ modifiers: ["Alt"] });
  const popout = await opened;
  await expect(popout.locator(".cm-content")).toContainText("alpha beta");
  await popout.close();
  const editor = page.locator(".cm-content");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText("alpha beta gamma");
  await expect(page.getByTestId("text-word-count")).toHaveText("3 words");
  await expect(page.getByTestId("text-character-count")).toHaveText("16 chars");
  await page.keyboard.press("ControlOrMeta+a");
  await expect(page.getByTestId("text-word-count")).toHaveText("3/3 words");
  await expect(page.getByTestId("text-character-count")).toHaveText(
    "16/16 chars",
  );
  const header = page.getByTestId("text-editor-toolbar");
  await header.screenshot({
    path: testInfo.outputPath("bst-header.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 520, height: 900 });
  await expect(header).toHaveAttribute(
    "data-editor-statistics-overflow",
    "true",
  );
  await expect(page.getByTestId("text-editor-statistics")).not.toBeVisible();
  await header
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await expect(page.locator("[data-editor-statistics-menu]")).toContainText(
    "3/3",
  );
  await expect(page.locator("[data-editor-statistics-menu]")).toContainText(
    "16/16",
  );
  await page.getByRole("menu").screenshot({
    path: testInfo.outputPath("bst-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.getByTestId("text-editor-statistics")).toBeVisible();
});

for (const kind of ["markdown", "latex"] as const) {
  test(`${kind} formatting follows editability, not panel focus or background agent work`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(
      `/?debug=comment-workspace${kind === "latex" ? "&pdf" : ""}`,
    );
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await page.getByRole("tab", { name: "Editor", exact: true }).click();
    const header = page.getByTestId(`${kind}-editor-toolbar`);
    const setMode = (mode: string) =>
      page.evaluate(async (mode) => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const { useAgentChatStore } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        useDocumentStore.setState({
          isApplyingAgentDraft: mode === "applying",
          isAgentWorkspaceReadOnly: mode === "readonly",
        });
        useAgentChatStore
          .getState()
          ._setStreaming(
            useAgentChatStore.getState().activeTabId,
            mode === "working",
          );
      }, mode);
    const bold = header.getByRole("button", { name: "Bold", exact: true });
    const heading = header.getByRole("button", {
      name: kind === "latex" ? "Sectioning command" : "Heading style",
      exact: true,
    });
    const content = () =>
      page.evaluate(async () => {
        const { EditorView } = await import(
          "/node_modules/.vite/deps/@codemirror_view.js"
        );
        return EditorView.findFromDOM(
          document.querySelector(".cm-content")!,
        )!.state.doc.toString();
      });
    const before = await content();
    for (const mode of ["working", "applying", "readonly", "editable"]) {
      await setMode(mode);
      await page
        .getByText("Browser demo · Comment Review", { exact: true })
        .click();
      // Clicking outside the editor must not disable its toolbar.
      if (mode === "working" || mode === "editable") {
        await expect(bold).toBeEnabled();
        await expect(heading).toBeEnabled();
      } else {
        await expect(bold).toBeDisabled();
        await expect(heading).toBeDisabled();
        await bold.evaluate((button: HTMLButtonElement) => button.click());
        await expect.poll(content).toBe(before);
      }
    }
    await setMode("applying");
    await header.screenshot({
      path: testInfo.outputPath(`${kind}-readonly.png`),
    });
    await page.setViewportSize({ width: 680, height: 900 });
    const overflow = header.getByRole("button", {
      name: "Formatting options",
      exact: true,
    });
    await expect(overflow).toBeVisible();
    await expect(overflow).toBeDisabled();
    await setMode("editable");
    await overflow.click();
    const popover = page.getByRole("dialog", { name: "Formatting options" });
    const overflowBold = popover.getByRole("button", {
      name: "Bold",
      exact: true,
    });
    await expect(overflowBold).toBeEnabled();
    // An already-open compact toolbar must also update when applying starts.
    await setMode("applying");
    await expect(overflowBold).toBeDisabled();
    await overflowBold.evaluate((button: HTMLButtonElement) => button.click());
    await expect.poll(content).toBe(before);
    await setMode("editable");
    await expect(overflowBold).toBeEnabled();
    await overflowBold.click();
    await expect.poll(content).not.toBe(before);
  });
}
