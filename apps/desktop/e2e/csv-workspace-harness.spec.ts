import { expect, test } from "@playwright/test";

test("switches CSV files between raw, split, and editable table views", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.addEventListener(
      "app-visibility-restored",
      () => {
        document.documentElement.dataset.harnessVisibilityReady = "true";
      },
      { once: true },
    );
  });
  await page.goto("/?debug=csv-workspace", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("csv-workspace-harness-shell")).toBeVisible();
  // Startup visibility recovery cancels in-flight panel animations.
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-harness-visibility-ready",
    "true",
  );
  const viewModes = page.getByRole("tablist", {
    name: "Workspace view mode",
  });
  await expect(viewModes.getByRole("tab", { name: "Raw" })).toBeVisible();
  await expect(viewModes.getByRole("tab", { name: "Split" })).toBeVisible();
  await expect(viewModes.getByRole("tab", { name: "Table" })).toBeVisible();
  await expect(page.getByTestId("csv-table")).toBeVisible();
  await expect(page.getByTestId("csv-table-size")).toHaveText(
    "4 rows · 4 columns",
  );

  const locationCell = page.getByRole("textbox", {
    name: "Row 2, column C",
  });
  await expect(locationCell).toHaveValue("London");
  await locationCell.fill("Oxford");

  await viewModes.getByRole("tab", { name: "Raw" }).click();
  await expect(page.getByTestId("csv-table")).not.toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Oxford");

  await viewModes.getByRole("tab", { name: "Table" }).click();
  await expect(locationCell).toHaveValue("Oxford");

  await page.getByRole("button", { name: "Add CSV row" }).click();
  await expect(page.getByTestId("csv-table-size")).toHaveText(
    "5 rows · 4 columns",
  );

  await page.getByRole("button", { name: "Add CSV column" }).click();
  await expect(page.getByTestId("csv-table-size")).toHaveText(
    "5 rows · 5 columns",
  );
  await page.waitForTimeout(350);

  await page.screenshot({
    path: "test-results/csv-workspace-table.png",
    fullPage: true,
  });
});
