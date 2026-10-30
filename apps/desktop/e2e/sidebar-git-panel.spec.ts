import { expect, test } from "@playwright/test";

test("Git history no longer consumes sidebar space in either mode", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('[data-sidebar-toggle="files"]')).toBeVisible();
  await expect(page.locator('[data-sidebar-section="git"]')).toHaveCount(0);
  await page.getByRole("button", { name: /Toggle Mode/ }).click();
  await expect(page.locator('[data-sidebar-toggle="sessions"]')).toBeVisible();
  await expect(page.locator('[data-sidebar-section="git"]')).toHaveCount(0);
});
