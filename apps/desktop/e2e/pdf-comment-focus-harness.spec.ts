import { expect, test } from "@playwright/test";

for (const mode of ["Split", "PDF"]) {
  test(`PDF highlights update the shared comment info bar in ${mode} view`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/?debug=comment-workspace&pdf");
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    await page
      .getByRole("tablist", { name: "Workspace view mode" })
      .getByRole("tab", { name: mode, exact: true })
      .click();
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    const bar =
      mode === "PDF"
        ? page.locator(
            '[data-workspace-column="preview"] [data-comments-panel="true"]',
          )
        : page.locator('[data-comments-panel="true"]').first();
    await expect(bar).toHaveCount(1);
    await expect(
      bar.getByRole("button", { name: "Go to comment H-8", exact: true }),
    ).toBeVisible();
    const agent = page.locator('[data-pdf-comment-id="A-9"]').first();
    await expect(agent).toBeAttached();
    await expect(async () => {
      // Keep the highlight above the floating chat drawer.
      await agent.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const bounds = await agent.boundingBox();
      await page.mouse.click(
        bounds!.x + Math.min(4, bounds!.width / 2),
        bounds!.y + bounds!.height / 2,
      );
      await expect(agent).toHaveAttribute("aria-pressed", "true", {
        timeout: 500,
      });
    }).toPass();
    await expect(
      bar.getByRole("button", { name: "Go to comment A-9", exact: true }),
    ).toBeVisible();
    await expect(
      bar.getByRole("status", {
        name: mode === "PDF" ? "Comment 2 of 2" : "Comment 1 of 1",
        exact: true,
      }),
    ).toBeVisible();
    if (mode === "PDF") {
      await expect(
        page.getByRole("dialog", { name: "PDF comment", exact: true }),
      ).toHaveCSS("opacity", "1");
    }
    await page.screenshot({
      path: test.info().outputPath(`pdf-comment-focus-${mode}.png`),
    });
    if (mode === "Split") {
      await bar
        .getByRole("button", { name: "All comments", exact: true })
        .click();
    }
    await bar
      .getByRole("button", {
        name: mode === "PDF" ? "Previous comment" : "Go to comment H-8",
        exact: true,
      })
      .click();
    await expect(
      bar.getByRole("button", { name: "Go to comment H-8", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-pdf-comment-id="H-8"]').first(),
    ).toHaveAttribute("aria-pressed", "true");
  });
}

for (const sourceMode of ["Editor", "Split", "Full chat"]) {
  test(`reveals the focused source comment when switching ${sourceMode} to PDF`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/?debug=comment-workspace&pdf");
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    if (sourceMode === "Full chat") {
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
      await page.getByRole("button", { name: "Full", exact: true }).click();
    }
    const modes = page.getByRole("tablist", {
      name:
        sourceMode === "Full chat"
          ? "Chat workspace content"
          : "Workspace view mode",
    });
    await modes
      .getByRole("tab", {
        name: sourceMode === "Full chat" ? "Editor" : sourceMode,
        exact: true,
      })
      .click();
    const sourceCard = page.locator(
      '.cm-editor .cm-inlineCommentCard[data-inline-comment-id="A-9"]',
    );
    await sourceCard
      .getByRole("button", { name: "Add comment A-9 to chat", exact: true })
      .click();
    await expect(sourceCard).toHaveClass(/cm-inlineCommentSelected/);
    await modes.getByRole("tab", { name: "PDF", exact: true }).click();
    const popup = page.getByRole("dialog", {
      name: "PDF comment",
      exact: true,
    });
    await expect(popup).toBeVisible();
    await expect(popup).toHaveCSS("opacity", "1");
    await expect(popup).toContainText("Add the motivation and contributions.");
    const highlight = page.locator('[data-pdf-comment-id="A-9"]').first();
    await expect(highlight).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      const target = await highlight.boundingBox();
      const viewport = await page
        .getByTestId("pdf-scroll-container")
        .evaluate((element) => ({
          top: element.getBoundingClientRect().top,
          height: element.getBoundingClientRect().height,
          scrollTop: element.scrollTop,
          maxScroll: element.scrollHeight - element.clientHeight,
        }));
      // Center where possible, clamping at the document's beginning and end.
      const centeredScroll =
        viewport.scrollTop +
        target!.y +
        target!.height / 2 -
        viewport.top -
        viewport.height / 2;
      const expectedScroll = Math.max(
        0,
        Math.min(viewport.maxScroll, centeredScroll),
      );
      expect(Math.abs(viewport.scrollTop - expectedScroll)).toBeLessThan(6);
    }).toPass();
    await page.screenshot({
      path: test.info().outputPath(`focused-comment-from-${sourceMode}.png`),
    });
    await modes.getByRole("tab", { name: "Editor", exact: true }).click();
    await expect(popup).toHaveCount(0);
    await expect(sourceCard).toBeVisible();
    await modes.getByRole("tab", { name: "PDF", exact: true }).click();
    await expect(popup).toBeVisible();
    await expect(highlight).toHaveAttribute("aria-pressed", "true");
    // An ordinary click still clears focus; the info bar must not revive it.
    await page.getByTestId("pdf-scroll-container").click({
      position: { x: 20, y: 20 },
    });
    await expect(popup).toHaveCount(0);
    await modes.getByRole("tab", { name: "Editor", exact: true }).click();
    await modes.getByRole("tab", { name: "PDF", exact: true }).click();
    await expect(highlight).toHaveAttribute("aria-pressed", "false");
    await expect(popup).toHaveCount(0);
  });
}
