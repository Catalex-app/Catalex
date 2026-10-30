import { expect, test } from "@playwright/test";

test("automatic history management shows usage, limits, and clearing", async ({
  page,
}) => {
  await page.goto("/?debug=history-management", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("history-management-harness-shell"),
  ).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(page.getByText("Submission")).toBeVisible();
  await page.getByRole("button", { name: "Manage automatic history" }).click();

  const dialog = page.getByRole("dialog", { name: "Manage automatic history" });
  await expect(dialog).toContainText("42.0 MB of 250.0 MB");
  await expect(dialog).toContainText("14 snapshots");
  await expect(dialog).toContainText(
    "Recent and labeled snapshots may exceed this limit",
  );
  await page.waitForTimeout(300);

  await page.screenshot({
    path: "test-results/automatic-history-management.png",
    fullPage: true,
  });

  await page
    .getByRole("combobox", { name: "Automatic history storage limit" })
    .click();
  await page.getByRole("option", { name: "500 MB" }).click();
  await expect(dialog).toContainText("42.0 MB of 500.0 MB");

  await dialog.getByRole("button", { name: "Clear history" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Clear history?",
    exact: true,
  });
  await expect(confirmation).toContainText("including labeled versions");
  await expect(confirmation.getByText("Storage used")).toHaveCount(0);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(dialog).toContainText("42.0 MB of 500.0 MB");
  await dialog
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await page.waitForTimeout(200);
  await page.screenshot({
    path: "test-results/automatic-history-clear-confirmation.png",
    fullPage: true,
  });
  await confirmation.getByRole("button", { name: "Clear history" }).click();

  await expect(confirmation).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Manage automatic history" }).click();
  await expect(dialog).toContainText("12.0 KB of 500.0 MB");
  await expect(dialog).toContainText("1 snapshot");
  await expect(page.getByText("Submission")).toHaveCount(0);
});

test("automatic history cleanup failures remain inside the management dialog", async ({
  page,
}) => {
  await page.goto("/?debug=history-management&clearFailure", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Manage automatic history" }).click();
  const dialog = page.getByRole("dialog", { name: "Manage automatic history" });
  await dialog.getByRole("button", { name: "Clear history" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Clear history?",
    exact: true,
  });
  await confirmation.getByRole("button", { name: "Clear history" }).click();

  await expect(confirmation.getByRole("alert")).toContainText(
    "Automatic history is currently in use",
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toContainText("42.0 MB of 250.0 MB");
  await expect(page.getByText("Submission")).toBeVisible();
});

test("restoring history does not hide intermediate versions", async ({
  page,
}) => {
  await page.goto("/?debug=history-management");
  await expect(page.getByText("Submission")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/history-store.ts";
    const { useHistoryStore } = await import(path);
    const base = {
      timestamp: Math.floor(Date.now() / 1000),
      labels: [],
      changed_files: ["main.tex"],
    };
    useHistoryStore.setState({
      snapshots: [
        { ...base, id: "dddddddd", message: "[restore] Restored to aaaaaaaa" },
        {
          ...base,
          id: "cccccccc",
          message: "[before-restore] Before restoring history",
        },
        {
          ...base,
          id: "bbbbbbbb",
          message: "[manual] Later work",
          labels: ["Later work"],
        },
        { ...base, id: "aaaaaaaa", message: "[init] Project opened" },
      ],
    });
  });
  await expect(page.getByText("Before restore", { exact: true })).toBeVisible();
  await expect(page.getByText("Later work", { exact: true })).toBeVisible();
  await expect(page.getByText("Initial", { exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("restored-history.png"),
  });
});
