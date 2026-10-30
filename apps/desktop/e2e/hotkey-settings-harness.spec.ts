import { expect, test } from "@playwright/test";

test("customizes keyboard shortcuts and prevents conflicts", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-settings", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Keyboard" }).click();
  await expect(
    page.getByRole("heading", { name: "Keyboard Shortcuts" }),
  ).toBeVisible();
  const primaryModifier = await page.evaluate(() =>
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? "Meta" : "Control",
  );

  const saveRow = page.locator('[data-settings-row-id="keyboard-save-file"]');
  const newWindowRow = page.locator(
    '[data-settings-row-id="keyboard-new-window"]',
  );
  const settingsRow = page.locator(
    '[data-settings-row-id="keyboard-open-settings"]',
  );

  await expect(
    saveRow.getByRole("button", { name: "Change Save File shortcut" }),
  ).toContainText(/Ctrl|⌘/);
  await expect(newWindowRow).not.toContainText("Open another Catalex window");

  await newWindowRow
    .getByRole("button", { name: "Change New Window shortcut" })
    .click();
  await page.keyboard.press(`${primaryModifier}+Shift+A`);
  await expect(
    newWindowRow.getByRole("button", {
      name: "Change New Window shortcut",
    }),
  ).toContainText("A");

  await settingsRow
    .getByRole("button", { name: "Change Open Settings shortcut" })
    .click();
  await page.keyboard.press(`${primaryModifier}+S`);
  await expect(settingsRow).toContainText("Already used by Save File.");
  await page.keyboard.press("Escape");

  await saveRow
    .getByRole("button", { name: "Change Save File shortcut" })
    .click();
  await page.keyboard.press("Backspace");
  await expect(saveRow).toContainText("Unassigned");

  const persisted = await page.evaluate(() => {
    const raw = localStorage.getItem("catalex-settings");
    if (!raw) return null;
    return JSON.parse(raw).state?.keyboardShortcutOverrides;
  });
  expect(persisted).toEqual({
    "new-window": "Mod+Shift+KeyA",
    "save-file": null,
  });

  await page.getByRole("button", { name: "Reset All" }).click();
  await expect(saveRow).not.toContainText("Unassigned");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("catalex-settings");
        if (!raw) return null;
        return JSON.parse(raw).state?.keyboardShortcutOverrides;
      }),
    )
    .toEqual({});

  await page.screenshot({
    path: "test-results/hotkey-settings.png",
    fullPage: true,
  });
});
