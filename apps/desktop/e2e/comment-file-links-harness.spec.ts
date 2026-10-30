import { expect, test } from "@playwright/test";

test("file groups preview conflicts, relink, and stay open with updated results", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&disconnected=1");
  const section = page.locator('[data-sidebar-section="comment-visibility"]');
  await section.locator("button").first().click();
  await section.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }).click();
  await dialog
    .getByLabel("Select disconnected file old-manuscript.md", { exact: true })
    .check();
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog
    .getByRole("button", { name: "Reconnect comments to file", exact: true })
    .click();
  const target = dialog.getByRole("combobox", {
    name: "Target file",
    exact: true,
  });
  const submit = dialog.getByRole("button", { name: "Continue", exact: true });
  await target.fill("sample.tex");
  await page.getByRole("option", { name: "sample.tex", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("already has comments");
  await expect(submit).toBeDisabled();
  await target.fill("manuscript.md");
  await page
    .getByRole("option", { name: "manuscript.md", exact: true })
    .click();
  await expect(submit).toBeEnabled();
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "test-results/comment-file-relink.png",
    animations: "disabled",
  });
  await submit.click();
  await expect(
    dialog.getByRole("tab", { name: "Disconnected (0)", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    dialog.getByText("No disconnected comments.", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/comment-file-relink-stays-disconnected.png",
    animations: "disabled",
  });
  await expect(dialog.getByRole("status")).toContainText(
    "linked to manuscript.md",
  );
  // Only the user's tab click changes the filter after reconnecting.
  await dialog.getByRole("tab", { name: /^Connected \(\d+\)$/ }).click();
  await expect(
    dialog.locator('[data-comment-link-group="manuscript.md"]'),
  ).toBeVisible();
  // A mistaken link can be corrected from the Connected filter.
  await dialog.getByLabel("Select file manuscript.md", { exact: true }).check();
  await dialog
    .getByRole("button", { name: "Reconnect comments to file", exact: true })
    .click();
  await target.fill("manuscript.md");
  await page
    .getByRole("option", { name: "manuscript.md", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("different file");
  await expect(submit).toBeDisabled();
  // Multiple files permit only Clear, and selection never includes individual comments.
  await dialog.getByLabel("Select file sample.tex", { exact: true }).check();
  await expect(
    dialog.getByRole("button", {
      name: "Reconnect comments to file",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    dialog.locator('[data-comment-link-group="manuscript.md"]'),
  ).toHaveCount(0);
  await expect(
    dialog.locator('[data-comment-link-group="sample.tex"]'),
  ).toHaveCount(0);
  await expect(
    dialog.locator('[data-comment-link-group="review-notes.md"]'),
  ).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("comments cleared");
  await expect(
    dialog.getByRole("tab", { name: /^Connected \(\d+\)$/ }),
  ).toHaveAttribute("aria-selected", "true");
});

test("relink rechecks a target occupied after successful preview", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&disconnected=1");
  const section = page.locator('[data-sidebar-section="comment-visibility"]');
  await section.locator("button").first().click();
  await section.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }).click();
  await dialog
    .getByLabel("Select disconnected file old-manuscript.md", { exact: true })
    .check();
  await dialog
    .getByRole("button", { name: "Reconnect comments to file", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "Target file" })
    .fill("manuscript");
  await page
    .getByRole("option", { name: "manuscript.md", exact: true })
    .click();
  const submit = dialog.getByRole("button", { name: "Continue", exact: true });
  await expect(submit).toBeEnabled();
  await page.evaluate(() => {
    const key = "catalex-harness-comments:/browser-demo/Comment Review";
    const files = JSON.parse(localStorage.getItem(key)!);
    files["manuscript.md"] = [
      { id: "concurrent", text: "New comment", from: 0, to: 0, line: 1 },
    ];
    localStorage.setItem(key, JSON.stringify(files));
  });
  await submit.click();
  await expect(dialog.getByRole("alert").first()).toContainText(
    "already has comments",
  );
  await expect(
    dialog.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }),
  ).toBeVisible();
  await expect(
    dialog.locator('[data-comment-link-group="old-manuscript.md"]'),
  ).toBeVisible();
});
