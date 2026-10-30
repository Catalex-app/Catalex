import { expect, test, type Page } from "@playwright/test";

async function openPreview(page: Page, empty = false) {
  await page.goto(`/?debug=pdf-preview${empty ? "&empty" : ""}`);
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await page.evaluate(() => window.__pdfPreviewHarness?.initialize());
}

async function openOptions(page: Page) {
  if (
    !(await page.getByRole("menu", { name: "Compilation options" }).isVisible())
  ) {
    await page.getByRole("button", { name: "Compilation options" }).click();
  }
  return page.getByRole("menuitemcheckbox", { name: "Auto compile" });
}

async function count(page: Page) {
  return page.evaluate(() =>
    window.__pdfPreviewHarness?.getCompileRequestCount(),
  );
}

async function idle(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.__pdfPreviewHarness?.isCompiling()))
    .toBe(false);
}

async function expectNoCompile(page: Page, expected: number) {
  // Longer than the 800 ms debounce and the minimum compile indicator duration.
  await page.waitForTimeout(1500);
  expect(await count(page)).toBe(expected);
}

test("grouped controls select each compiler and preserve manual recompilation with auto off", async ({
  page,
}) => {
  await openPreview(page);
  const toggle = await openOptions(page);
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "LuaLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  const before = (await count(page))!;
  const choices = [
    ["pdfLaTeX", "latexmk", "pdflatex"],
    ["XeLaTeX", "latexmk", "xelatex"],
    ["LuaLaTeX", "latexmk", "lualatex"],
    ["Tectonic", "tectonic", "lualatex"],
  ] as const;
  for (const [label, backend, engine] of choices) {
    await openOptions(page);
    await page
      .getByRole("menuitemradio", {
        name: label,
        exact: true,
      })
      .click();
    await expectNoCompile(
      page,
      before + choices.findIndex((choice) => choice[0] === label),
    );
    await openOptions(page);
    await expect(
      page.getByRole("menuitemradio", {
        name: label,
        exact: true,
      }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Recompile", exact: true }).click();
    await expect
      .poll(() => count(page))
      .toBe(before + choices.findIndex((choice) => choice[0] === label) + 1);
    await idle(page);
    const requests = await page.evaluate(() =>
      window.__pdfPreviewHarness?.getCompileRequestChoices(),
    );
    expect(requests?.at(-1)).toEqual({ backend, engine });
  }
  await page.reload();
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await expect(await openOptions(page)).toHaveAttribute(
    "aria-checked",
    "false",
  );
});

test("project toggles are independent and settings defaults apply only to newly opened projects", async ({
  page,
  context,
}) => {
  await openPreview(page);
  const settings = await context.newPage();
  await settings.goto("/?debug=markdown-settings");
  await settings
    .getByRole("button", { name: "Rendering", exact: true })
    .click();
  const defaultToggle = settings.getByRole("switch", {
    name: "Auto compile for new projects",
    exact: true,
  });
  await expect(defaultToggle).toHaveAttribute("aria-checked", "true");
  await defaultToggle.click();
  // Updating the default does not change an already opened project.
  await expect(await openOptions(page)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  const second = await context.newPage();
  await second.goto("/?debug=pdf-preview&project=second");
  await expect(second.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await expect(await openOptions(second)).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await (await openOptions(second)).click();
  await expect(defaultToggle).toHaveAttribute("aria-checked", "false");
  const before = (await count(page))!;
  await page.evaluate(() =>
    window.__pdfPreviewHarness?.setSourceContent("Pending edit"),
  );
  await (await openOptions(page)).click();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    window.__pdfPreviewHarness?.setSourceContent("Latest source while off");
    window.__pdfPreviewHarness?.requestMergePreviewRefresh();
  });
  await expectNoCompile(page, before);
  // A second window on the same project sees its persisted toggle.
  await page.reload();
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await expect(await openOptions(page)).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.evaluate(() => window.__pdfPreviewHarness?.initialize());
  await expect(await openOptions(second)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  // The other project's changes cannot enable this project's pending work.
  await page.keyboard.press("Escape");
  await defaultToggle.click();
  await expect(await openOptions(page)).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await (await openOptions(page)).click();
  await page.evaluate(() =>
    window.__pdfPreviewHarness?.setSourceContent("Resumed source"),
  );
  await expect.poll(() => count(page)).toBe(1);
  await idle(page);
  await settings.reload();
  await settings
    .getByRole("button", { name: "Rendering", exact: true })
    .click();
  await expect(defaultToggle).toHaveAttribute("aria-checked", "true");
  await settings.screenshot({
    path: test.info().outputPath("rendering-defaults.png"),
    animations: "disabled",
  });
  await second.close();
  await settings.close();
});

test("automatic compilation handles edits for both backends and can be disabled during compilation", async ({
  page,
}) => {
  await openPreview(page);
  const before = (await count(page))!;
  await page.evaluate(() =>
    window.__pdfPreviewHarness?.setSourceContent("Automatic Latexmk edit"),
  );
  await expect.poll(() => count(page)).toBe(before + 1);
  await idle(page);
  await openOptions(page);
  await page
    .getByRole("menuitemradio", { name: "Tectonic", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect.poll(() => count(page)).toBe(before + 2);
  await idle(page);
  await page.evaluate(() => {
    window.__pdfPreviewHarness?.setCompileDelay(3000);
    window.__pdfPreviewHarness?.setSourceContent("Automatic Tectonic edit");
  });
  await expect.poll(() => count(page)).toBe(before + 3);
  await expect(
    page.getByRole("button", { name: "Recompile", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Recompile", exact: true }),
  ).toContainText("Compiling...");
  await page.evaluate(() =>
    window.__pdfPreviewHarness?.setSourceContent("Queued edit"),
  );
  await page.waitForTimeout(900);
  await (await openOptions(page)).click();
  await page.keyboard.press("Escape");
  await idle(page);
  await expectNoCompile(page, before + 3);
  await expect(
    page.getByRole("button", { name: "Recompile", exact: true }),
  ).toBeEnabled();
});

test("auto off skips the initial compile and manual retry recovers an error", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({ version: 24, state: { defaultAutoCompile: false } }),
    );
  });
  await openPreview(page, true);
  await expectNoCompile(page, 0);
  await expect(
    page.getByText("Click Compile to preview your document"),
  ).toBeVisible();
  await page.evaluate(() => window.__pdfPreviewHarness?.failNextCompile());
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await expect(
    page.getByText("Compilation Failed", { exact: true }),
  ).toBeVisible();
  await idle(page);
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await expect(page.locator(".mupdf-page canvas").first()).toBeVisible();
  await idle(page);
  expect(await count(page)).toBe(2);
});

for (const width of [400, 520, 1100]) {
  test(`compilation dropdown fits the preview at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await openPreview(page);
    if (width == 400) {
      await page.evaluate(() => document.documentElement.classList.add("dark"));
    }
    // Hide the fixture-only agent inspection so it cannot cover the toolbar.
    await page.locator("aside").evaluate((element) => element.remove());
    const group = page.getByRole("group", { name: "Compilation", exact: true });
    const bounds = await group.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    const toolbar = page.locator("[data-pdf-toolbar]");
    await expect
      .poll(() =>
        toolbar.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      )
      .toBe(true);
    await openOptions(page);
    await expect(
      page.getByRole("menuitemradio", { name: "Tectonic", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`compilation-${width}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Compilation options" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Compilation options" }),
    ).toBeFocused();
  });
}

test("Recompile becomes icon-only only when the preview pane runs out of room", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openPreview(page);
  await page.locator("aside").evaluate((element) => element.remove());
  const pane = page.getByTestId("pdf-preview-harness-shell");
  const button = page.getByRole("button", { name: "Recompile", exact: true });
  const label = button.getByText("Recompile", { exact: true });
  const toolbar = page.locator("[data-pdf-toolbar]");
  const buttonWidth = () => button.evaluate((element) => element.clientWidth);
  const expectFits = async () => {
    await expect
      .poll(() =>
        toolbar.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      )
      .toBe(true);
  };

  await pane.evaluate((element) => {
    element.style.width = "400px";
  });
  await expect(label).toBeVisible();
  await expect.poll(buttonWidth).toBe(100);
  await expectFits();

  // Resize only the pane: the browser viewport remains wide.
  await pane.evaluate((element) => {
    element.style.width = "320px";
  });
  await expect(label).toBeHidden();
  await expect.poll(buttonWidth).toBe(28);
  await expectFits();
  await button.hover();
  await expect(
    page.getByRole("tooltip", { name: "Recompile", exact: true }),
  ).toBeVisible();
  await page.mouse.move(300, 400);
  await openOptions(page);
  await expect(
    page.getByRole("menuitemradio", { name: "Tectonic", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__pdfPreviewHarness?.setCompileDelay(2000));
  await button.click();
  await expect(button.locator("svg")).toHaveClass(/animate-spin/);
  await expect.poll(buttonWidth).toBe(28);
  await expectFits();
  await page.screenshot({
    path: test.info().outputPath("icon-only-compiling.png"),
    animations: "disabled",
  });
  await idle(page);
  await page.screenshot({
    path: test.info().outputPath("icon-only-idle.png"),
    animations: "disabled",
  });

  await pane.evaluate((element) => {
    element.style.width = "400px";
  });
  await expect(label).toBeVisible();
  await expect.poll(buttonWidth).toBe(100);
  await expectFits();
});

test("the default Auto engine becomes a concrete document choice that survives overrides and reload", async ({
  page,
  context,
}) => {
  await openPreview(page);
  await (await openOptions(page)).click();
  await expect(page.getByRole("menuitemradio", { name: /^Auto/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("menuitemradio", { name: "LuaLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitemradio", { name: "XeLaTeX", exact: true })
    .click();
  const settings = await context.newPage();
  await settings.goto("/?debug=markdown-settings");
  await settings
    .getByRole("button", { name: "Rendering", exact: true })
    .click();
  await settings
    .locator('[data-settings-row-id="compiler-engine"]')
    .getByRole("combobox")
    .click();
  await settings.getByRole("option", { name: "pdfLaTeX", exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "XeLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await openOptions(page);
  await expect(
    page.getByRole("menuitemradio", { name: "XeLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  // A newly seen root uses the new default, rather than another document's choice.
  const second = await context.newPage();
  await second.goto("/?debug=pdf-preview&project=new-engine");
  await expect(second.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await openOptions(second);
  await expect(
    second.getByRole("menuitemradio", { name: "pdfLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: test.info().outputPath("concrete-engine.png"),
    animations: "disabled",
  });
  await second.close();
  await settings.close();
});

test("compilation settings stay open for pointer and keyboard edits and dismiss outside", async ({
  page,
}) => {
  await openPreview(page);
  const toggle = await openOptions(page);
  const menu = page.getByRole("menu", { name: "Compilation options" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(menu).toBeVisible();
  for (const name of ["pdfLaTeX", "XeLaTeX", "LuaLaTeX", "Tectonic"]) {
    const option = menu.getByRole("menuitemradio", { name, exact: true });
    await option.click();
    await expect(option).toHaveAttribute("aria-checked", "true");
    await expect(menu).toBeVisible();
  }
  // Selecting the current value and clicking the header also preserve the panel.
  await menu
    .getByRole("menuitemradio", { name: "LuaLaTeX", exact: true })
    .click();
  await menu.getByText("Compiler settings", { exact: true }).click();
  await expect(menu).toBeVisible();
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible();
  const engine = menu.getByRole("menuitemradio", {
    name: "XeLaTeX",
    exact: true,
  });
  await engine.focus();
  await page.keyboard.press("Enter");
  await expect(engine).toHaveAttribute("aria-checked", "true");
  await expect(menu).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("settings-stay-open.png"),
    animations: "disabled",
  });
  await page.mouse.click(500, 500);
  await expect(menu).toHaveCount(0);
  await openOptions(page);
  await expect(
    menu.getByRole("menuitemradio", { name: "XeLaTeX", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Compilation options" }),
  ).toBeFocused();
});

test("other action menus still close after selecting an item", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions");
  await page.getByRole("button", { name: "More git actions" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
});
