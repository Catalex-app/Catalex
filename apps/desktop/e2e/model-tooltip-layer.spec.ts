import { expect, test } from "@playwright/test";

test("model descriptions render above the model picker", async ({ page }) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await page
    .getByRole("button", {
      name: "Default · default · Model settings",
      exact: true,
    })
    .click();
  const popup = page.getByRole("dialog", { name: "Model settings" });
  await expect(popup).toBeVisible();
  const model = popup.locator("[data-model-provider] button").last();
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
        const popup = document.querySelector<HTMLElement>(
          '[role="dialog"][aria-label="Model settings"]',
        );
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
  await page.goto("/?debug=claude-models&usage=slow");
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  const popup = page.getByRole("dialog", { name: "Model settings" });
  const group = popup.getByRole("group", { name: "Provider", exact: true });
  const refresh = popup.getByRole("button", {
    name: "Refresh subscription usage",
  });
  await expect(refresh).toBeEnabled();
  const usage = popup.locator("[data-subscription-content]");
  const [keyframes] = await Promise.all([
    usage.evaluate(
      (element) =>
        new Promise<Keyframe[]>((resolve) => {
          const observer = new MutationObserver(() => {
            const frames = element
              .getAnimations()
              .flatMap((animation) =>
                (animation.effect as KeyframeEffect).getKeyframes(),
              );
            if (!frames.some((frame) => "opacity" in frame)) return;
            observer.disconnect();
            resolve(frames);
          });
          observer.observe(element, { childList: true, subtree: true });
        }),
    ),
    group.getByRole("button", { name: "Codex", exact: true }).click(),
  ]);
  expect(keyframes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ opacity: "0" }),
      expect.objectContaining({ opacity: "1" }),
    ]),
  );
  await expect(refresh).toBeEnabled();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await group.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(popup.locator('[data-model-provider="claude"]')).toBeVisible();
  await expect(refresh).toBeEnabled();
  expect(
    await popup.evaluate(
      (element) =>
        element
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              !(animation instanceof CSSAnimation) &&
              !(animation instanceof CSSTransition),
          ).length,
    ),
  ).toBe(0);
});
