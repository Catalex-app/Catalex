import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`Storage follows Settings layout in ${theme} and manages retained projects`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 780 });
    await page.goto(`/?debug=storage-settings&section=storage&theme=${theme}`);
    const section = page.getByRole("region", { name: "Storage settings" });
    await expect(section).toBeVisible();
    await expect(
      section.getByText("Archived study", { exact: true }),
    ).toBeVisible();
    await expect(
      section.getByText("Folder unavailable", { exact: true }),
    ).toBeVisible();
    const donut = page.getByTestId("storage-composition-donut");
    await expect(donut).toBeVisible();
    await expect(donut).toHaveAccessibleName(
      /Stored projects.*Shared app data.*Settings and local data.*Browser cache/,
    );
    await page.screenshot({
      path: test.info().outputPath(`storage-overview-${theme}.png`),
      animations: "disabled",
    });
    const legendItem = page.getByRole("button", {
      name: "Browser cache 850.0 MB",
      exact: true,
    });
    const initialBackground = await donut.evaluate(
      (node) => (node as HTMLElement).style.background,
    );
    await legendItem.hover();
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toContain("color-mix");
    await page.screenshot({
      path: test.info().outputPath(`storage-hover-${theme}.png`),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "Refresh storage" }).hover();
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toBe(initialBackground);
    await legendItem.focus();
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toContain("color-mix");
    await page.getByRole("button", { name: "Refresh storage" }).focus();
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toBe(initialBackground);
    const ring = await donut.boundingBox();
    if (!ring) throw new Error("Donut is missing");
    // The fixture's cache occupies the left side, projects the right side.
    await page.mouse.move(ring.x + 8, ring.y + ring.height / 2);
    await expect(legendItem).toHaveAttribute("data-active", "true");
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toContain("color-mix");
    await page.screenshot({
      path: test.info().outputPath(`storage-ring-hover-${theme}.png`),
      animations: "disabled",
    });
    await page.mouse.move(ring.x + ring.width - 8, ring.y + ring.height / 2);
    await expect(
      page.getByRole("button", {
        name: "Stored projects 708.0 MB",
        exact: true,
      }),
    ).toHaveAttribute("data-active", "true");
    await page.getByRole("button", { name: "Refresh storage" }).hover();
    await expect
      .poll(() =>
        donut.evaluate((node) => (node as HTMLElement).style.background),
      )
      .toBe(initialBackground);
    const project = page.getByTestId("stored-project-paper");
    await project.getByRole("button", { name: /Research paper/ }).click();
    await expect(
      project.getByRole("button", { name: "Clear history", exact: true }),
    ).toBeEnabled();
    await expect(
      project.getByRole("combobox", {
        name: "History budget for Research paper",
      }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`storage-${theme}.png`),
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await project
      .getByRole("button", {
        name: "About history budget for Research paper",
        exact: true,
      })
      .hover();
    await expect(page.getByRole("tooltip")).toContainText(
      "latest 50 checkpoints",
    );
    await page.screenshot({
      path: test.info().outputPath(`history-budget-tooltip-${theme}.png`),
      animations: "disabled",
    });

    await project
      .getByRole("button", { name: "Clear cache", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Clear cache?" });
    await expect(dialog).toContainText(
      "History and saved sessions are preserved",
    );
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(project).toContainText("32.0 MB");
    await project
      .getByRole("button", { name: "Clear cache", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Clear cache", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(
      project.getByRole("button", { name: "Clear cache", exact: true }),
    ).toBeDisabled();
    await expect(project).toContainText("180.0 MB");
    const openProject = page.getByTestId("stored-project-open");
    await openProject
      .getByRole("button", { name: /Current manuscript/ })
      .click();
    await expect(
      openProject.getByRole("button", { name: "Clear history", exact: true }),
    ).toBeDisabled();
    await expect(
      openProject.getByRole("button", {
        name: "Remove stored data…",
        exact: true,
      }),
    ).toBeDisabled();
  });
}

test("unavailable projects can be removed after explicit confirmation, with failures visible", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage&clearFailure");
  const project = page.getByTestId("stored-project-missing");
  await project.getByRole("button", { name: /Archived study/ }).click();
  await project.getByRole("button", { name: "Remove stored data…" }).click();
  const dialog = page.getByRole("dialog", { name: "Remove stored data?" });
  await expect(dialog.getByRole("listitem")).toHaveText([
    "Human and agent comments",
    "Automatic history",
    "Saved sessions and draft workspaces",
    "Cache",
    "Source files",
    "Project Git repository",
  ]);
  await expect(dialog).toContainText("Will not be deleted:");
  await page.screenshot({
    path: test.info().outputPath("remove-stored-data-confirmation.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Remove stored data", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Close this project in every window",
  );
  await expect(project).toBeVisible();
});

test("Storage supports empty inventory, errors, search, and project budget changes", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage&emptyStorage");
  await expect(page.getByText("No stored projects yet.")).toBeVisible();
  await page.goto("/?debug=storage-settings&section=storage&listFailure");
  await expect(page.getByRole("alert")).toContainText(
    "Could not read stored project inventory",
  );
  await page.goto("/?debug=storage-settings&section=storage");
  await page
    .getByRole("button", { name: "Search stored projects", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Find stored projects" }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Find stored projects" })
    .fill("Archived");
  await expect(page.getByTestId("stored-project-paper")).toHaveCount(0);
  const project = page.getByTestId("stored-project-missing");
  await project.getByRole("button", { name: /Archived study/ }).click();
  await project.getByRole("combobox").click();
  await page.getByRole("option", { name: "500.0 MB", exact: true }).click();
  await expect(project.getByRole("combobox")).toHaveText("500.0 MB");
  await project.getByRole("button", { name: "Remove stored data…" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove stored data", exact: true })
    .click();
  await expect(project).toHaveCount(0);
  await expect(page.getByText("No matching projects.")).toBeVisible();
});

test("browser cache cleanup preserves local data and project history", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage");
  await page
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Clear browser cache?" });
  await expect(dialog).toContainText(
    "Settings, sign-ins, saved sessions, and project history are preserved",
  );
  await page.screenshot({
    path: test.info().outputPath("browser-cache-confirmation.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("850.0 MB", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("850.0 MB", { exact: true })).toHaveCount(0);
  await expect(page.getByText("8.0 MB", { exact: true })).toBeVisible();
  await expect(page.getByTestId("stored-project-paper")).toBeVisible();
  await page.goto("/?debug=storage-settings&section=storage&clearFailure");
  await page
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Clear browser cache", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Error: Could not clear browser cache.",
  );
});

test("stored project filters combine recents, availability, and search", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage");
  const filters = page.getByRole("group", { name: "Filter stored projects" });
  await expect(page.locator('[data-testid^="stored-project-"]')).toHaveCount(3);
  await filters.getByRole("button", { name: "Active", exact: true }).click();
  await expect(page.getByTestId("stored-project-open")).toBeVisible();
  await expect(page.locator('[data-testid^="stored-project-"]')).toHaveCount(1);
  await filters.getByRole("button", { name: "Inactive", exact: true }).click();
  await expect(page.getByTestId("stored-project-paper")).toBeVisible();
  await expect(page.locator('[data-testid^="stored-project-"]')).toHaveCount(1);
  await filters
    .getByRole("button", { name: "Unavailable", exact: true })
    .click();
  await expect(page.getByTestId("stored-project-missing")).toBeVisible();
  await expect(page.locator('[data-testid^="stored-project-"]')).toHaveCount(1);
  await page
    .getByRole("button", { name: "Search stored projects", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Find stored projects" }),
  ).toBeFocused();
  await page
    .getByRole("textbox", { name: "Find stored projects" })
    .fill("Research paper");
  await expect(page.getByText("No matching projects.")).toBeVisible();
  await filters.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByTestId("stored-project-paper")).toBeVisible();
});

test("project search expands from the heading and Escape clears and closes it", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage");
  const input = page.getByRole("textbox", { name: "Find stored projects" });
  await expect(input).toHaveCount(0);
  const filters = page.getByRole("group", { name: "Filter stored projects" });
  const before = await filters.boundingBox();
  await page
    .getByRole("button", { name: "Search stored projects", exact: true })
    .click();
  await expect(input).toBeFocused();
  const after = await filters.boundingBox();
  expect(after?.y).toBe(before?.y);
  await input.fill("Archived");
  await expect(page.getByTestId("stored-project-paper")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("storage-search-open.png"),
    animations: "disabled",
  });
  await input.press("Escape");
  await expect(input).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Search stored projects", exact: true }),
  ).toBeFocused();
  await expect(page.locator('[data-testid^="stored-project-"]')).toHaveCount(3);
});

test("history usage handles soft-budget overage and clearing history", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage");
  const project = page.getByTestId("stored-project-paper");
  await project.getByRole("button", { name: /Research paper/ }).click();
  const usage = project.getByRole("progressbar", {
    name: "History storage for Research paper",
  });
  await expect(usage).toHaveAttribute("aria-valuenow", "72");
  await project.getByRole("combobox").click();
  await page.getByRole("option", { name: "100.0 MB", exact: true }).click();
  await expect(usage).toHaveAttribute("aria-valuenow", "100");
  await expect(project.getByText("80.0 MB over budget")).toBeVisible();
  await project
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", { name: "Clear history?" });
  await expect(confirmation.locator("strong")).toHaveText(
    "This cannot be undone.",
  );
  await confirmation.screenshot({
    path: "/tmp/270-settings-clear-copy.png",
    animations: "disabled",
  });
  await confirmation
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await expect(usage).toHaveAttribute("aria-valuenow", "0");
  await expect(project.getByText("0 B used", { exact: true })).toBeVisible();
  await expect(
    project.getByRole("button", { name: "Clear history", exact: true }),
  ).toBeDisabled();
});

test("stored project paths use the shared full-text tooltip", async ({
  page,
}) => {
  await page.goto("/?debug=storage-settings&section=storage");
  const path = page
    .getByTestId("stored-project-paper")
    .getByText("/Users/researcher/Papers/Research paper", { exact: true });
  await expect(path).not.toHaveAttribute("title");
  await path.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "/Users/researcher/Papers/Research paper",
  );
  await page.screenshot({
    path: test.info().outputPath("storage-path-tooltip.png"),
    animations: "disabled",
  });
});
