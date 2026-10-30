import { expect, test } from "@playwright/test";

test("popover, select, and dialog reuse context-menu opacity motion", async ({
  page,
}) => {
  await page.goto("/?debug=context-menu");
  for (const [role, name, slot] of [
    ["button", "Glass popover", "popover-content"],
    ["combobox", "Glass select", "select-content"],
    ["button", "Open dialog", "dialog-content"],
  ] as const) {
    await page.getByRole(role, { name, exact: true }).click();
    const popup = page.locator(`[data-slot="${slot}"]`);
    await expect(popup).toHaveCSS("animation-name", "popup-fade-in");
    await expect(popup).toHaveCSS("animation-duration", "0.2s");
    const frames = await popup.evaluate((element) =>
      element
        .getAnimations()
        .flatMap((animation) =>
          (animation.effect as KeyframeEffect).getKeyframes(),
        ),
    );
    expect(
      frames.every(
        (frame) => !frame.transform && !frame.scale && !frame.translate,
      ),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(popup).toHaveCount(0);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Glass popover", exact: true })
    .click();
  await expect(page.locator('[data-slot="popover-content"]')).toHaveCSS(
    "animation-name",
    "none",
  );
});

test("custom model popup fades out without keeping an interactive layer", async ({
  page,
}) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await page
    .getByRole("button", { name: "Default · default", exact: true })
    .click();
  const popup = page
    .locator(".popup-motion:not([data-popup-exit])")
    .filter({ hasText: "Model selection" });
  await expect(popup).toHaveCSS("animation-name", "popup-fade-in");
  await expect(popup).toHaveCSS("animation-duration", "0.2s");
  await page.mouse.click(20, 20);
  await expect(popup).toHaveCount(0);
  const exit = page.locator("[data-popup-exit]");
  await expect(exit).toHaveAttribute("inert", "");
  await expect(exit).toHaveAttribute("aria-hidden", "true");
  await expect(exit).toHaveCSS("pointer-events", "none");
  await page.screenshot({ path: "/tmp/shared-popup-exit.png" });
  await expect(exit).toHaveCount(0);
});
