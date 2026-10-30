import { expect, test } from "@playwright/test";

test("model descriptions render above the model picker", async ({ page }) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await page
    .getByRole("button", { name: "Default · default", exact: true })
    .click();
  const popup = page
    .locator(".popup-glass")
    .filter({ hasText: "Model selection" });
  await expect(popup).toBeVisible();
  const model = popup
    .locator("button[aria-label]")
    .filter({ hasNotText: "Manage legacy models" })
    .last();
  const description = model.locator("[data-model-description]");
  const tip = page.locator('[data-slot="tooltip-content"]');
  await description.hover();
  await page.waitForTimeout(600);
  await expect(tip).toHaveCount(0);
  // Simulate a narrower available description width, then verify resize updates.
  await description.evaluate((element) => {
    element.style.width = "40px";
  });
  await page.mouse.move(10, 10);
  await expect(tip).toHaveCount(0);
  await model.locator(".font-medium").hover();
  await page.waitForTimeout(600);
  await expect(tip).toHaveCount(0);
  await description.hover();
  await expect(tip).toBeVisible();
  await expect(page.getByRole("tooltip")).toHaveText(
    await description.innerText(),
  );
  await expect
    .poll(async () => {
      return tip.evaluate((element) => {
        const popup = [
          ...document.querySelectorAll<HTMLElement>(".popup-glass"),
        ].find((item) => item.textContent?.includes("Model selection"));
        const wrapper = element.parentElement!;
        return (
          Number(getComputedStyle(wrapper).zIndex) >
          Number(getComputedStyle(popup!).zIndex)
        );
      });
    })
    .toBe(true);
  await page.screenshot({ path: "/tmp/vib398-model-tooltip.png" });
  await description.evaluate((element) => {
    element.style.width = "";
  });
  await expect(tip).toHaveCount(0);
  await model.click();
  await expect(popup).toBeVisible();
});

test("provider switching animates and respects reduced motion", async ({
  page,
}) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Default · default", exact: true })
    .click();
  const group = page.getByRole("group", { name: "Provider", exact: true });
  const popup = page
    .locator(".popup-glass")
    .filter({ hasText: "Model selection" });
  await expect(group.locator("[data-provider-indicator]")).toHaveCount(0);
  await group.getByRole("button", { name: "Codex", exact: true }).click();
  const motion = await popup.evaluate((element) => {
    const animations = element.getAnimations({ subtree: true });
    const frames = animations.map((animation) => {
      animation.pause();
      animation.currentTime = 90;
      return (animation.effect as KeyframeEffect).getKeyframes();
    });
    return frames;
  });
  expect(motion.some((frames) => frames.some((frame) => frame.height))).toBe(
    true,
  );
  expect(
    motion.filter((frames) => frames.some((frame) => frame.opacity)).length,
  ).toBeGreaterThanOrEqual(2);
  const outgoing = popup.locator("[data-model-picker-outgoing]");
  await expect(outgoing).toHaveAttribute("aria-hidden", "true");
  await expect(outgoing).toHaveAttribute("inert", "");
  await page.screenshot({ path: "/tmp/vib398-provider-crossfade.png" });
  await popup.evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.finish()),
  );
  await expect(outgoing).toHaveCount(0);
  await page.screenshot({ path: "/tmp/vib398-provider-switch.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await group.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(page.locator('[data-model-provider="claude"]')).toBeVisible();
  await expect(outgoing).toHaveCount(0);
  expect(
    await popup.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});
