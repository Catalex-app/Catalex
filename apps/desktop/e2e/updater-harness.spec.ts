import { expect, test } from "@playwright/test";

test("welcome sidebar update opens About before the manual release action", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto("/?debug=updater");
  const footer = page.locator(".sidebar-utility-controls");
  const update = footer.getByRole("button", {
    name: "Update available: Catalex 0.1.1-beta",
  });
  await expect(update).toBeVisible();
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "flex-grow",
    "0",
  );
  const settingsBounds = await footer
    .getByRole("button", { name: "Settings", exact: true })
    .boundingBox();
  const updateBounds = await update.boundingBox();
  const appearanceBounds = await footer
    .getByRole("button", { name: "Appearance", exact: true })
    .boundingBox();
  expect(settingsBounds!.x + settingsBounds!.width).toBeLessThan(
    updateBounds!.x,
  );
  expect(updateBounds!.x + updateBounds!.width).toBeLessThan(
    appearanceBounds!.x,
  );
  await page.screenshot({ path: "../../output/updater-welcome.png" });
  await footer.screenshot({
    path: "../../output/updater-footer-available.png",
  });
  const popupPromise = page.waitForEvent("popup");
  await update.click();
  const settings = await popupPromise;
  await expect(settings).toHaveURL(/section=about/);
  await expect(settings.getByRole("status")).toContainText(
    "0.1.1-beta available",
  );
  expect(
    await page.evaluate(() => window.__updaterHarness!.openedUrls),
  ).toEqual([]);
  await settings
    .getByRole("button", { name: "Install update", exact: true })
    .click();
  await expect
    .poll(() => settings.evaluate(() => window.__updaterHarness!.openedUrls))
    .toEqual([
      "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
    ]);
  expect(
    await settings.evaluate(() =>
      window.__updaterHarness!.calls.some((c) => /install|relaunch/.test(c)),
    ),
  ).toBe(false);
});

for (const project of [false, true]) {
  test(`${project ? "project" : "welcome"} sidebar gives Settings the remaining width without an update`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 850 });
    const route = project
      ? "/?onboarding-demo&project&update-demo"
      : "/?debug=updater";
    await page.goto(route);
    const footer = page.locator(".sidebar-utility-controls");
    const update = footer.getByRole("button", { name: /Update available:/ });
    await expect(update).toBeVisible();
    await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
      "flex-grow",
      "0",
    );
    const narrow = await footer
      .getByRole("button", { name: "Settings", exact: true })
      .boundingBox();
    if (project) {
      await expect(page.locator(".cm-content").first()).toBeVisible();
      await page.screenshot({ path: "../../output/updater-project.png" });
      const popupPromise = page.waitForEvent("popup");
      await update.click();
      const settings = await popupPromise;
      await expect(settings).toHaveURL(/section=about/);
      await expect(settings.getByRole("status")).toContainText(
        "0.1.1-beta available",
      );
      await settings.close();
    }
    await page.goto(`${route}${project ? "=current" : "&scenario=current"}`);
    await expect(
      footer.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    if (project)
      await expect(page.locator(".cm-content").first()).toBeVisible();
    await expect(update).toHaveCount(0);
    await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
      "flex-grow",
      "1",
    );
    await expect(
      footer
        .getByRole("button", { name: "Settings", exact: true })
        .locator("kbd"),
    ).toBeVisible();
    const wide = await footer
      .getByRole("button", { name: "Settings", exact: true })
      .boundingBox();
    const appearance = await footer
      .getByRole("button", { name: "Appearance", exact: true })
      .boundingBox();
    expect(wide!.width).toBeGreaterThan(narrow!.width + 50);
    expect(Math.abs(appearance!.x - (wide!.x + wide!.width) - 8)).toBeLessThan(
      1,
    );
    await footer.screenshot({
      path: `../../output/updater-footer-current-${project ? "project" : "welcome"}.png`,
    });
  });
}

test("update footer compacts Settings and adapts its solid action to available space", async ({
  page,
}) => {
  await page.goto("/?debug=updater");
  const footer = page.locator(".sidebar-utility-controls");
  const settings = footer.getByRole("button", {
    name: "Settings",
    exact: true,
  });
  const update = footer.getByRole("button", { name: /Update available:/ });
  await expect(update).toBeVisible();
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "flex-grow",
    "0",
  );
  await expect(settings.locator("span[data-settings-detail]")).toBeHidden();
  await expect(settings.locator("kbd")).toBeHidden();
  await footer.evaluate((element) => {
    element.style.width = "240px";
  });
  await expect(update).toHaveText("Update available", { useInnerText: true });
  const styles = await footer.evaluate((element) => {
    return [
      element.querySelector('[aria-label="Settings"]')!,
      element.querySelector('[aria-label^="Update available:"]')!,
    ].map((button) => {
      const style = getComputedStyle(button);
      const icon = getComputedStyle(button.querySelector("svg")!);
      return {
        font: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        iconWidth: icon.width,
        iconHeight: icon.height,
        stroke: icon.strokeWidth,
      };
    });
  });
  expect(styles[1]).toEqual(styles[0]);
  expect(styles[1].iconWidth).toBe("16px");
  expect(
    await update.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(255, 255, 255)");
  await footer.evaluate((element) => {
    element.style.width = "200px";
  });
  await expect(update).toHaveText("Update", { useInnerText: true });
  await expect(settings.locator("kbd")).toBeHidden();
  const right = await footer
    .getByRole("button", { name: "Appearance", exact: true })
    .boundingBox();
  const bounds = await footer.boundingBox();
  expect(right!.x + right!.width).toBeLessThanOrEqual(
    bounds!.x + bounds!.width + 1,
  );
  await footer.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(
    await update.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(255, 255, 255)");
});

for (const project of [false, true]) {
  test(`${project ? "project" : "welcome"} update expands smoothly without overlap or moving Appearance`, async ({
    page,
  }) => {
    await page.goto(
      `${project ? "/?onboarding-demo&project&update-demo" : "/?debug=updater"}&update-delay=1200`,
      { waitUntil: "domcontentloaded" },
    );
    const footer = page.locator(".sidebar-utility-controls");
    await expect(footer).toHaveAttribute("data-update-available", "false");
    const samples = await footer.evaluate(
      (element) =>
        new Promise<
          Array<{
            settings: number;
            update: number;
            overlap: number;
            appearance: number;
          }>
        >((resolve) => {
          const settings = element.querySelector(".sidebar-settings-button")!;
          const update = element.querySelector(".sidebar-update-slot")!;
          const appearance = element.querySelector(
            '[aria-label="Appearance"]',
          )!;
          const frames: Array<{
            settings: number;
            update: number;
            overlap: number;
            appearance: number;
          }> = [];
          const start = performance.now();
          function sample() {
            const s = settings.getBoundingClientRect();
            const u = update.getBoundingClientRect();
            const a = appearance.getBoundingClientRect();
            frames.push({
              settings: s.width,
              update: u.width,
              overlap: Math.max(0, s.right - u.left, u.right - a.left),
              appearance: a.left,
            });
            if (performance.now() - start < 1700) requestAnimationFrame(sample);
            else resolve(frames);
          }
          requestAnimationFrame(sample);
        }),
    );
    expect(samples[0].settings).toBeGreaterThan(samples.at(-1)!.settings + 100);
    expect(samples[0].update).toBeLessThan(1);
    expect(samples.at(-1)!.update).toBeGreaterThan(100);
    expect(
      new Set(samples.map((s) => Math.round(s.update))).size,
    ).toBeGreaterThan(3);
    expect(Math.max(...samples.map((s) => s.overlap))).toBeLessThan(1);
    expect(
      Math.max(...samples.map((s) => s.appearance)) -
        Math.min(...samples.map((s) => s.appearance)),
    ).toBeLessThan(1);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].settings).toBeLessThanOrEqual(
        samples[i - 1].settings + 1,
      );
      expect(samples[i].update).toBeGreaterThanOrEqual(
        samples[i - 1].update - 1,
      );
    }
    await footer.screenshot({
      path: `../../output/updater-motion-${project ? "project" : "welcome"}.png`,
    });
  });
}

test("reduced motion removes the update expansion and hidden updates cannot receive focus", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?debug=updater&update-delay=1200", {
    waitUntil: "domcontentloaded",
  });
  const footer = page.locator(".sidebar-utility-controls");
  await expect(footer).toHaveAttribute("data-update-available", "false");
  await expect(footer.getByRole("button", { name: /^Update/ })).toHaveCount(0);
  await footer.getByRole("button", { name: "Settings", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(
    footer.getByRole("button", { name: "Appearance", exact: true }),
  ).toBeFocused();
  await expect(footer).toHaveAttribute("data-update-available", "true");
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(footer.locator(".sidebar-update-slot")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(footer.locator("kbd")).toHaveCSS("transition-delay", "0s");
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "flex-grow",
    "0",
  );
});

test("known updates stay expanded when moving between a project and Welcome", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&update-demo");
  const footer = page.locator(".sidebar-utility-controls");
  await expect(
    footer.getByRole("button", { name: /Update available:/ }),
  ).toBeVisible();
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "flex-grow",
    "0",
  );
  const frames = await page.evaluate(async () => {
    const samples: Array<{
      project: boolean;
      available: string | undefined;
      settings: number;
      moving: boolean;
    }> = [];
    let sampling = true;
    function sample() {
      const footer = document.querySelector<HTMLElement>(
        ".sidebar-utility-controls",
      );
      if (footer)
        samples.push({
          project: !!document.querySelector(".cm-content"),
          available: footer.dataset.updateAvailable,
          settings: footer
            .querySelector(".sidebar-settings-button")!
            .getBoundingClientRect().width,
          moving: footer
            .getAnimations({ subtree: true })
            .some(
              (animation) =>
                animation instanceof CSSTransition &&
                animation.transitionProperty === "flex-grow",
            ),
        });
      if (sampling) requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
    document
      .querySelector<HTMLButtonElement>('[aria-label="Close project"]')!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Open sample project")!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    sampling = false;
    return samples;
  });
  expect(frames.length).toBeGreaterThan(10);
  expect(frames.some((frame) => frame.project)).toBe(true);
  expect(frames.some((frame) => !frame.project)).toBe(true);
  expect(
    frames.every(
      (frame) =>
        frame.available === "true" && frame.settings <= 33 && !frame.moving,
    ),
  ).toBe(true);
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.screenshot({
    path: "../../output/updater-known-after-navigation.png",
  });
});

test("full-app demo switches update states live in the workspace, welcome screen, and About", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&update-demo");
  const selector = page.getByRole("combobox", {
    name: "Update state",
    exact: true,
  });
  const footer = page.locator(".sidebar-utility-controls");
  const update = footer.getByRole("button", { name: /Update available:/ });
  await expect(update).toBeVisible();
  const editor = page.locator(".cm-content").first();
  const content = await editor.innerText();
  const popupPromise = page.waitForEvent("popup");
  await update.click();
  const settings = await popupPromise;
  await expect(settings.getByRole("status")).toHaveText("0.1.1-beta available");
  await selector.selectOption("current");
  await expect(update).toHaveCount(0);
  await expect(settings.getByRole("status")).toHaveText(
    "Catalex is up to date.",
  );
  await expect(editor).toHaveText(content, { useInnerText: true });
  await selector.selectOption("available");
  await expect(update).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Install update", exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Skip this version", exact: true })
    .click();
  await expect(update).toHaveCount(0);
  await selector.selectOption("current");
  await selector.selectOption("available");
  await expect(update).toBeVisible();
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .click();
  await expect(update).toBeVisible();
  await selector.selectOption("current");
  await expect(update).toHaveCount(0);
  await selector.selectOption("available");
  await expect(update).toBeVisible();
});

test("About keeps a version skipped across windows, reloads, and explicit refreshes", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project&update-demo");
  const footer = page.locator(".sidebar-utility-controls");
  const update = footer.getByRole("button", { name: /Update available:/ });
  await expect(update).toBeVisible();
  await update.hover();
  await page.waitForTimeout(800);
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const popupPromise = page.waitForEvent("popup");
  await update.click();
  const settings = await popupPromise;
  await expect(settings.getByRole("status")).toContainText(
    "0.1.1-beta available",
  );
  await expect(
    settings.locator('[data-settings-row-id="about-source"]'),
  ).toHaveCount(0);
  await expect(
    settings.getByText("GitHub Releases", { exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByText("Beta · GitHub Releases", { exact: true }),
  ).toHaveCount(0);
  await settings
    .getByRole("button", { name: "Skip this version", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText("Skipped 0.1.1-beta");
  await expect(update).toHaveCount(0);
  await expect(footer.locator(".sidebar-settings-button")).toHaveCSS(
    "flex-grow",
    "1",
  );
  await expect(
    footer
      .getByRole("button", { name: "Settings", exact: true })
      .locator("kbd"),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(update).toHaveCount(0);
  await settings.reload();
  await expect(settings.getByRole("status")).toHaveText("Skipped 0.1.1-beta");
  await settings
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(settings.getByRole("status")).toHaveText("Skipped 0.1.1-beta");
  await expect(
    settings.getByRole("button", { name: "Install update", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByText("Newer versions will still be shown.", { exact: true }),
  ).toHaveCount(0);
  const viewRelease = settings.getByRole("button", {
    name: "View release",
    exact: true,
  });
  await expect(viewRelease).toBeVisible();
  const statusBounds = await settings.getByRole("status").boundingBox();
  const actionBounds = await viewRelease.boundingBox();
  expect(
    Math.abs(
      statusBounds!.y +
        statusBounds!.height / 2 -
        actionBounds!.y -
        actionBounds!.height / 2,
    ),
  ).toBeLessThanOrEqual(1);
  const dialogPromise = settings.waitForEvent("dialog");
  const clickPromise = viewRelease.click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("releases/tag/v0.1.1-beta");
  await dialog.accept();
  await clickPromise;
  await expect(settings.getByRole("status")).toHaveText("Skipped 0.1.1-beta");
  await expect(update).toHaveCount(0);
});

for (const width of [720, 900, 1280]) {
  test(`About update states and manual release action fit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto("/?debug=updater&view=settings");
    await page.getByRole("button", { name: "About", exact: true }).click();
    await page
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "0.1.1-beta available",
    );
    await expect(
      page.getByText("GitHub Releases", { exact: true }),
    ).toBeVisible();
    const rowItems = await Promise.all([
      page.getByRole("status").boundingBox(),
      page
        .getByRole("button", { name: "Skip this version", exact: true })
        .boundingBox(),
      page
        .getByRole("button", { name: "Install update", exact: true })
        .boundingBox(),
    ]);
    const centers = rowItems.map((bounds) => bounds!.y + bounds!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../../output/updater-about-${width}.png` });
    await page
      .getByRole("button", { name: "Install update", exact: true })
      .click();
    expect(
      await page.evaluate(() => window.__updaterHarness!.openedUrls),
    ).toEqual([
      "https://github.com/Catalex-app/Catalex/releases/tag/v0.1.1-beta",
    ]);
    await page.evaluate(() => {
      window.__updaterHarness!.scenario = "current";
    });
    await page
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText("Catalex is up to date.");
    await expect(
      page.getByRole("button", { name: "Install update" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("failed update checks can be retried without a false up-to-date message", async ({
  page,
}) => {
  await page.goto("/?debug=updater&view=settings&scenario=error");
  await page.getByRole("button", { name: "About", exact: true }).click();
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Could not reach GitHub",
  );
  await page.evaluate(() => {
    window.__updaterHarness!.scenario = "available";
  });
  await page
    .getByRole("button", { name: "Check for updates", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Install update", exact: true }),
  ).toBeVisible();
});
