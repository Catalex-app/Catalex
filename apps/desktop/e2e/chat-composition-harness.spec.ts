import { expect, test } from "@playwright/test";

for (const draft of ["你好", "@", "/"]) {
  test(`IME owns composition keys with draft ${draft}`, async ({ page }) => {
    await page.goto("/?debug=input-transfer");
    const input = page.locator(
      '[data-chat-drawer-panel="true"] textarea:visible',
    );
    await expect(input).toBeVisible();
    await input.fill(draft);
    if (draft === "@")
      await expect(
        page.getByText("main.tex", { exact: true }).last(),
      ).toBeVisible();
    if (draft === "/")
      await expect(page.getByText("All", { exact: true }).last()).toBeVisible();
    for (const key of ["Enter", "ArrowDown", "ArrowUp", "Escape", "Tab"]) {
      for (const legacy of [false, true]) {
        const prevented = await input.evaluate(
          (element, { key, legacy }) => {
            const event = new KeyboardEvent("keydown", {
              key,
              bubbles: true,
              cancelable: true,
              isComposing: !legacy,
              keyCode: legacy ? 229 : 13,
            });
            element.dispatchEvent(event);
            return event.defaultPrevented;
          },
          { key, legacy },
        );
        expect(prevented, `${key}, legacy=${legacy}`).toBe(false);
        await expect(input).toHaveValue(draft);
      }
    }
    if (draft === "你好") {
      await input.press("Shift+Enter");
      await expect(input).toHaveValue("你好\n");
      // An ordinary Enter still reaches the normal send handler.
      expect(
        await input.evaluate((element) => {
          const event = new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          });
          element.dispatchEvent(event);
          return event.defaultPrevented;
        }),
      ).toBe(true);
      await page
        .locator("[data-input-transfer-harness-overlay]")
        .evaluate((element) => element.remove());
      await page.screenshot({ path: test.info().outputPath("ime-draft.png") });
    }
  });
}

test("command picker respects focused buttons and keys in other panels", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const input = page.locator(
    '[data-chat-drawer-panel="true"] textarea:visible',
  );
  await expect(input).toBeVisible();
  await input.fill("/");
  const close = page.getByRole("button", { name: "Close command picker" });
  await expect(close).toBeVisible();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Escape");
  await expect(close).toBeVisible();
  await close.focus();
  await page.keyboard.press("Enter");
  await expect(close).toHaveCount(0);
  await expect(input).toHaveValue("/");
});

test("command popup Escape leaves an open editor search intact", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const input = page.locator(
    '[data-chat-drawer-panel="true"] textarea:visible',
  );
  await expect(input).toBeVisible();
  await page.locator(".cm-content").focus();
  await page.keyboard.press("Control+f");
  const search = page.getByTestId("editor-search-panel");
  await expect(search).toBeVisible();
  await input.fill("/");
  const close = page.getByRole("button", { name: "Close command picker" });
  await close.focus();
  await page.keyboard.press("Escape");
  await expect(close).toHaveCount(0);
  await expect(search).toBeVisible();
});
