import { expect, test } from "@playwright/test";

test("context indicator updates from responses without querying usage", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=claude-models");
  await expect(
    page.getByRole("button", {
      name: /^Context[: ]/,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Simulate context response" }).click();
  const indicator = page.getByRole("button", {
    name: "Context: 54,000 / 200,000 tokens (27% used) · Last response",
  });
  await expect(indicator).toBeVisible();
  const square = await indicator
    .locator("[data-context-fill]")
    .evaluate((fill) => {
      const rect = fill.parentElement!.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
  expect(square).toEqual({ width: 12, height: 12 });
  await expect(indicator.locator("[data-context-fill]")).toHaveAttribute(
    "style",
    "height: 27%;",
  );
  const indicatorBox = await indicator.boundingBox();
  const modelBox = await page
    .getByRole("button", { name: /Opus 4.8/ })
    .boundingBox();
  expect(indicatorBox!.x + indicatorBox!.width).toBeLessThanOrEqual(
    modelBox!.x,
  );
  await indicator.hover();
  await expect(page.getByRole("tooltip")).toContainText("54,000 / 200,000");
  await page.screenshot({ path: testInfo.outputPath("context-tooltip.png") });
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { subscriptionUsageRequests: string[] })
          .subscriptionUsageRequests,
    ),
  ).toEqual([]);
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: /^Context[: ]/,
    }),
  ).toHaveCount(0);
});
