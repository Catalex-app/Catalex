import { expect, test } from "@playwright/test";

for (const firstChange of ["grows", "shrinks"] as const) {
  test(`remaining original blocks stay aligned after an accepted change ${firstChange}`, async ({
    page,
  }) => {
    await page.goto("/?debug=editor-diff&deferDiff=1");
    await expect(page.locator(".cm-content")).toBeVisible();
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    const oldBlocks = Array.from(
      { length: 5 },
      (_, index) => `BLOCK_${index + 1}: original wording.`,
    );
    const newBlocks = oldBlocks.map((block) =>
      block.replace("original", "revised"),
    );
    if (firstChange === "grows")
      newBlocks[0] += "\nAn extra line accepted into the baseline.";
    else
      oldBlocks[0] +=
        " This longer sentence is removed by the first acceptance.";
    const separator = (index: number) =>
      Array.from(
        { length: 50 },
        (_, line) => `Section ${index} stable line ${line}: unchanged text.\n`,
      ).join("");
    const document = (blocks: string[]) =>
      "Document introduction.\n".repeat(12) +
      blocks.map((block, index) => `${block}\n${separator(index)}`).join("");
    const oldContent = document(oldBlocks);
    const newContent = document(newBlocks);
    await page.evaluate(
      async ({ oldContent, newContent }) => {
        const docPath = "/src/renderer/stores/document-store.ts";
        const proposalPath = "/src/renderer/stores/proposed-changes-store.ts";
        const { useDocumentStore } = await import(docPath);
        const { useProposedChangesStore } = await import(proposalPath);
        useDocumentStore.getState().updateFileContent("main.tex", oldContent);
        useProposedChangesStore.getState().addChange({
          id: "five-block-review",
          filePath: "main.tex",
          absolutePath: "/tmp/harness/main.tex",
          oldContent,
          newContent,
          toolName: "Edit",
        });
      },
      { oldContent, newContent },
    );
    await expect(page.locator(".cm-deletedLine").first()).toHaveText(
      oldBlocks[0],
    );
    // Later widgets must not have been rendered before the baseline changes.
    expect(
      await page.locator(".cm-deletedLine").allTextContents(),
    ).not.toContain(oldBlocks[4]);
    const decisions = ["accept", "reject", "accept", "reject", "accept"];
    for (let index = 0; index < oldBlocks.length; index++) {
      await page.evaluate(
        (needle) => window.__editorDiffHarness?.selectText?.(needle),
        `BLOCK_${index + 1}: revised`,
      );
      const block = page
        .locator(".cm-deletedChunk")
        .filter({ hasText: oldBlocks[index] });
      await expect(block.locator(".cm-deletedLine")).toHaveText([
        oldBlocks[index],
      ]);
      if (index === 1)
        await page.screenshot({
          path: test.info().outputPath("remaining-blocks.png"),
        });
      await block.locator(`button[name="${decisions[index]}"]`).click();
    }
    await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
    const expected = document(
      oldBlocks.map((block, index) =>
        decisions[index] === "accept" ? newBlocks[index] : block,
      ),
    );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const docPath = "/src/renderer/stores/document-store.ts";
          const { useDocumentStore } = await import(docPath);
          return useDocumentStore
            .getState()
            .files.find((file: any) => file.relativePath === "main.tex")
            ?.content;
        }),
      )
      .toBe(expected);
  });
}
