import { expect, test } from "@playwright/test";

for (const kind of ["session", "file", "folder"] as const) {
  for (const dark of [false, true]) {
    test(`${kind} source retains hover with an open menu (${dark ? "dark" : "light"})`, async ({
      page,
    }) => {
      await page.goto(
        kind === "session"
          ? "/?debug=session-navigation"
          : "/?debug=sidebar-animation&trash-confirmation",
      );
      if (dark)
        await page
          .locator("html")
          .evaluate((element) => element.classList.add("dark"));
      const source =
        kind === "session"
          ? page
              .getByTestId("vibe-sessions")
              .getByRole("button", {
                name: /Saved conversation/,
                includeHidden: true,
              })
              .locator("..")
          : kind === "file"
            ? page.locator('[data-sidebar-file-id="references.bib"]')
            : page.locator('[data-sidebar-folder-id="chapters"]');
      await expect(source).toBeVisible();
      await page.mouse.move(1200, 650);
      const background = () =>
        source.evaluate((element) => getComputedStyle(element).backgroundColor);
      const idle = await background();
      await source.hover();
      await expect.poll(background).not.toBe(idle);
      // Wait for the existing hover color transition to settle.
      await source.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const hovered = await background();
      await source.click({ button: "right" });
      const menu = page.locator(
        '[data-slot="context-menu-content"][data-state="open"]',
      );
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem").first().hover();
      await expect.poll(background).toBe(hovered);
      if (kind === "session")
        await expect(page.getByTestId("active-title")).toHaveText(
          "Background review",
        );
      await page.screenshot({
        path: test.info().outputPath("source-highlight.png"),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.mouse.move(1200, 650);
      await expect.poll(background).toBe(idle);
      await source.click({ button: "right" });
      await menu.getByRole("menuitem").first().hover();
      await expect.poll(background).toBe(hovered);
      await page.mouse.click(1200, 650);
      await expect.poll(background).toBe(idle);
      await expect(page.locator("body")).not.toHaveCSS(
        "pointer-events",
        "none",
      );
      await expect(source).not.toHaveAttribute(
        "data-context-menu-open",
        "true",
      );
      if (kind === "session") {
        await source
          .getByRole("button", { name: /Saved conversation/ })
          .click();
        await expect(page.getByTestId("active-title")).toHaveText(
          "Saved conversation",
        );
      } else if (kind === "folder") {
        const expanded = await source.getAttribute("aria-expanded");
        await source.click();
        await expect(source).toHaveAttribute(
          "aria-expanded",
          expanded === "true" ? "false" : "true",
        );
      } else {
        await source
          .getByRole("button", { name: "references.bib", exact: true })
          .click();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const { useDocumentStore } = await import(
                /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
              );
              return useDocumentStore.getState().activeFileId;
            }),
          )
          .toBe("references.bib");
      }
    });
  }
}
