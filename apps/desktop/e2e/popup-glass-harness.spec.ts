import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"]) {
  test(`shared glass surfaces and overrides in ${theme} mode`, async ({
    page,
  }) => {
    await page.goto("/?debug=context-menu");
    if (theme === "dark")
      await page.getByRole("button", { name: "Toggle theme" }).click();
    const override = page.getByTestId("glass-override");
    const overrideShadow = await override.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    );
    expect(
      overrideShadow
        .replaceAll("rgba(0, 0, 0, 0) 0px 0px 0px 0px", "")
        .replaceAll(", ", ""),
    ).toBe("");
    const overrideColors = await override.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, border: style.borderColor };
    });
    expect(overrideColors.background).not.toContain("0.86");
    await page
      .getByRole("button", { name: "Glass popover", exact: true })
      .click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible();
    const finish = await popover.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        border: style.borderColor,
        shadow: style.boxShadow,
        filter: style.backdropFilter,
      };
    });
    expect(finish.filter).toBe("blur(18px) saturate(0.9)");
    expect(finish.background).toContain("0.86");
    await page.screenshot({
      path: `test-results/glass-popover-${theme}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.getByRole("combobox", { name: "Glass select" }).click();
    const select = page.locator('[data-slot="select-content"]');
    await expect(select).toHaveCSS("backdrop-filter", finish.filter);
    await expect(select).toHaveCSS("box-shadow", finish.shadow);
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Open dialog", exact: true })
      .click();
    const dialog = page.locator('[data-slot="dialog-content"]');
    await expect(dialog).toHaveCSS("background-color", finish.background);
    await expect(dialog).toHaveCSS("border-color", finish.border);
    await expect(dialog).toHaveCSS("box-shadow", finish.shadow);
    await page.screenshot({
      path: `test-results/glass-dialog-${theme}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page
      .getByRole("button", { name: "Glass tooltip", exact: true })
      .hover();
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    await expect(tooltip).toBeVisible();
    const expectedTooltipColors = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--foreground)";
      probe.style.color = "var(--background)";
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const colors = { background: style.backgroundColor, text: style.color };
      probe.remove();
      return colors;
    });
    await expect(tooltip).toHaveCSS(
      "background-color",
      expectedTooltipColors.background,
    );
    await expect(tooltip).toHaveCSS("color", expectedTooltipColors.text);
    await expect(tooltip).toHaveCSS("backdrop-filter", "none");
    await page.screenshot({
      path: `test-results/glass-tooltip-${theme}.png`,
      animations: "disabled",
    });
    await page.mouse.move(0, 0);
    await page.evaluate(
      () => (document.documentElement.dataset.uiTheme = "classic"),
    );
    await page
      .getByRole("button", { name: "Glass popover", exact: true })
      .click();
    await expect(popover).toHaveCSS(
      "backdrop-filter",
      theme === "dark"
        ? "blur(18px) saturate(1.1)"
        : "blur(10px) saturate(1.1)",
    );
  });
}
