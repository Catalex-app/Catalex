import { expect, test } from "@playwright/test";

for (const provider of ["claude", "codex"]) {
  test(`Continue ignores new context for ${provider}`, async ({ page }) => {
    await page.addInitScript(() =>
      performance.setResourceTimingBufferSize(4096),
    );
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    await page
      .getByRole("button", { name: "Back to welcome", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Reopen project", exact: true })
      .click();
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    const resume = page.getByRole("button", { name: "Continue", exact: true });
    await expect(resume).toBeVisible();
    await page.evaluate(async () => {
      const moduleUrl = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find(
          (name) =>
            new URL(name).pathname === "/src/renderer/stores/document-store.ts",
        );
      if (!moduleUrl) throw new Error("Document store module was not loaded");
      const { useDocumentStore } = await import(moduleUrl);
      useDocumentStore.setState({
        pdfSelectionContext: {
          label: "PDF p.1 · “Selected text”",
          filePath: "main.pdf",
          selectedText: "NEW_SELECTION_MUST_NOT_BE_SENT",
        },
      });
      const host = window as any;
      const original = host.__TAURI_INTERNALS__.invoke;
      host.__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
        if (/^resume_(claude|codex)_code$/.test(command))
          host.continuedPrompt = args.prompt;
        return original(command, args);
      };
    });
    await expect(
      page.getByText("PDF p.1 · “Selected text”", { exact: true }),
    ).toBeVisible();
    await resume.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).continuedPrompt))
      .toContain("Continue");
    expect(
      await page.evaluate(() => (window as any).continuedPrompt),
    ).not.toContain("NEW_SELECTION_MUST_NOT_BE_SENT");
    await expect(
      page.getByText("PDF p.1 · “Selected text”", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `/tmp/vib397-${provider}.png` });
  });
}
