import { expect, test } from "@playwright/test";

for (const theme of ["modern", "classic"]) {
  for (const appearance of ["light", "dark"]) {
    test(`${theme} ${appearance}: pointer dismissal is quiet and keyboard focus remains visible`, async ({
      page,
    }) => {
      await page.goto("/?debug=focus");
      await page.getByRole("button", { name: "Save", exact: true }).waitFor();
      await page.evaluate(
        ({ theme, appearance }) => {
          document.documentElement.dataset.uiTheme = theme;
          document.documentElement.classList.toggle(
            "dark",
            appearance === "dark",
          );
        },
        { theme, appearance },
      );
      const actions = page.getByRole("button", {
        name: "Actions",
        exact: true,
      });
      await actions.click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.mouse.click(700, 350);
      await expect(page.getByRole("menu")).toBeHidden();
      await expect(actions).toBeFocused();
      await expect(actions).toHaveCSS("outline-style", "none");

      // Escape switches input intent back to keyboard and restores the trigger.
      await actions.click();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "First action" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(actions).toBeFocused();
      await expect(actions).toHaveCSS("outline-style", "solid");
      await expect(actions).toHaveCSS("outline-offset", "-3px");
      await page.waitForTimeout(250);
      await page.screenshot({
        path: `test-results/focus-${theme}-${appearance}.png`,
      });

      await page.keyboard.press("Tab");
      const select = page.getByRole("combobox", { name: "Format" });
      await expect(select).toBeFocused();
      await expect(select).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("option", { name: "LaTeX", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("option", { name: "Markdown", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(select).toHaveText("Markdown");
      await expect(select).toBeFocused();
      await expect(select).toHaveCSS("outline-style", "solid");
      await select.click();
      await page.mouse.click(700, 350);
      await expect(select).toBeFocused();
      await expect(select).toHaveCSS("outline-style", "none");

      for (const control of [
        page.getByRole("button", { name: "Manual", exact: true }),
        page.getByRole("tab", { name: "Artisan" }),
      ]) {
        await control.click();
        await expect(control).toHaveCSS("outline-style", "none");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(control).toBeFocused();
        await expect(control).toHaveCSS("outline-style", "solid");
        await expect(control).toHaveCSS("outline-offset", "-3px");
        expect(
          await control.evaluate((el) =>
            getComputedStyle(el).getPropertyValue("--tw-ring-shadow").trim(),
          ),
        ).toBe("0 0 #0000");
      }
      await page.waitForTimeout(250);
      await page.screenshot({
        path: `test-results/focus-buttons-${theme}-${appearance}.png`,
      });

      // Pointer focus colors the existing input border without a wide halo.
      const input = page.getByRole("textbox", { name: "Project name" });
      await input.click();
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "none");
      await expect(input).toHaveCSS(
        "border-color",
        await input.evaluate((el) => getComputedStyle(el).color),
      );
      expect(
        await input.evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--tw-ring-shadow").trim(),
        ),
      ).toBe("0 0 #0000");
      await page.screenshot({
        path: `test-results/focus-input-pointer-${theme}-${appearance}.png`,
      });
      await page.keyboard.press("Shift+Tab");
      await expect(select).toBeFocused();
      await expect(select).toHaveCSS("outline-style", "solid");
      const keyboardOutlineWidth = await select.evaluate(
        (el) => getComputedStyle(el).outlineWidth,
      );
      await page.keyboard.press("Tab");
      await expect(input).toBeFocused();
      await expect(input).toHaveCSS("outline-style", "solid");
      await expect(input).toHaveCSS("outline-width", keyboardOutlineWidth);
      await expect(input).toHaveCSS("outline-offset", "-3px");
      await page.screenshot({
        path: `test-results/focus-input-keyboard-${theme}-${appearance}.png`,
      });
    });
  }
}

for (const theme of ["modern", "classic"]) {
  test(`${theme}: focus follows visible workspace controls`, async ({
    page,
  }) => {
    await page.goto("/?debug=focus");
    const open = page.getByRole("button", {
      name: "Open in Finder",
      exact: true,
    });
    await expect(open).toBeVisible();
    await page.evaluate((value) => {
      document.documentElement.dataset.uiTheme = value;
    }, theme);
    await open.click();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(open).toBeFocused();
    await expect(open).toHaveCSS("outline-style", "solid");
    await expect(open).toHaveCSS("outline-offset", "-3px");
    await expect(page.locator(".external-app-selector")).toHaveCSS(
      "outline-style",
      "none",
    );
    expect(
      await open.evaluate((el) =>
        parseFloat(getComputedStyle(el).borderTopLeftRadius),
      ),
    ).toBeGreaterThan(4);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `test-results/focus-split-open-${theme}.png`,
    });
    await page.keyboard.press("Tab");
    const choose = page.getByRole("button", {
      name: "Choose editor app",
      exact: true,
    });
    await expect(choose).toBeFocused();
    await expect(choose).toHaveCSS("outline-style", "solid");
    await expect(choose).toHaveCSS("outline-offset", "-3px");
    await expect(page.locator(".external-app-selector")).toHaveCSS(
      "outline-style",
      "none",
    );
    expect(
      await choose.evaluate((el) =>
        parseFloat(getComputedStyle(el).borderTopRightRadius),
      ),
    ).toBeGreaterThan(4);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `test-results/focus-split-choose-${theme}.png`,
    });
    await page.keyboard.press("Tab");
    const activate = page.getByRole("button", {
      name: "conference.tex",
      exact: true,
    });
    await expect(activate).toBeFocused();
    await expect(activate).toHaveCSS("outline-style", "none");
    const tab = page.locator(".editor-file-tab").first();
    await expect(tab).toHaveCSS("outline-style", "solid");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/focus-file-tab-${theme}.png` });
    await page.keyboard.press("Tab");
    const close = page.getByRole("button", {
      name: "Close conference.tex",
      exact: true,
    });
    await expect(close).toBeFocused();
    await expect(tab).toHaveCSS("outline-style", "none");
    const box = await close.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(20);
    expect(box?.height).toBeGreaterThanOrEqual(20);
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `test-results/focus-file-close-${theme}.png`,
    });
    await page.keyboard.press("Enter");
    await expect(activate).toHaveCount(0);
  });
}

test("sidebar files have exactly one keyboard stop per row", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation");
  const rows = page.locator("[data-sidebar-file-id]");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThan(2);
  await rows.first().focus();
  for (let index = 1; index < (await rows.count()); index++) {
    await page.keyboard.press("Tab");
    await expect(rows.nth(index)).toBeFocused();
    await expect(rows.nth(index)).toHaveCSS("outline-style", "solid");
    expect(
      await rows
        .nth(index)
        .evaluate((el) => parseFloat(getComputedStyle(el).borderRadius)),
    ).toBeGreaterThan(0);
  }
  await page.keyboard.press("Shift+Tab");
  await expect(rows.nth((await rows.count()) - 2)).toBeFocused();
  await page.waitForTimeout(250);
  await page.screenshot({ path: "test-results/focus-sidebar-row.png" });
});

test("collapsed sidebar bodies skip focus without unmounting or changing animation", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation");
  for (const section of [
    "files",
    "outline",
    "zotero",
    "system-prompts",
    "sessions",
  ]) {
    if (section === "sessions")
      await page.getByRole("button", { name: /Toggle Mode/ }).click();
    const panel = page.locator(`[data-sidebar-section="${section}"]`);
    const toggle = panel.locator("[data-sidebar-toggle]").first();
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    const body = panel.locator('div[aria-hidden="false"]').first();
    await expect(body).toBeAttached();
    const count = await body
      .locator("button, input, textarea, a[href]")
      .count();
    const duration = await body.evaluate(
      (el) => getComputedStyle(el).transitionDuration,
    );
    const focusable = body
      .locator("button:enabled, input:enabled, textarea:enabled, a[href]")
      .first();
    const hadFocusable = (await focusable.count()) > 0;
    if (hadFocusable) await focusable.focus();
    // Programmatic collapse keeps focus inside until the component returns it.
    await toggle.evaluate((el) => el.click());
    const hiddenBody = panel.locator('div[aria-hidden="true"]').first();
    await expect(hiddenBody).toHaveAttribute("inert", "");
    if (hadFocusable) await expect(toggle).toBeFocused();
    expect(
      await hiddenBody.locator("button, input, textarea, a[href]").count(),
    ).toBe(count);
    expect(
      await hiddenBody.evaluate(
        (el) => getComputedStyle(el).transitionDuration,
      ),
    ).toBe(duration);
    await toggle.focus();
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
      expect(
        await hiddenBody.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(false);
    }
    await toggle.click();
    await expect(
      panel.locator('div[aria-hidden="false"]').first(),
    ).not.toHaveAttribute("inert");
  }
  await expect(page.locator('[data-sidebar-section="zotero"]')).toHaveAttribute(
    "inert",
    "",
  );
  // Sessions mode retains the outline while suppressing Zotero.
  const outline = page.locator('[data-sidebar-section="outline"]');
  await expect(outline).not.toHaveAttribute("inert");
  const outlineToggle = outline.locator("[data-sidebar-toggle]").first();
  await outlineToggle.focus();
  await expect(outlineToggle).toBeFocused();
});
