import { expect, test } from "@playwright/test";

for (const mode of ["collapsed", "expanded", "workspace"] as const) {
  test(`${mode} composer preserves selection for non-primary mouse buttons`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.addEventListener(
        "app-visibility-restored",
        () => {
          document.documentElement.dataset.startupRecovered = "true";
        },
        { once: true },
      );
    });
    await page.goto("/?debug=input-transfer");
    // Startup recovery cancels layout transitions already in flight.
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-startup-recovered",
      "true",
    );
    await page
      .locator("[data-input-transfer-harness-overlay]")
      .evaluate((element) => element.remove());
    if (mode === "expanded") {
      await page
        .locator('[data-chat-display="Expanded"]')
        .evaluate((element) => (element as HTMLButtonElement).click());
      await expect(
        page.locator('[data-chat-display="Expanded"]'),
      ).toHaveAttribute("aria-pressed", "true");
    } else if (mode === "workspace") {
      await expect(
        page.locator('[data-chat-display="Workspace"]'),
      ).toBeEnabled();
      await page
        .locator('[data-chat-display="Workspace"]')
        .evaluate((element) => (element as HTMLButtonElement).click());
      await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
        "data-chat-layout",
        "workspace",
      );
    }
    const panel = page.locator(
      mode === "workspace"
        ? '[data-workspace-chat-pane="true"]'
        : '[data-chat-drawer-panel="true"]',
    );
    await expect(
      panel.locator("[data-composer-transfer-phase]"),
    ).toHaveAttribute("data-composer-transfer-phase", "idle");
    const input = panel.locator('[data-chat-composer-input="true"]:visible');
    await expect(input).toHaveCount(1);
    await input.fill("Keep this selected text and cursor position");
    const session = await page.context().newCDPSession(page);
    // Side buttons retain their browser action; keep this fixture on its only page.
    await session.send("Page.resetNavigationHistory");
    for (const button of ["middle", "back", "forward", "right"] as const) {
      for (const selection of [
        [5, 5],
        [5, 18],
      ] as const) {
        await input.evaluate((element, [start, end]) => {
          const textarea = element as HTMLTextAreaElement;
          textarea.focus();
          textarea.setSelectionRange(start, end);
        }, selection);
        const box = await input.boundingBox();
        if (!box) throw new Error("Composer is not visible");
        const position = { x: box.x + 12, y: box.y + box.height / 2 };
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          button,
          clickCount: 1,
          ...position,
        });
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          clickCount: 1,
          ...position,
        });
        expect(
          await input.evaluate((element) => {
            const textarea = element as HTMLTextAreaElement;
            return [textarea.selectionStart, textarea.selectionEnd];
          }),
          `${button} click should preserve ${selection}`,
        ).toEqual([...selection]);
        if (button === "right") {
          await expect(
            page.getByRole("menuitem", { name: "Select All", exact: true }),
          ).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.locator('[role="menu"]')).toHaveCount(0);
        } else {
          await expect(input).toBeFocused();
        }
      }
    }
    const editor = page.locator(".cm-content");
    for (const button of ["middle", "back", "forward"] as const) {
      await editor.focus();
      const box = await input.boundingBox();
      if (!box) throw new Error("Composer is not visible");
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await session.send("Input.dispatchMouseEvent", {
          type,
          button,
          clickCount: 1,
          x: box.x + 12,
          y: box.y + box.height / 2,
        });
      }
      await expect(editor).toBeFocused();
    }
    await expect(input).toHaveValue(
      "Keep this selected text and cursor position",
    );
    await input.click({ position: { x: 12, y: 12 } });
    expect(
      await input.evaluate(
        (element) => (element as HTMLTextAreaElement).selectionStart,
      ),
    ).toBeLessThan(5);
    await page.screenshot({
      animations: "disabled",
      path: test.info().outputPath(`${mode}-composer.png`),
    });
  });
}
