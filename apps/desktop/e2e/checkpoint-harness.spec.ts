import { expect, test, type Page } from "@playwright/test";

async function openCheckpoint(page: Page, query = "") {
  await page.goto(`/?debug=history-workspace&checkpointDemo${query}`);
  await expect(
    page.getByTestId("history-workspace-harness-shell"),
  ).toHaveAttribute("data-media-ready", "true");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  return page.getByRole("dialog", { name: "Save checkpoint", exact: true });
}

async function requests(page: Page) {
  return page.evaluate(
    () => window.__historyWorkspaceHarness!.liveCommandRequests,
  );
}

test("checkpoint saves the edited file before labeling it and appears in Rewind", async ({
  page,
}) => {
  const dialog = await openCheckpoint(page);
  await page.evaluate(() =>
    window.__historyWorkspaceHarness!.setCurrentMainText(
      "New checkpoint content",
    ),
  );
  await dialog
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Submission draft");
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save checkpoint", exact: true }),
  ).toBeFocused();
  const calls = await requests(page);
  expect(calls.indexOf("save_file_if_unchanged")).toBeLessThan(
    calls.indexOf("history_snapshot"),
  );
  expect(calls.indexOf("history_snapshot")).toBeLessThan(
    calls.indexOf("history_add_label"),
  );
  expect(
    (
      await page.evaluate(() =>
        window.__historyWorkspaceHarness!.readLiveState(),
      )
    ).files.find((file) => file.id === "main.tex")?.isDirty,
  ).toBe(false);
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  const rewind = page.getByRole("dialog", {
    name: "Project rewind",
    exact: true,
  });
  await expect(rewind.getByTestId("history-front-card")).toContainText(
    "Submission draft",
  );
  await expect(rewind.getByTestId("history-front-card")).toContainText(
    "New checkpoint content",
  );
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Rewind", exact: true }),
  ).toBeFocused();
});

test("optional label can be omitted and unchanged saves reuse the same checkpoint", async ({
  page,
}) => {
  let dialog = await openCheckpoint(page);
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Save checkpoint", exact: true });
  await dialog.getByRole("combobox", { name: "Snapshot label" }).fill("Pinned");
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  const rewind = page.getByRole("dialog", {
    name: "Project rewind",
    exact: true,
  });
  await expect(rewind.getByTestId("history-snapshot-newest")).toBeVisible();
  await expect(rewind.getByTestId("history-front-card")).toContainText(
    "Pinned",
  );
  await expect(
    rewind.locator('[data-history-snapshot^="checkpoint-"]'),
  ).toHaveCount(0);
});

test("checkpoint reuses the label picker and rejects automatic reserved labels", async ({
  page,
}) => {
  const dialog = await openCheckpoint(page);
  const label = dialog.getByRole("combobox", { name: "Snapshot label" });
  await label.fill("Agent");
  await expect(dialog.getByRole("alert")).toHaveText("Reserved label");
  await expect(
    dialog.getByRole("button", { name: "Save checkpoint", exact: true }),
  ).toBeDisabled();
  await label.fill("Sub");
  const suggestion = page.getByRole("option", {
    name: "Revised submission",
    exact: true,
  });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(label).toHaveValue("Revised submission");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Save checkpoint", exact: true }),
  ).toBeFocused();
  expect(
    (await requests(page)).filter((command) => command.startsWith("history_")),
  ).toEqual([]);
});

for (const [query, error] of [
  ["checkpointSaveFailure", "File could not be written"],
  ["checkpointFailure", "History unavailable"],
]) {
  test(`checkpoint reports ${query} without labeling a previous version`, async ({
    page,
  }) => {
    const dialog = await openCheckpoint(page, `&${query}`);
    await page.evaluate(() =>
      window.__historyWorkspaceHarness!.setCurrentMainText("Unsaved change"),
    );
    await dialog
      .getByRole("combobox", { name: "Snapshot label" })
      .fill("Important");
    await dialog
      .getByRole("button", { name: "Save checkpoint", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toContainText(error);
    expect(await requests(page)).not.toContain("history_add_label");
    if (query === "checkpointSaveFailure")
      expect(await requests(page)).not.toContain("history_snapshot");
  });
}

test("label failure retries the saved version without another checkpoint", async ({
  page,
}) => {
  const dialog = await openCheckpoint(page, "&checkpointLabelFailure");
  await page.evaluate(() =>
    window.__historyWorkspaceHarness!.setCurrentMainText(
      "Checkpoint before failed label",
    ),
  );
  await dialog
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Retry label");
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Checkpoint saved, but the label could not be saved",
  );
  await dialog.getByRole("button", { name: "Save label", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await requests(page)).filter((command) => command === "history_snapshot"),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  await expect(page.getByTestId("history-front-card")).toContainText(
    "Retry label",
  );
});

test("switching projects during checkpoint creation closes the dialog and never labels the new project", async ({
  page,
}) => {
  const dialog = await openCheckpoint(page, "&checkpointDelay");
  await dialog
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Old project only");
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.evaluate(() => window.__historyWorkspaceHarness!.switchProject());
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(await requests(page)).not.toContain("history_add_label");
});

test("checkpoint controls and dialog fit the shared modern and classic styles", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    const dialog = await openCheckpoint(page, `&theme=${theme}`);
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `test-results/checkpoint-${theme}.png` });
  }
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Save checkpoint", exact: true }),
  ).toHaveCount(0);
  const save = page.getByRole("button", {
    name: "Save checkpoint",
    exact: true,
  });
  const rewind = page.getByRole("button", { name: "Rewind", exact: true });
  for (const theme of ["modern", "classic"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.uiTheme = theme;
    }, theme);
    const a = await save.boundingBox();
    const b = await rewind.boundingBox();
    expect(a?.height).toEqual(b?.height);
    expect(b!.width).toBeGreaterThan(a!.width);
    expect(a?.y).toEqual(b?.y);
    expect(b!.x).toBeCloseTo(a!.x + a!.width, 1);
    await expect(save).toHaveCSS("border-top-right-radius", "0px");
    await expect(rewind).toHaveCSS("border-top-left-radius", "0px");
    await expect(save).toHaveCSS("border-right-width", "0px");
    await expect(rewind).toHaveCSS(
      "border-left-width",
      theme === "classic" ? "1px" : "0px",
    );
    const group = page.getByRole("group", {
      name: "Project history",
      exact: true,
    });
    const separator = group.locator(".button-group-separator");
    if (theme === "classic") await expect(separator).toBeHidden();
    else {
      const stroke = await separator.evaluate((element) => {
        const style = getComputedStyle(element, "::before");
        return { top: style.top, bottom: style.bottom, height: style.height };
      });
      expect(stroke).toEqual({ top: "8px", bottom: "8px", height: "16px" });
    }
    await group.screenshot({
      path: `test-results/checkpoint-group-${theme}.png`,
    });
    await save.hover();
    await group.screenshot({
      path: `test-results/checkpoint-group-${theme}-hover.png`,
    });
  }
});

test("normal project demo can save and inspect a labeled checkpoint", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  const view = page
    .locator('.workspace-view-mode-tab[aria-selected="false"]')
    .first();
  const idleColor = await view.evaluate(
    (element) => getComputedStyle(element).color,
  );
  for (const name of ["Save checkpoint", "Rewind"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCSS(
      "color",
      idleColor,
    );
  }
  await page
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .hover();
  await expect(
    page.getByRole("button", { name: "Save checkpoint", exact: true }),
  ).not.toHaveCSS("color", idleColor);
  await page
    .getByRole("group", { name: "Project history", exact: true })
    .screenshot({ path: "test-results/checkpoint-idle-hover.png" });
  const rewind = page.getByRole("button", { name: "Rewind", exact: true });
  const rewindLabel = rewind.locator(".workspace-history-rewind-label");
  await expect(rewindLabel).toBeVisible();
  await page.screenshot({ path: "test-results/rewind-label-wide.png" });
  await page.setViewportSize({ width: 780, height: 720 });
  await expect(rewindLabel).toBeHidden();
  await expect(rewind).toHaveCSS("width", "32px");
  await page.screenshot({ path: "test-results/rewind-label-compact.png" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(rewindLabel).toBeVisible();
  await page
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Save checkpoint",
    exact: true,
  });
  await dialog
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Demo checkpoint");
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/checkpoint-normal-demo.png" });
  await dialog
    .getByRole("button", { name: "Save checkpoint", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Rewind", exact: true }).click();
  await expect(page.getByTestId("history-front-card")).toContainText(
    "Demo checkpoint",
  );
  await expect(page.getByTestId("history-front-card")).toContainText(
    "Welcome to your workspace",
  );
});
