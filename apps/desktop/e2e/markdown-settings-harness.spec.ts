import { expect, test } from "@playwright/test";

test("sets the default Markdown math engine without replacing file choices", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-settings");
  await page.getByRole("button", { name: "Rendering", exact: true }).click();
  const engine = page.getByRole("combobox", {
    name: "Default Markdown math engine",
  });
  await expect(engine).toContainText("KaTeX (fast)");
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore
      .getState()
      .setMarkdownMathEngineForFile("/project", "explicit.md", "katex");
  });
  await engine.click();
  await page
    .getByRole("option", { name: "MathJax (OpenReview)", exact: true })
    .click();
  await expect(engine).toContainText("MathJax (OpenReview)");
  expect(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      const state = useSettingsStore.getState();
      return [
        state.getMarkdownMathEngineForFile("/project", "inherited.md"),
        state.getMarkdownMathEngineForFile("/project", "explicit.md"),
      ];
    }),
  ).toEqual(["mathjax", "katex"]);
  await page.screenshot({
    path: "../../output/playwright/markdown-default-math-engine.png",
    animations: "disabled",
  });
  await page.reload();
  await page.getByRole("button", { name: "Rendering", exact: true }).click();
  await expect(engine).toContainText("MathJax (OpenReview)");
  await page
    .getByRole("searchbox", { name: "Search settings" })
    .fill("math engine");
  await expect(
    page.getByRole("button", { name: /^Default math engine MathJax/ }),
  ).toBeVisible();
});

test("configures separate light and dark Markdown themes", async ({ page }) => {
  await page.goto("/?debug=markdown-settings", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("markdown-settings-harness-shell"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Rendering" }).click();
  await expect(page.getByText("LaTeX defaults", { exact: true })).toBeVisible();
  await expect(page.getByText("Markdown", { exact: true })).toBeVisible();
  const folderRow = page.locator(
    '[data-settings-row-id="rendering-markdown-theme-folder"]',
  );
  const loadTyporaThemesRow = page.locator(
    '[data-settings-row-id="rendering-markdown-load-typora-themes"]',
  );
  const separateThemesRow = page.locator(
    '[data-settings-row-id="rendering-markdown-separate-themes"]',
  );
  const lightThemeRow = page.locator(
    '[data-settings-row-id="rendering-markdown-light-theme"]',
  );
  const darkThemeRow = page.locator(
    '[data-settings-row-id="rendering-markdown-dark-theme"]',
  );

  const folderInput = folderRow.getByRole("textbox", {
    name: "Typora theme folder",
  });
  const resetFolderButton = folderRow.getByRole("button", {
    name: "Reset Typora theme folder",
  });
  const loadTyporaThemesSwitch = loadTyporaThemesRow.getByRole("switch", {
    name: "Load Typora themes",
  });
  await expect(loadTyporaThemesSwitch).toHaveAttribute("aria-checked", "true");
  await expect(folderRow).not.toContainText("Automatic");
  await expect(folderInput).toHaveValue("/tmp/typora-config/Typora/themes");
  await expect(resetFolderButton).toBeDisabled();

  await expect(
    separateThemesRow.getByRole("switch", {
      name: "Separate light and dark Markdown themes",
    }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(lightThemeRow.getByRole("combobox")).toContainText(
    "GitHub Light",
  );
  await expect(darkThemeRow.getByRole("combobox")).toContainText("GitHub Dark");
  await expect(lightThemeRow.locator('[data-theme-color="accent"]')).toHaveCSS(
    "background-color",
    "rgb(9, 105, 218)",
  );
  await expect(
    darkThemeRow.locator('[data-theme-color="background"]'),
  ).toHaveCSS("background-color", "rgb(13, 17, 23)");

  await lightThemeRow.getByRole("combobox").click();
  const academicSwatch = page
    .getByRole("option", { name: "Academic", exact: true })
    .getByTestId("markdown-theme-swatch");
  await expect(
    academicSwatch.locator('[data-theme-color="background"]'),
  ).toHaveCSS("background-color", "rgb(248, 250, 252)");
  await expect(academicSwatch.locator('[data-theme-color="accent"]')).toHaveCSS(
    "background-color",
    "rgb(35, 99, 235)",
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-settings-swatches-light.png",
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect(
    academicSwatch.locator('[data-theme-color="background"]'),
  ).toHaveCSS(
    "box-shadow",
    /rgba\(255, 255, 255, 0\.45\) 0px 0px 0px 0\.75px inset/,
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-settings-swatches-dark.png",
    animations: "disabled",
  });
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await page.getByRole("option", { name: "Academic" }).click();
  await expect(lightThemeRow.getByRole("combobox")).toContainText("Academic");
  await expect(lightThemeRow.locator('[data-theme-color="accent"]')).toHaveCSS(
    "background-color",
    "rgb(35, 99, 235)",
  );

  await loadTyporaThemesSwitch.click();
  await expect(folderRow).toHaveCount(0);
  await expect(lightThemeRow.getByRole("combobox")).toContainText(
    "GitHub Light",
  );
  await lightThemeRow.getByRole("combobox").click();
  await expect(page.getByRole("option", { name: /Academic/ })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await loadTyporaThemesSwitch.click();
  await expect(folderInput).toHaveValue("/tmp/typora-config/Typora/themes");
  await expect(lightThemeRow.getByRole("combobox")).toContainText("Academic");

  const automaticTheme = await page.evaluate(() => {
    const raw = localStorage.getItem("catalex-settings");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: {
        markdownThemeDirectory?: string | null;
        markdownSeparateLightDarkThemes?: boolean;
        markdownPreviewTheme?: string;
        markdownPreviewLightTheme?: string;
        markdownPreviewDarkTheme?: string;
      };
    };
    return {
      directory: parsed.state?.markdownThemeDirectory,
      separate: parsed.state?.markdownSeparateLightDarkThemes,
      theme: parsed.state?.markdownPreviewTheme,
      lightTheme: parsed.state?.markdownPreviewLightTheme,
      darkTheme: parsed.state?.markdownPreviewDarkTheme,
    };
  });
  expect(automaticTheme).toEqual({
    directory: null,
    separate: true,
    theme: "__catalex_github_light__",
    lightTheme: "/tmp/typora-config/Typora/themes/Academic.css",
    darkTheme: "__catalex_github_dark__",
  });

  await separateThemesRow
    .getByRole("switch", {
      name: "Separate light and dark Markdown themes",
    })
    .click();
  await expect(lightThemeRow).toHaveCount(0);
  await expect(darkThemeRow).toHaveCount(0);
  const sharedThemeRow = page.locator(
    '[data-settings-row-id="rendering-markdown-theme"]',
  );
  await expect(sharedThemeRow.getByRole("combobox")).toContainText(
    "GitHub Light",
  );
  await sharedThemeRow.getByRole("combobox").click();
  await page.getByRole("option", { name: "GitHub Dark" }).click();
  await expect(sharedThemeRow.getByRole("combobox")).toContainText(
    "GitHub Dark",
  );
  await expect(
    sharedThemeRow.locator('[data-theme-color="background"]'),
  ).toHaveCSS("background-color", "rgb(13, 17, 23)");
  // Exercise the keyboard toggle while the theme control's tooltip is open.
  await separateThemesRow
    .getByRole("switch", {
      name: "Separate light and dark Markdown themes",
    })
    .press("Space");
  await expect(lightThemeRow.getByRole("combobox")).toContainText("Academic");
  await expect(darkThemeRow.getByRole("combobox")).toContainText("GitHub Dark");

  await folderRow
    .getByRole("button", { name: "Choose Typora theme folder" })
    .click();
  await expect(folderInput).toHaveValue("/tmp/typora-themes");
  await expect(resetFolderButton).toBeEnabled();
  await expect(lightThemeRow.getByRole("combobox")).toContainText(
    "GitHub Light",
  );
  await expect(darkThemeRow.getByRole("combobox")).toContainText("GitHub Dark");

  const persistedTheme = await page.evaluate(() => {
    const raw = localStorage.getItem("catalex-settings");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: {
        markdownThemeDirectory?: string;
        markdownPreviewTheme?: string;
        markdownPreviewLightTheme?: string;
        markdownPreviewDarkTheme?: string;
      };
    };
    return {
      directory: parsed.state?.markdownThemeDirectory,
      theme: parsed.state?.markdownPreviewTheme,
      lightTheme: parsed.state?.markdownPreviewLightTheme,
      darkTheme: parsed.state?.markdownPreviewDarkTheme,
    };
  });
  expect(persistedTheme).toEqual({
    directory: "/tmp/typora-themes",
    theme: "__catalex_github_light__",
    lightTheme: "__catalex_github_light__",
    darkTheme: "__catalex_github_dark__",
  });

  await resetFolderButton.click();
  await expect(folderInput).toHaveValue("/tmp/typora-config/Typora/themes");
  await expect(resetFolderButton).toBeDisabled();

  await folderInput.fill("/tmp/typora-themes");
  await folderInput.press("Enter");
  await expect(resetFolderButton).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = localStorage.getItem("catalex-settings");
        if (!raw) return null;
        return JSON.parse(raw).state?.markdownThemeDirectory;
      }),
    )
    .toBe("/tmp/typora-themes");

  await resetFolderButton.click();
  await expect(folderInput).toHaveValue("/tmp/typora-config/Typora/themes");

  await page.screenshot({
    path: "test-results/markdown-theme-settings.png",
    fullPage: true,
  });
});

test("leaves the Typora theme folder empty when no default exists", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (
      window as Window & {
        __CATALEX_TYPORA_THEME_FOLDER_MISSING__?: boolean;
      }
    ).__CATALEX_TYPORA_THEME_FOLDER_MISSING__ = true;
  });
  await page.goto("/?debug=markdown-settings", {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "Rendering" }).click();

  const folderRow = page.locator(
    '[data-settings-row-id="rendering-markdown-theme-folder"]',
  );
  const folderInput = folderRow.getByRole("textbox", {
    name: "Typora theme folder",
  });
  await expect(folderInput).toHaveValue("");
  await expect(folderInput).toHaveAttribute("placeholder", "");
  await expect(folderRow).not.toContainText("Typora default not found");
});
