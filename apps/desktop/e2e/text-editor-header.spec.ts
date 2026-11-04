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
        performance
          .getEntriesByType("resource")
          .find(
            (entry) =>
              new URL(entry.name).pathname ===
              "/src/renderer/stores/document-store.ts",
          )!.name
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
        performance
          .getEntriesByType("resource")
          .find(
            (entry) =>
              new URL(entry.name).pathname ===
              "/src/renderer/stores/document-store.ts",
          )!.name
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
      performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname ===
            "/src/renderer/stores/document-store.ts",
        )!.name
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
