import { expect, test, type Page } from "@playwright/test";

async function switchFile(page: Page, file: string) {
  await page.evaluate(async (file) => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    useDocumentStore.getState().setActiveFile(file);
  }, file);
}

async function addSecondFile(page: Page) {
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    useDocumentStore.setState((state: any) => ({
      files: [
        ...state.files,
        {
          ...state.files[0],
          id: "second.tex",
          name: "second.tex",
          relativePath: "second.tex",
          absolutePath: "/tmp/harness/second.tex",
          content: "Second file",
          diskContent: "Second file",
        },
      ],
    }));
  });
}

test("each file keeps its own typing undo and redo when switching", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await addSecondFile(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("FIRST EDIT");
  await switchFile(page, "second.tex");
  await expect(editor).toHaveText("Second file");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("SECOND EDIT");
  await switchFile(page, "main.tex");
  await expect(editor).toContainText("FIRST EDIT");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("FIRST EDIT");
  await switchFile(page, "second.tex");
  await expect(editor).toContainText("SECOND EDIT");
  await switchFile(page, "main.tex");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor).toContainText("FIRST EDIT");
});

test("review decisions share undo with typing and survive a file switch", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1");
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await addSecondFile(page);
  await page.evaluate(async () => {
    const docPath = "/src/renderer/stores/document-store.ts";
    const proposalPath = "/src/renderer/stores/proposed-changes-store.ts";
    const { useDocumentStore } = await import(docPath);
    const { useProposedChangesStore } = await import(proposalPath);
    const oldContent =
      "header\nunchanged\npreamble\nold first\n\na\nb\nc\nd\ne\nf\n\nold last\n";
    useDocumentStore.getState().updateFileContent("main.tex", oldContent);
    useProposedChangesStore.getState().addChange({
      id: "undo-review",
      filePath: "main.tex",
      absolutePath: "/tmp/harness/main.tex",
      oldContent,
      newContent: oldContent
        .replace("old first", "new first")
        .replace("old last", "new last"),
      toolName: "Edit",
    });
  });
  const accept = page.locator('.cm-chunkButtons button[name="accept"]');
  await expect(accept).toHaveCount(2);
  await page.locator('.cm-chunkButtons button[name="reject"]').first().click();
  await expect(accept).toHaveCount(1);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(accept).toHaveCount(2);
  await accept.first().click();
  await expect(accept).toHaveCount(1);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("TYPED");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("TYPED");
  await expect(accept).toHaveCount(1);
  await switchFile(page, "second.tex");
  await expect(editor).toHaveText("Second file");
  await switchFile(page, "main.tex");
  await expect(accept).toHaveCount(1);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(accept).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(accept).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("review-undo.png") });
  await page.getByRole("button", { name: "Accept All ⌘Y" }).click();
  await expect(accept).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText("old first");
  await expect(editor).toContainText("old last");
  await expect(accept).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor).toContainText("new first");
  await expect(editor).toContainText("new last");
});

test("completed draft keeps text undo when returning to the source editor", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&agentDraft=review");
  const editor = page.locator(".cm-content");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Accept All ⌘Y" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const docPath = "/src/renderer/stores/document-store.ts";
    const proposalPath = "/src/renderer/stores/proposed-changes-store.ts";
    const { useDocumentStore: doc } = await import(docPath);
    const { useProposedChangesStore: proposals } = await import(proposalPath);
    const source = {
      ...doc.getState().files[0],
      absolutePath: "/tmp/harness/main.tex",
    };
    doc.setState({ sourceViewSnapshot: { files: [source] } });
    // Simulate successful native settlement; this test covers editor history handoff.
    proposals.setState({
      keepChange: async () => {
        proposals.setState({ changes: [], workspaceReview: null });
        doc.setState({
          agentWorkspaceRoot: null,
          agentWorkspaceSessionId: null,
          sourceViewSnapshot: null,
          files: doc.getState().files.map((file: any) => ({
            ...file,
            absolutePath: "/tmp/harness/main.tex",
          })),
        });
      },
    });
  });
  await page.getByRole("button", { name: "Accept All ⌘Y" }).click();
  await expect(
    page.locator('[data-proposed-changes-panel="true"]'),
  ).toHaveCount(0);
  await expect(editor).toContainText("Revised Draft");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).toContainText("This paragraph is the original text.");
  await expect(page.locator(".cm-chunkButtons")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(editor).toContainText("Revised Draft");
});
