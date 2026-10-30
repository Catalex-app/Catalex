import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const kind of ["markdown", "pdf"] as const) {
  for (const mode of ["workspace", "drawer"] as const) {
    test(`${mode} ${kind} preview keeps review actions without change navigation`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      if (kind === "pdf") {
        // This test checks preview/review controls, not the optional local
        // compiler service. A background compile must not replace the fixture
        // with a connection error when that service isn't running.
        const bytes = await readFile(
          new URL("../public/examples/blank/main.pdf", import.meta.url),
        );
        await page.route("http://127.0.0.1:4175/compile", (route) =>
          route.fulfill({ json: { result: [...bytes] } }),
        );
      }
      await page.goto(
        `/?debug=agent-file-review&${kind === "pdf" ? "compileCase" : "textReview"}`,
      );
      await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
      // Allow the initial workspace mode restoration to finish before interacting.
      await page.waitForTimeout(800);
      await page.getByRole("tab", { name: "Duet", exact: true }).click();
      if (mode === "workspace") {
        await page
          .getByRole("button", { name: "Toggle drawer", exact: true })
          .locator("..")
          .hover();
        await page.getByRole("button", { name: "Full", exact: true }).click();
      }
      await expect(
        page.getByRole("tab", { name: "Duet", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(800);
      const tabs = page.getByRole("tablist", {
        name:
          mode === "workspace"
            ? "Chat workspace content"
            : "Workspace view mode",
      });
      if (mode === "workspace")
        await expect(
          tabs.getByRole("tab", { name: "Editor", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
      const previewTab = tabs.getByRole("tab", {
        name: kind === "pdf" ? "PDF" : "Preview",
        exact: true,
      });
      await previewTab.click();
      await expect(previewTab).toHaveAttribute("aria-selected", "true");
      await page.waitForTimeout(800);
      // Waiting also catches the old effect forcing the selection back to Editor.
      await expect(previewTab).toHaveAttribute("aria-selected", "true");
      const preview = page.locator('[data-workspace-column="preview"]');
      const bar = preview.locator("[data-proposed-changes-panel]");
      await expect(bar).toBeVisible();
      await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(
        1,
      );
      await expect(bar).toContainText(/\d+ changes?/);
      await expect(
        bar.getByRole("button", { name: "Next change" }),
      ).toHaveCount(0);
      await expect(
        bar.getByRole("button", { name: "Previous change" }),
      ).toHaveCount(0);
      if (kind === "pdf")
        await expect(preview.locator("canvas").first()).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath("preview-review.png"),
      });
      // Move the same toolbar back when the editor becomes visible.
      await tabs
        .getByRole("tab", {
          name: mode === "workspace" ? "Editor" : "Split",
          exact: true,
        })
        .click();
      await expect(
        preview.locator("[data-proposed-changes-panel]"),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Next change" }),
      ).toBeVisible();
      await previewTab.click();
      await expect(bar).toBeVisible();
      await bar
        .getByRole("button", {
          name: mode === "workspace" ? "Accept All" : "Reject All",
          exact: false,
        })
        .click();
      await expect
        .poll(() =>
          page.evaluate(
            async (filePath) => {
              const path = "/src/renderer/stores/proposed-changes-store.ts";
              const { useProposedChangesStore } = await import(path);
              return useProposedChangesStore
                .getState()
                .changes.some(
                  (change: { filePath: string }) =>
                    change.filePath === filePath,
                );
            },
            kind === "pdf" ? "main.tex" : "manuscript.md",
          ),
        )
        .toBe(false);
    });
  }
}
