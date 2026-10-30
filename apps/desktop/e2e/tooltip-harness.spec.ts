import { expect, test } from "@playwright/test";

test("shared hints respect timing, focus, visibility, disabled controls and composed triggers", async ({
  page,
}) => {
  await page.goto("/?debug=tooltips");
  const tooltip = page.getByRole("tooltip");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeVisible();
  await expect(page.locator("[title]")).toHaveCount(0);
  await save.hover();
  await page.waitForTimeout(150);
  await expect(tooltip).toHaveCount(0);
  await expect(tooltip).toHaveText("Save changes");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/tooltips-light.png",
  });
  await save.click();
  await expect(page.getByText("Saved 1 times")).toBeVisible();
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(10, 10);
  await save.blur();
  await save.focus();
  await expect(tooltip).toHaveText("Save changes");
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await save.blur();
  await page.getByRole("button", { name: "Disabled save" }).hover();
  await expect(tooltip).toHaveText("No changes to save");
  await page.getByLabel("Show tooltips", { exact: true }).uncheck();
  await save.hover();
  await page.waitForTimeout(500);
  await expect(tooltip).toHaveCount(0);
  await page.getByRole("button", { name: "New chat" }).hover();
  await page.waitForTimeout(500);
  await expect(tooltip).toHaveCount(0);
  await page.getByLabel("Hover delay").uncheck();
  await page.getByLabel("Show tooltips", { exact: true }).check();
  await page.mouse.move(10, 10);
  await page.waitForTimeout(350);
  await save.hover();
  await expect(tooltip).toHaveText("Save changes", { timeout: 250 });
  await page.getByLabel("Dark theme").check();
  await page.mouse.move(10, 10);
  await expect(tooltip).toHaveCount(0);
  await page.getByRole("button", { name: "Options", exact: true }).hover();
  await expect(tooltip).toHaveText("Open options");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/tooltips-dark.png",
  });
  await page.getByRole("button", { name: "Options", exact: true }).click();
  await expect(page.getByText("Options opened")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByText("Agent badge", { exact: true }).hover();
  await expect(tooltip).toHaveText("Created by codex");
  await page.getByLabel("Show tooltips", { exact: true }).uncheck();
  await page.reload();
  await expect(
    page.getByLabel("Show tooltips", { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel("Hover delay")).not.toBeChecked();
});

test("Appearance exposes searchable tooltip preferences", async ({ page }) => {
  await page.goto("/?debug=markdown-settings");
  await expect(
    page.getByRole("switch", { name: "Show tooltips", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("switch", { name: "Show tooltips", exact: true })
    .click();
  await page.getByRole("switch", { name: "Tooltip hover delay" }).click();
  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Show tooltips", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.getByRole("switch", { name: "Tooltip hover delay" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: "test-results/tooltip-settings.png",
  });
  await page.getByPlaceholder("Search settings").fill("tooltip");
  await expect(
    page.getByRole("button", { name: "Show Tooltips", exact: true }),
  ).toBeVisible();
});

test("moving between neighboring buttons waits for each tooltip", async ({
  page,
}) => {
  await page.goto("/?debug=tooltips");
  const save = page.getByRole("button", { name: "Save", exact: true });
  const next = page.getByRole("button", { name: "Disabled save", exact: true });
  await save.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Save changes");
  const bounds = await next.boundingBox();
  if (!bounds) throw new Error("Adjacent button is not visible");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    { steps: 5 },
  );
  await page.waitForTimeout(150);
  await expect(
    page.getByRole("tooltip", { name: "No changes to save", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("tooltip")).toHaveText("No changes to save");
});

test("dismissed hints fade visually without retaining input or accessibility state", async ({
  page,
}) => {
  await page.goto("/?debug=tooltips");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Save changes");
  const motion = await page.evaluate(async () => {
    const content = document.querySelector<HTMLElement>(
      '[data-slot="tooltip-content"]',
    )!;
    await Promise.all(
      content.getAnimations().map((animation) => animation.finished),
    );
    return new Promise<{ opacity: number; duration: number; scale: string }>(
      (resolve, reject) => {
        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error("Tooltip did not animate out"));
        }, 1000);
        const observer = new MutationObserver(() => {
          const visual = document.querySelector<HTMLElement>(
            "[data-tooltip-exit] > div",
          );
          const animation = visual?.getAnimations()[0];
          if (!visual || !animation) return;
          observer.disconnect();
          clearTimeout(timeout);
          animation.pause();
          animation.currentTime = 45;
          resolve({
            opacity: Number(getComputedStyle(visual).opacity),
            duration: Number(animation.effect?.getTiming().duration),
            scale: getComputedStyle(visual).transform,
          });
        });
        observer.observe(document.body, { childList: true });
        (document.activeElement as HTMLElement).blur();
      },
    );
  });
  expect(motion.duration).toBe(90);
  expect(motion.opacity).toBeGreaterThan(0);
  expect(motion.opacity).toBeLessThan(1);
  expect(motion.scale).not.toBe("none");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const exit = page.locator("[data-tooltip-exit]");
  await expect(exit).toHaveAttribute("aria-hidden", "true");
  await expect(exit).toHaveAttribute("inert", "");
  await expect(exit).toHaveCSS("pointer-events", "none");
  await page.screenshot({ path: "test-results/tooltip-exit-midpoint.png" });
  await exit.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true }))
      animation.play();
  });
  await expect(exit).toHaveCount(0);
  await save.click();
  await expect(page.getByText("Saved 1 times")).toBeVisible();
});

test("reduced motion dismisses hints without an exit animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?debug=tooltips");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Save changes");
  await save.blur();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await expect(page.locator("[data-tooltip-exit]")).toHaveCount(0);
});

test("model hints show the current thinking effort for both providers", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models");
  const model = page.getByRole("button", { name: /Opus 4.8/ });
  await model.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Thinking effort: Medium",
  );
  await model.click();
  await page.getByRole("button", { name: "High", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask me anything" }).click();
  await model.hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Thinking effort: High",
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/model-tooltip-claude.png",
  });
  await model.click();
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page.getByRole("textbox", { name: "Ask me anything" }).click();
  await page.getByRole("button", { name: "GPT-5.4", exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText(
    "Thinking effort: Medium",
  );
  await page.screenshot({
    animations: "disabled",
    path: "test-results/model-tooltip-codex.png",
  });
});
