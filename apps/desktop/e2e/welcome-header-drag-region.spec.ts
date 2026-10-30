import { expect, test } from "@playwright/test";

test("welcome screen exposes draggable header region", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });

  await page.goto("/", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByText("Recent Projects")).toBeVisible();
  const dragRegion = page.locator('[data-welcome-header-drag-region="true"]');
  await expect(dragRegion).toBeVisible();
  await expect(dragRegion).toHaveAttribute("data-tauri-drag-region", "true");

  await page.screenshot({
    path: "/tmp/catalex-welcome-header-drag-region.png",
    fullPage: true,
  });

  expect(
    pageErrors,
    `page errors: ${JSON.stringify(pageErrors, null, 2)}`,
  ).toEqual([]);
});
