import { expect, test } from "@playwright/test";

test("previews approximate theme palettes and uses neutral swatches for unknown colors", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  await expect(
    page.frameLocator('iframe[title="README.md preview"]').locator("h1"),
  ).toHaveText("Markdown Preview");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState((state) => ({
      files: [
        ...state.files,
        ...[
          [
            "night",
            ":root { --bg-color: #172033; --text-color: #e2e8f0; --primary-color: #a78bfa; }",
          ],
          ["plain", "#write { max-width: 700px; }"],
          [
            "matching",
            ":root { --bg-color: #ffffff; --text-color: #242527; --primary-color: #f5f5f5; }",
          ],
        ].map(([name, content]) => ({
          id: `themes/${name}.css`,
          name: `${name}.css`,
          relativePath: `themes/${name}.css`,
          absolutePath: `/tmp/markdown-preview-harness/themes/${name}.css`,
          type: "other" as const,
          content,
          isDirty: false,
        })),
      ],
    }));
  });
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  const choice = (name: string) =>
    page.getByRole("menuitemradio", { name, exact: true });
  const palette = (name: string) =>
    choice(name).getByTestId("markdown-theme-swatch");
  const dot = (name: string, role: string) =>
    palette(name).locator(`[data-theme-color="${role}"]`);
  const expectPalette = async (name: string, colors: string[]) => {
    for (const [i, role] of ["background", "text", "accent"].entries())
      await expect(dot(name, role)).toHaveCSS("background-color", colors[i]);
  };
  const expectGithubPalettes = async () => {
    await expectPalette("GitHub Light", [
      "rgb(255, 255, 255)",
      "rgb(31, 35, 40)",
      "rgb(9, 105, 218)",
    ]);
    await expectPalette("GitHub Dark", [
      "rgb(13, 17, 23)",
      "rgb(230, 237, 243)",
      "rgb(88, 166, 255)",
    ]);
  };
  await expectGithubPalettes();
  await page.screenshot({
    path: "../../output/playwright/markdown-github-swatches-light.png",
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await expectPalette("themes/academic.css", [
    "rgb(248, 242, 232)",
    "rgb(47, 41, 35)",
    "rgb(126, 58, 47)",
  ]);
  await expectPalette("themes/night.css", [
    "rgb(23, 32, 51)",
    "rgb(226, 232, 240)",
    "rgb(167, 139, 250)",
  ]);
  await expectPalette("themes/plain.css", [
    "rgb(229, 231, 235)",
    "rgb(100, 116, 139)",
    "rgb(148, 163, 184)",
  ]);
  await expect(dot("themes/matching.css", "background")).toHaveCSS(
    "box-shadow",
    /rgba\(0, 0, 0, 0\.38\) 0px 0px 0px 0\.75px inset/,
  );
  // The installed theme is read lazily; project themes also respond to unsaved edits.
  await expect(palette("Academic")).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/markdown-theme-swatches-all.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await expectGithubPalettes();
  await page.screenshot({
    path: "../../output/playwright/markdown-github-swatches-dark.png",
    animations: "disabled",
  });
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await expect(dot("themes/matching.css", "text")).toHaveCSS(
    "box-shadow",
    /rgba\(255, 255, 255, 0\.45\) 0px 0px 0px 0\.75px inset/,
  );
  await expectPalette("themes/matching.css", [
    "rgb(255, 255, 255)",
    "rgb(36, 37, 39)",
    "rgb(245, 245, 245)",
  ]);
  await page.screenshot({
    path: "../../output/playwright/markdown-theme-dots-dark.png",
    animations: "disabled",
  });
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore
      .getState()
      .updateFileContent(
        "themes/night.css",
        "body { background: #172033; color: #e2e8f0; } a { color: #22d3ee; }",
      );
  });
  await expect(dot("themes/night.css", "accent")).toHaveCSS(
    "background-color",
    "rgb(34, 211, 238)",
  );
  await choice("themes/night.css").click();
  await page
    .getByRole("menuitem", { name: "Back to preview settings" })
    .click();
  await expect(dot("themes/night.css", "accent")).toHaveCSS(
    "background-color",
    "rgb(34, 211, 238)",
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-theme-swatches-recent.png",
    animations: "disabled",
  });
});

test("keeps preview settings open after choices and dismisses outside, including the preview iframe", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  await expect(preview.locator("h1")).toHaveText("Markdown Preview");
  const trigger = page.getByRole("button", {
    name: "Markdown preview settings",
  });
  const surface = page.locator('[data-slot="dropdown-menu-content"]');
  const choice = (name: string) =>
    page.getByRole("menuitemradio", { name, exact: true });
  await trigger.click();
  await choice("MathJax (OpenReview)").click();
  await expect(choice("MathJax (OpenReview)")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(preview.locator("mjx-container svg")).toHaveCount(2);
  await choice("KaTeX (fast)").focus();
  await page.keyboard.press("Space");
  await expect(choice("KaTeX (fast)")).toHaveAttribute("aria-checked", "true");
  await expect(preview.locator(".katex")).toHaveCount(2);
  await choice("GitHub Dark").click();
  await expect(choice("GitHub Dark")).toHaveAttribute("aria-checked", "true");
  await expect(preview.locator("body")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await choice("GitHub Light").click();
  await expect(choice("GitHub Light")).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await choice("themes/academic.css").click();
  await expect(choice("themes/academic.css")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByTestId("markdown-all-typora-themes")).toBeVisible();
  await choice("Academic").click();
  await expect(choice("Academic")).toHaveAttribute("aria-checked", "true");
  await page
    .getByRole("menuitem", { name: "Back to preview settings" })
    .click();
  // Newly used themes are available immediately, in their insertion order.
  await expect(choice("themes/academic.css")).toBeVisible();
  await choice("themes/academic.css").click();
  await expect(choice("themes/academic.css")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(choice("KaTeX (fast)")).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/markdown-settings-stays-open.png",
    animations: "disabled",
  });
  await preview.locator("h1").click();
  await expect(surface).toBeHidden();
  await trigger.click();
  await expect(choice("KaTeX (fast)")).toBeVisible();
  await page.locator(".cm-content").click();
  await expect(surface).toBeHidden();
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`morphs the content-sized preview menu between levels (${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.goto("/?debug=markdown-preview");
    await expect(
      page.frameLocator('iframe[title="README.md preview"]').locator("h1"),
    ).toHaveText("Markdown Preview");
    await page
      .getByRole("button", { name: "Markdown preview settings" })
      .click();
    const surface = page.locator('[data-slot="dropdown-menu-content"]');
    await expect
      .poll(() => surface.evaluate((el) => el.getAnimations().length))
      .toBe(0);
    const rootBounds = await surface.boundingBox();
    expect(rootBounds!.width).toBeGreaterThanOrEqual(128);
    expect(rootBounds!.width).toBeLessThan(240);
    for (const forward of [true, false]) {
      const item = page.getByRole("menuitem", {
        name: forward ? "All Typora themes" : "Back to preview settings",
        exact: true,
      });
      const before = await surface.boundingBox();
      // Inspect real browser animation frames without depending on wall-clock timing.
      const motion = await item.evaluate(async (el) => {
        const menu = el.closest<HTMLElement>(
          '[data-slot="dropdown-menu-content"]',
        )!;
        el.click();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const animations = menu.getAnimations();
        for (const animation of animations) {
          animation.pause();
          animation.currentTime =
            Number(animation.effect!.getTiming().duration) / 2;
        }
        return animations.length;
      });
      if (reducedMotion === "reduce") {
        expect(motion).toBe(0);
      } else {
        expect(motion).toBe(1);
        const middle = await surface.boundingBox();
        await page.screenshot({
          path: `../../output/playwright/markdown-menu-${forward ? "forward" : "back"}-midpoint.png`,
        });
        await surface.evaluate((el) => {
          for (const animation of el.getAnimations()) animation.finish();
        });
        const after = await surface.boundingBox();
        expect(middle!.width).toBeGreaterThan(
          Math.min(before!.width, after!.width),
        );
        expect(middle!.width).toBeLessThan(
          Math.max(before!.width, after!.width),
        );
        expect(middle!.height).toBeGreaterThan(
          Math.min(before!.height, after!.height),
        );
        expect(middle!.height).toBeLessThan(
          Math.max(before!.height, after!.height),
        );
      }
      const settled = await surface.boundingBox();
      if (forward) expect(settled!.width).toBeGreaterThan(rootBounds!.width);
      else expect(settled!.width).toBeCloseTo(rootBounds!.width, 1);
    }
    await expect(
      page.getByRole("menuitem", { name: "All Typora themes", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-slot="dropdown-menu-content"]'),
    ).toBeHidden();
    await expect(surface).toBeHidden();
    // Long user-provided theme names grow the menu up to its cap, then truncate.
    const longName = `themes/${"very-long-theme-name-".repeat(6)}.css`;
    await page.evaluate(async (name) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState((state) => ({
        files: [
          ...state.files,
          {
            id: name,
            name,
            relativePath: name,
            absolutePath: `/tmp/markdown-preview-harness/${name}`,
            type: "other" as const,
            content: "body { color: #222; }",
            isDirty: false,
          },
        ],
      }));
    }, longName);
    await page
      .getByRole("button", { name: "Markdown preview settings" })
      .click();
    await page
      .getByRole("menuitem", { name: "All Typora themes", exact: true })
      .click();
    const longTheme = page.getByRole("menuitemradio", {
      name: longName,
      exact: true,
    });
    await expect
      .poll(() => surface.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(320);
    expect(
      await longTheme
        .locator("span.truncate")
        .evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await longTheme.click();
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-slot="dropdown-menu-content"]'),
    ).toBeHidden();
    await page
      .getByRole("button", { name: "Markdown preview settings" })
      .click();
    await expect
      .poll(() => surface.evaluate((el) => el.getBoundingClientRect().width))
      .toBe(320);
    await page.screenshot({
      path: `../../output/playwright/markdown-menu-long-theme-${reducedMotion}.png`,
      animations: "disabled",
    });
  });
}

test("shows five recent Typora themes and opens the full list at the current theme or the top", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  await expect(
    page.frameLocator('iframe[title="README.md preview"]').locator("h1"),
  ).toHaveText("Markdown Preview");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState((state) => ({
      files: [
        ...state.files,
        ...Array.from({ length: 35 }, (_, i) => {
          const name = `theme-${String(i).padStart(2, "0")}.css`;
          return {
            id: `themes/${name}`,
            name,
            relativePath: `themes/${name}`,
            absolutePath: `/tmp/markdown-preview-harness/themes/${name}`,
            type: "other" as const,
            content: ":root { --bg-color: #fafafa; --text-color: #222222; }",
            isDirty: false,
          };
        }),
      ],
    }));
  });
  const menu = page.getByRole("button", { name: "Markdown preview settings" });
  const all = page.getByRole("menuitem", {
    name: "All Typora themes",
    exact: true,
  });
  const list = page.getByTestId("markdown-all-typora-themes");
  const back = page.getByRole("menuitem", { name: "Back to preview settings" });
  const themeName = (i: number) =>
    `themes/theme-${String(i).padStart(2, "0")}.css`;
  for (const i of [25, 26, 27, 28, 29, 30]) {
    await menu.click();
    await all.click();
    await page
      .getByRole("menuitemradio", { name: themeName(i), exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-slot="dropdown-menu-content"]'),
    ).toBeHidden();
    await expect(menu).toContainText(themeName(i));
  }
  await menu.click();
  const recentNames = async () =>
    (await page.getByRole("menuitemradio").allTextContents())
      .map((name) => name.trim())
      .filter((name) => name.startsWith("themes/theme-"));
  expect(await recentNames()).toEqual([26, 27, 28, 29, 30].map(themeName));
  await page.screenshot({
    path: "../../output/playwright/markdown-typora-recents.png",
    animations: "disabled",
  });
  const recentChoice = page.getByRole("menuitemradio", {
    name: themeName(28),
    exact: true,
  });
  const beforeSelection = await recentChoice.boundingBox();
  await recentChoice.click();
  await expect(recentChoice).toHaveAttribute("aria-checked", "true");
  expect(await recentNames()).toEqual([26, 27, 28, 29, 30].map(themeName));
  expect((await recentChoice.boundingBox())!.y).toBe(beforeSelection!.y);
  await page.screenshot({
    path: "../../output/playwright/markdown-recents-stable.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await menu.click();
  expect(await recentNames()).toEqual([26, 27, 28, 29, 30].map(themeName));
  await all.click();
  await expect(
    page.getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true }),
  ).toHaveCount(0);
  const selected = page.getByRole("menuitemradio", {
    name: themeName(28),
    exact: true,
  });
  await expect(selected).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(300);
  const bounds = await list.boundingBox();
  const selectedBounds = await selected.boundingBox();
  expect(selectedBounds!.y).toBeGreaterThanOrEqual(bounds!.y);
  expect(selectedBounds!.y + selectedBounds!.height).toBeLessThanOrEqual(
    bounds!.y + bounds!.height,
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-typora-current.png",
    animations: "disabled",
  });
  await selected.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(all).toBeFocused();
  await page
    .getByRole("menuitemradio", { name: "GitHub Light", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await menu.click();
  await all.click();
  await expect
    .poll(() => list.evaluate((element) => element.scrollTop))
    .toBe(0);
  await page.screenshot({
    path: "../../output/playwright/markdown-typora-top.png",
    animations: "disabled",
  });
  await back.click();
  await expect(
    page.getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await menu.click();
  await page
    .getByRole("menuitemradio", { name: themeName(26), exact: true })
    .click();
  expect(await recentNames()).toEqual([26, 27, 28, 29, 30].map(themeName));
  await all.click();
  await page
    .getByRole("menuitemradio", { name: themeName(31), exact: true })
    .click();
  await back.click();
  expect(await recentNames()).toEqual([26, 28, 29, 30, 31].map(themeName));
  await expect(
    page.getByRole("menuitemradio", { name: themeName(31), exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: "../../output/playwright/markdown-recents-replacement.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  // Persisted recents retain their order; unavailable project files are omitted.
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    await useSettingsStore.persist.rehydrate();
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState((state) => ({
      files: state.files.filter((file) => file.id !== "themes/theme-28.css"),
    }));
  });
  await menu.click();
  expect(await recentNames()).toEqual([26, 29, 30, 31].map(themeName));
});

test("keeps wide MathJax displays scrollable inside the preview and recovers from invalid math", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const source = `# Wide math\n\nBefore.\n\n$$\n${Array.from({ length: 40 }, (_, i) => `x_{${i}}`).join(" + ")}\n$$\n\nAfter.`;
  await page.locator(".cm-content").fill(source);
  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await page
    .getByRole("menuitemradio", { name: "MathJax (OpenReview)", exact: true })
    .click();
  await page.keyboard.press("Escape");
  const display = preview.locator('mjx-container[display="true"]');
  await expect(display.locator("svg")).toHaveCount(1);
  await expect(display).toHaveCSS("overflow-x", "auto");
  const dimensions = await display.evaluate((element) => ({
    viewport: element.ownerDocument.documentElement.clientWidth,
    page: element.ownerDocument.documentElement.scrollWidth,
    width: element.clientWidth,
    content: element.scrollWidth,
  }));
  expect(dimensions.page).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.content).toBeGreaterThan(dimensions.width);
  await display.evaluate((element) => {
    element.scrollLeft = 100;
  });
  expect(
    await display.evaluate((element) => element.scrollLeft),
  ).toBeGreaterThan(0);
  await page.screenshot({
    path: "../../output/playwright/markdown-mathjax-wide.png",
    animations: "disabled",
  });
  await page.locator(".cm-content").fill("Before $\\frac{$ after.");
  await expect(preview.locator('[data-mml-node="merror"]')).toHaveCount(1);
  await expect(preview.locator("p")).toContainText("Before");
  await page.locator(".cm-content").fill("Before $\\frac{a}{b}$ after.");
  await expect(preview.locator('[data-mml-node="merror"]')).toHaveCount(0);
  await expect(preview.locator("mjx-container svg")).toHaveCount(1);
});

test("selects and persists the math engine independently of themes, with a second-level Typora menu", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const source =
    "# Math preview\n\nInline $\\frac{a}{b}$ and $\\mathbb{R}$.\n\n$$\n\\begin{aligned}\nf(x) &= x^2 + 1 \\\\\ng(x) &= \\sum_{i=1}^{n} i\n\\end{aligned}\n$$";
  await page.locator(".cm-content").fill(source);
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const menu = page.getByRole("button", { name: "Markdown preview settings" });
  await expect(preview.locator(".katex")).toHaveCount(3);
  await menu.click();
  await expect(
    page.getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "GitHub Light", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "themes/academic.css" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "../../output/playwright/markdown-settings-collapsed.png",
    animations: "disabled",
  });
  const typora = page.getByRole("menuitem", {
    name: "All Typora themes",
    exact: true,
  });
  await typora.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("markdown-all-typora-themes")).toBeVisible();
  await expect(
    page.getByRole("menuitemradio", { name: "themes/academic.css" }),
  ).toBeVisible();
  await page
    .getByRole("menuitem", { name: "Back to preview settings" })
    .click();
  await expect(page.getByTestId("markdown-all-typora-themes")).toHaveCount(0);
  await page
    .getByRole("menuitemradio", { name: "MathJax (OpenReview)", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(preview.locator("mjx-container svg")).toHaveCount(3);
  await expect(
    preview.locator(".katex, .mathjax-error, [data-mml-node=merror]"),
  ).toHaveCount(0);
  await menu.click();
  await page.getByRole("menuitemradio", { name: "GitHub Dark" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(preview.locator("body")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await expect(preview.locator("mjx-container svg")).toHaveCount(3);
  await preview.locator("body").evaluate((body) => {
    body.ownerDocument.scrollingElement!.scrollTop = 0;
  });
  await menu.click();
  await expect(
    page.getByRole("menuitemradio", {
      name: "MathJax (OpenReview)",
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await typora.click();
  await expect(preview.locator("h1")).toHaveText("Math preview");
  await expect(preview.locator("body")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-settings-expanded-mathjax.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(menu).toBeFocused();
  await page.locator(".cm-content").fill(`${source}\n\nUpdated $\\sqrt{2}$.`);
  await expect(preview.locator("mjx-container svg")).toHaveCount(4);
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore
      .getState()
      .updateFileContent("notes.md", "# Other note\n\n$x^2$");
    useDocumentStore.getState().setActiveFile("notes.md");
  });
  const otherPreview = page.frameLocator('iframe[title="notes.md preview"]');
  await expect(otherPreview.locator(".katex")).toHaveCount(1);
  await expect(otherPreview.locator("mjx-container")).toHaveCount(0);
  await menu.click();
  await expect(
    page.getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    path: "../../output/playwright/markdown-math-engine-per-file.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("README.md");
  });
  await expect(preview.locator("mjx-container svg")).toHaveCount(4);
  await page.reload();
  await expect(preview.locator("mjx-container svg").first()).toBeVisible();
  await menu.click();
  await expect(
    page.getByRole("menuitemradio", {
      name: "MathJax (OpenReview)",
      exact: true,
    }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("menuitemradio", { name: "themes/academic.css" }),
  ).toHaveCount(0);
  await page
    .getByRole("menuitemradio", { name: "KaTeX (fast)", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(preview.locator(".katex").first()).toBeVisible();
  await expect(preview.locator("mjx-container")).toHaveCount(0);
});

test("highlights fenced code across preview themes while preserving text and plain fallbacks", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const source = [
    "# Code samples",
    '```ts\n// A typed greeting\nconst greeting: string = "Hello";\nconsole.log(greeting, 42);\n```',
    '```python\ndef greet(name):\n    return f"Hello, {name}"\n```',
    "```latex\n\\section{Introduction}\n\\textbf{Hello world}\n```",
    "Inline `const plain = 1` and $x^2$.",
    "```unknown-language\nconst untouched = 1;\n```",
    "```\n  plain text <tag>\n```",
    "```html\n<script>alert('example')</script>\n```",
  ].join("\n\n");
  await page.locator(".cm-content").fill(source);
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const code = preview.locator("pre code.language-ts");
  const keyword = code.locator(".hljs-keyword");
  await expect(keyword).toHaveText("const");
  expect(await code.textContent()).toBe(
    '// A typed greeting\nconst greeting: string = "Hello";\nconsole.log(greeting, 42);\n',
  );
  await expect(keyword).toHaveCSS("color", "rgb(207, 34, 46)");
  await expect(code.locator(".hljs-string")).toHaveCSS(
    "color",
    "rgb(10, 48, 105)",
  );
  await expect(
    preview.locator("pre code.language-python .hljs-keyword").first(),
  ).toHaveText("def");
  await expect(
    preview.locator("pre code.language-latex span").first(),
  ).toContainText("\\section");
  await expect(
    preview.locator("code.language-unknown-language span"),
  ).toHaveCount(0);
  expect(await preview.locator("pre code:not([class])").textContent()).toBe(
    "  plain text <tag>\n",
  );
  await expect(preview.locator("p code span.hljs-keyword")).toHaveCount(0);
  await expect(preview.locator(".katex")).toHaveCount(1);
  await expect(preview.locator("#write script")).toHaveCount(0);
  expect(await preview.locator("code.language-html").textContent()).toBe(
    "<script>alert('example')</script>\n",
  );
  await expect(code.locator("xpath=..")).toHaveAttribute(
    "data-markdown-source-start",
    /\d+/,
  );
  const scrollToTop = () =>
    preview.locator("body").evaluate((body) => {
      body.ownerDocument.scrollingElement!.scrollTop = 0;
    });
  await scrollToTop();
  await page.screenshot({
    path: "../../output/playwright/markdown-code-light.png",
  });
  const theme = page.getByRole("button", { name: "Markdown preview settings" });
  await theme.click();
  await page.getByRole("menuitemradio", { name: "GitHub Dark" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(keyword).toHaveCSS("color", "rgb(255, 123, 114)");
  await expect(code.locator(".hljs-string")).toHaveCSS(
    "color",
    "rgb(165, 214, 255)",
  );
  await scrollToTop();
  await page.screenshot({
    path: "../../output/playwright/markdown-code-dark.png",
  });
  await theme.click();
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "themes/academic.css" })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(preview.locator("h1")).toHaveCSS("color", "rgb(126, 58, 47)");
  await expect(keyword).not.toHaveCSS("color", "rgb(255, 123, 114)");
  await scrollToTop();
  await page.screenshot({
    path: "../../output/playwright/markdown-code-custom.png",
  });
  // A project theme can supply its own token colors, including on a dark surface.
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore
      .getState()
      .updateFileContent(
        "themes/academic.css",
        ":root { --bg-color: #202020; --text-color: #eeeeee; } .hljs-keyword { color: #ffaa66; }",
      );
  });
  await expect(keyword).toHaveCSS("color", "rgb(255, 170, 102)");
  await expect(preview.locator("body")).toHaveCSS(
    "background-color",
    "rgb(32, 32, 32)",
  );
  await scrollToTop();
  await page.screenshot({
    path: "../../output/playwright/markdown-code-custom-dark.png",
  });
  // Live edits update both tokenization and text without changing the source.
  await page
    .locator(".cm-content")
    .fill(source.replace("const greeting", "let greeting"));
  await expect(keyword).toHaveText("let");
});

test("keeps the Markdown cursor in place during preview scroll sync", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  const cursorPosition = page.getByTestId("markdown-editor-cursor-position");
  const cursorBeforePreviewScroll = await cursorPosition.textContent();
  const editorScroller = page.locator(".cm-scroller");
  const previewFrame = page.locator('iframe[title="README.md preview"]');
  const preview = page.frameLocator('iframe[title="README.md preview"]');

  await previewFrame.hover();
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(150);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);
  await expect(cursorPosition).toHaveText(cursorBeforePreviewScroll ?? "0");
});

test("renders the Markdown outline and syncs through the real workspace layout", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("markdown-workspace-harness-shell"),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Disable synchronized scrolling" }),
  ).toHaveAttribute("aria-pressed", "true");

  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const previewFrame = page.locator('iframe[title="README.md preview"]');
  const editorScroller = page.locator(".cm-scroller");
  await expect(editorScroller).toBeVisible();
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(20);

  await previewFrame.hover();
  await page.mouse.wheel(0, 1_200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(150);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);

  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  const outline = page.locator('[data-sidebar-section="outline"]');
  const outlineItems = outline.locator("[data-outline-line]");
  await expect(outlineItems).toHaveCount(8);
  await expect(outlineItems.first()).toHaveAttribute("data-outline-level", "1");
  await expect(outlineItems.first().locator("..")).toContainText("H1");
  await expect(outlineItems.first()).toContainText("Markdown Preview");

  const headingOffsets = await outlineItems.evaluateAll((items) =>
    items.slice(0, 3).map((item) => item.getBoundingClientRect().left),
  );
  expect(headingOffsets[1] - headingOffsets[0]).toBe(16);
  expect(headingOffsets[2] - headingOffsets[1]).toBe(16);
  const fileIcon = await page
    .locator('[data-sidebar-file-id="README.md"] [data-sidebar-row-icon]')
    .boundingBox();
  const headingIcon = await outlineItems
    .first()
    .locator("..")
    .locator("[data-sidebar-row-icon]")
    .boundingBox();
  expect(headingIcon!.x).toBe(fileIcon!.x);
  const headingToggle = outline.getByRole("button", {
    name: "Collapse Markdown Preview",
    exact: true,
  });
  await expect(headingToggle).toHaveText("H1");
  await expect(headingToggle.locator("svg")).toHaveCount(0);
  const toggleBounds = await headingToggle.boundingBox();
  const titleBounds = await outlineItems.first().boundingBox();
  expect(toggleBounds!.x + toggleBounds!.width).toBe(titleBounds!.x);
  const titleTextLeft = await outlineItems.first().evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().left;
  });
  expect(titleTextLeft - headingIcon!.x).toBe(28);
  const padding = await headingToggle.evaluate((el) => ({
    left: getComputedStyle(el).paddingLeft,
    right: getComputedStyle(el).paddingRight,
  }));
  expect(padding).toEqual({ left: "4px", right: "4px" });
  await headingToggle.hover();
  expect(
    await outlineItems
      .first()
      .locator("..")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await headingToggle.evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await outlineItems.first().hover();
  await expect
    .poll(() =>
      headingToggle.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe("rgba(0, 0, 0, 0)");
  expect(
    await outlineItems
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");

  const readingNotesFoldButton = outline.getByRole("button", {
    name: "Collapse Reading notes",
  });
  const firstRow = outlineItems.first().locator("..");
  await expect(firstRow.locator("[data-outline-guide]")).toHaveCount(0);
  await expect(firstRow.locator("[data-outline-guide-start]")).toHaveCount(1);
  await expect(
    outlineItems.nth(2).locator("..").locator("[data-outline-guide]"),
  ).toHaveCount(2);
  const guide = await firstRow
    .locator("[data-outline-guide-start]")
    .boundingBox();
  expect(guide!.x + guide!.width / 2).toBe(
    headingIcon!.x + headingIcon!.width / 2,
  );
  const editorBeforeFold = await page
    .locator(".cm-line.cm-activeLine")
    .textContent();
  await readingNotesFoldButton.click();
  await expect(page.locator(".cm-line.cm-activeLine")).toHaveText(
    editorBeforeFold ?? "",
  );
  await expect(outlineItems).toHaveCount(2);
  await expect(outline.locator('[data-outline-guide="2"]')).toHaveCount(0);
  await expect(outline.locator('[data-outline-guide-start="2"]')).toHaveCount(
    0,
  );
  await outline.getByRole("button", { name: "Expand Reading notes" }).click();
  await expect(outlineItems).toHaveCount(8);

  const sectionFourOutlineItem = outlineItems.filter({
    hasText: "Section four",
  });
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "data-outline-level",
    "3",
  );
  await sectionFourOutlineItem.click();
  const activeEditorLine = page.locator(".cm-line.cm-activeLine");
  await expect(activeEditorLine).toContainText("### Section four");
  await expect(activeEditorLine).toBeInViewport();
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "aria-current",
    "location",
  );
  await outline.getByRole("button", { name: "Collapse Reading notes" }).click();
  await expect(
    outline.getByRole("button", { name: "Reading notes", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await expect(outline.locator('[aria-current="location"]')).toHaveCount(1);
  await outline.getByRole("button", { name: "Expand Reading notes" }).click();
  await expect(sectionFourOutlineItem).toHaveAttribute(
    "aria-current",
    "location",
  );

  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  await page.screenshot({
    path: "test-results/markdown-outline.png",
    fullPage: true,
  });
});

test("formats Markdown from the editor header and reports live text counts", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  const editorToolbar = page.getByTestId("markdown-editor-toolbar");
  const previewToolbar = page.getByTestId("markdown-preview-toolbar");
  await expect(editorToolbar).toBeVisible();
  await expect(previewToolbar).toBeVisible();
  await expect(page.getByTestId("markdown-word-count")).toHaveText(
    /^\d[\d,]* words$/,
  );
  await expect(page.getByTestId("markdown-character-count")).toHaveText(
    /^\d[\d,]* chars$/,
  );
  await expect(page.getByTestId("markdown-editor-statistics")).toContainText(
    /words\s*·\s*[\d,]+ chars/,
  );

  const [editorToolbarBox, previewToolbarBox] = await Promise.all([
    editorToolbar.boundingBox(),
    previewToolbar.boundingBox(),
  ]);
  expect(editorToolbarBox?.height).toBe(previewToolbarBox?.height);

  const firstLine = page.locator(".cm-line").first();
  await firstLine.click();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Bold" }).click();
  await expect(firstLine).toContainText("**text**# Markdown Preview");
  await expect(page.getByTestId("markdown-word-count")).toHaveText(
    /^1\/\d[\d,]* words$/,
  );
  await expect(page.getByTestId("markdown-character-count")).toHaveText(
    /^4\/\d[\d,]* chars$/,
  );

  await page.keyboard.press("Meta+z");
  await expect(firstLine).toHaveText("# Markdown Preview");

  const paragraph = page
    .locator(".cm-line")
    .filter({ hasText: "Markdown keeps source and preview close together" })
    .first();
  await paragraph.click();
  await page.keyboard.press("Home");
  await page.getByRole("button", { name: "Heading style" }).click();
  await page.getByRole("menuitem", { name: "Heading 2" }).click();
  await expect(paragraph).toContainText(
    "## Markdown keeps source and preview close together",
  );

  await page.getByRole("button", { name: "Heading style" }).click();
  await page.getByRole("menuitem", { name: "Paragraph" }).click();
  await expect(paragraph).toHaveText(
    "Markdown keeps source and preview close together while longer documents grow.",
  );
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(paragraph).toContainText(
    "- Markdown keeps source and preview close together",
  );

  await page.locator(".cm-content").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.press("Enter");
  const blankLine = page.locator(".cm-line").last();
  const cursorPosition = page.getByTestId("markdown-editor-cursor-position");
  const cursorBeforeList = Number(await cursorPosition.textContent());
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(blankLine).toHaveText("- ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 2));
  await page.getByRole("button", { name: "Bulleted list" }).click();
  await expect(blankLine).toHaveText("", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList));
  await page.getByRole("button", { name: "Numbered list" }).click();
  await expect(blankLine).toHaveText("1. ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 3));
  await page.getByRole("button", { name: "Checklist" }).click();
  await expect(blankLine).toHaveText("- [ ] ", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList + 6));
  await page.getByRole("button", { name: "Checklist" }).click();
  await expect(blankLine).toHaveText("", { useInnerText: false });
  await expect(cursorPosition).toHaveText(String(cursorBeforeList));

  await page.screenshot({
    path: "test-results/markdown-editor-toolbar.png",
    fullPage: true,
  });
});

test("renders Markdown live and applies project Typora themes", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByTestId("markdown-preview-harness-shell"),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-preview")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);

  const preview = page.frameLocator('iframe[title="README.md preview"]');
  await expect(
    preview.getByRole("heading", { name: "Markdown Preview" }),
  ).toBeVisible();
  await expect(preview.getByRole("table")).toBeVisible();
  await expect(preview.locator(".katex-display")).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "Section four" }),
  ).toHaveAttribute("data-markdown-source-start", /\d+/);

  const markdownToolbar = page.getByTestId("markdown-preview-toolbar");
  const themeSelect = page.getByRole("button", {
    name: "Markdown preview settings",
  });
  const themeIcon = themeSelect.getByTestId("markdown-theme-icon");
  const exportPdfButton = page.getByRole("button", {
    name: "Export Markdown as PDF",
  });
  await expect(themeIcon).toBeVisible();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect(themeSelect).toContainText("GitHub Light");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(255, 255, 255)");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(255, 255, 255)",
      color: "rgb(31, 35, 40)",
    });

  await themeSelect.click();
  await page.getByRole("menuitemradio", { name: "GitHub Dark" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        colorScheme: getComputedStyle(element).colorScheme,
      })),
    )
    .toEqual({
      background: "rgb(13, 17, 23)",
      color: "rgb(230, 237, 243)",
      colorScheme: "dark",
    });
  await page.screenshot({
    path: "test-results/markdown-preview-github-dark-header.png",
    fullPage: true,
  });
  await themeSelect.click();
  await page.getByRole("menuitemradio", { name: "GitHub Light" }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(themeSelect).toContainText("GitHub Light");

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "dark");
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(13, 17, 23)");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(13, 17, 23)",
      color: "rgb(230, 237, 243)",
    });
  await page.getByRole("button", { name: "Switch to light mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect(themeSelect).toContainText("GitHub Light");
  await page.getByRole("button", { name: "Use shared theme mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "shared");
  await page.getByRole("button", { name: "Use separate theme mode" }).click();
  await expect(themeIcon).toHaveAttribute("data-theme-mode-icon", "light");
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBe(48);
  const toolbarControlPositions = await markdownToolbar.evaluate((toolbar) => {
    const theme = toolbar.querySelector<HTMLElement>(
      '[aria-label="Markdown preview settings"]',
    );
    const exportButton = toolbar.querySelector<HTMLElement>(
      '[aria-label="Export Markdown as PDF"]',
    );
    if (!theme || !exportButton) return null;
    const toolbarRect = toolbar.getBoundingClientRect();
    const themeRect = theme.getBoundingClientRect();
    const exportRect = exportButton.getBoundingClientRect();
    return {
      themeLeft: themeRect.left - toolbarRect.left,
      exportGap: exportRect.left - themeRect.right,
      toolbarWidth: toolbarRect.width,
    };
  });
  expect(toolbarControlPositions).not.toBeNull();
  expect(toolbarControlPositions!.themeLeft).toBeLessThan(
    toolbarControlPositions!.toolbarWidth / 2,
  );
  expect(toolbarControlPositions!.exportGap).toBeGreaterThanOrEqual(0);
  expect(toolbarControlPositions!.exportGap).toBeLessThan(12);

  const themeSelectBox = await themeSelect.boundingBox();
  expect(themeSelectBox).not.toBeNull();
  await themeSelect.click();
  const themeMenu = page.locator('[data-slot="dropdown-menu-content"]');
  await expect(themeMenu).toBeVisible();
  await themeMenu.evaluate(async (menu) => {
    await Promise.allSettled(
      menu
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const themeMenuBox = await themeMenu.boundingBox();
  expect(themeMenuBox).not.toBeNull();
  const themeMenuGap =
    themeMenuBox!.y - (themeSelectBox!.y + themeSelectBox!.height);
  expect(themeMenuGap).toBeGreaterThanOrEqual(4);
  await page.screenshot({
    path: "test-results/markdown-preview-theme-menu.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect(themeMenu).toBeHidden();

  const previewFrame = page.locator('iframe[title="README.md preview"]');
  await expect(previewFrame).toHaveAttribute(
    "sandbox",
    "allow-popups allow-same-origin",
  );
  await page.evaluate(() => {
    type Invoke = (
      command: string,
      args?: unknown,
      options?: { headers?: Record<string, string> },
    ) => Promise<unknown>;
    const win = window as Window & {
      __TAURI_INTERNALS__?: { invoke?: Invoke };
      __markdownPdfExportHarness?: {
        appDisplay: string | null;
        byteLength: number;
        customThemeCssLoaded: boolean;
        heading: string | null;
        nativeAvailable: boolean;
        nativePath: string;
        path: string;
        prefix: string;
        previewTheme: string | null;
        printDisplay: string | null;
        themeCssLoaded: boolean;
      };
    };
    const originalInvoke = win.__TAURI_INTERNALS__?.invoke;
    if (!win.__TAURI_INTERNALS__ || !originalInvoke) {
      throw new Error("Tauri browser mocks are not ready");
    }
    const harness = {
      appDisplay: null,
      byteLength: 0,
      customThemeCssLoaded: false,
      heading: null,
      nativeAvailable: true,
      nativePath: "",
      path: "",
      prefix: "",
      previewTheme: null,
      printDisplay: null,
      themeCssLoaded: false,
    };
    win.__markdownPdfExportHarness = harness;
    win.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      if (command === "plugin:dialog|save") return "/tmp/README.pdf";
      if (command === "export_markdown_pdf_native") {
        const printRoot = document.querySelector<HTMLElement>(
          "[data-catalex-markdown-pdf-root]",
        );
        const themeStyle = document.getElementById(
          "catalex-markdown-pdf-theme",
        );
        harness.appDisplay = document.getElementById("root")
          ? getComputedStyle(document.getElementById("root")!).display
          : null;
        harness.customThemeCssLoaded = Boolean(
          themeStyle?.textContent?.includes("rgb(35, 99, 235)"),
        );
        harness.heading = printRoot?.querySelector("h1")?.textContent ?? null;
        harness.nativePath = (args as { filePath?: string })?.filePath ?? "";
        harness.printDisplay = printRoot
          ? getComputedStyle(printRoot).display
          : null;
        harness.previewTheme = document.body.getAttribute("data-preview-theme");
        harness.themeCssLoaded = Boolean(
          themeStyle?.textContent?.includes("data-preview-theme"),
        );
        return harness.nativeAvailable;
      }
      if (command === "plugin:fs|write_file") {
        const bytes = args as Uint8Array;
        harness.byteLength = bytes.byteLength;
        harness.path = decodeURIComponent(options?.headers?.path ?? "");
        harness.prefix = new TextDecoder().decode(bytes.slice(0, 5));
        return null;
      }
      return originalInvoke(command, args, options);
    };
  });
  await expect(exportPdfButton).toBeEnabled();
  await page.emulateMedia({ media: "print" });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const win = window as Window & {
          __markdownPdfExportHarness?: {
            appDisplay: string | null;
            byteLength: number;
            customThemeCssLoaded: boolean;
            heading: string | null;
            nativeAvailable: boolean;
            nativePath: string;
            path: string;
            prefix: string;
            previewTheme: string | null;
            printDisplay: string | null;
            themeCssLoaded: boolean;
          };
        };
        return win.__markdownPdfExportHarness?.nativePath ?? "";
      }),
    )
    .toBe("/tmp/README.pdf");
  const nativePdfExport = await page.evaluate(() => {
    const win = window as Window & {
      __markdownPdfExportHarness?: {
        appDisplay: string | null;
        byteLength: number;
        customThemeCssLoaded: boolean;
        heading: string | null;
        nativeAvailable: boolean;
        nativePath: string;
        path: string;
        prefix: string;
        previewTheme: string | null;
        printDisplay: string | null;
        themeCssLoaded: boolean;
      };
    };
    return win.__markdownPdfExportHarness;
  });
  expect(nativePdfExport).toMatchObject({
    appDisplay: "none",
    byteLength: 0,
    customThemeCssLoaded: false,
    heading: "Markdown Preview",
    nativePath: "/tmp/README.pdf",
    path: "",
    prefix: "",
    previewTheme: "github",
    printDisplay: "block",
    themeCssLoaded: true,
  });
  await page.emulateMedia({ media: "screen" });
  await expect(page.locator("[data-catalex-markdown-pdf-root]")).toHaveCount(0);
  await expect(exportPdfButton).toBeEnabled();

  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          nativeAvailable: boolean;
          prefix: string;
        };
      }
    ).__markdownPdfExportHarness;
    if (!harness) throw new Error("PDF export harness is unavailable");
    harness.nativeAvailable = false;
    harness.prefix = "";
  });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownPdfExportHarness?: { prefix: string };
            }
          ).__markdownPdfExportHarness?.prefix ?? "",
      ),
    )
    .toBe("%PDF-");
  const fallbackPdfExport = await page.evaluate(() => {
    const win = window as Window & {
      __markdownPdfExportHarness?: {
        byteLength: number;
        path: string;
      };
    };
    return win.__markdownPdfExportHarness;
  });
  expect(fallbackPdfExport?.path).toBe("/tmp/README.pdf");
  expect(fallbackPdfExport?.byteLength).toBeGreaterThan(1_000);
  await expect(exportPdfButton).toBeEnabled();

  const locatePreviewButton = page.getByRole("button", {
    name: "Locate preview position",
  });
  const locateEditorButton = page.getByRole("button", {
    name: "Locate editor position",
  });
  const scrollSyncLockButton = page.getByRole("button", {
    name: "Disable synchronized scrolling",
  });
  await expect(scrollSyncLockButton).toHaveAttribute("aria-pressed", "true");
  await expect(locatePreviewButton).toBeHidden();
  await expect(locateEditorButton).toBeHidden();

  const editorScroller = page.locator(".cm-scroller");
  const cursorBeforeLockedScroll = await page
    .getByTestId("markdown-editor-cursor-position")
    .textContent();
  await editorScroller.evaluate((element) => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.scrollTop = maxScrollTop * 0.6;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);
  await page.waitForTimeout(500);

  await page.screenshot({
    path: "test-results/markdown-preview-locked-editor-to-preview.png",
    fullPage: true,
  });

  await editorScroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeLessThan(1);
  await page.waitForTimeout(500);

  await editorScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect
    .poll(() =>
      preview.locator("html").evaluate(() => {
        const scrollingElement = document.scrollingElement;
        if (!scrollingElement) return Number.POSITIVE_INFINITY;
        const maxScrollTop = Math.max(
          0,
          scrollingElement.scrollHeight - scrollingElement.clientHeight,
        );
        return maxScrollTop - scrollingElement.scrollTop;
      }),
    )
    .toBeLessThan(1);
  await page.waitForTimeout(500);

  await editorScroller.evaluate((element) => {
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.scrollTop = maxScrollTop * 0.6;
  });
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);

  await page.waitForTimeout(150);
  await previewFrame.hover();
  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeLessThan(50);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  await page.mouse.wheel(0, 900);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(100);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(50);
  const previewCenterSourcePosition = await preview
    .locator("body")
    .evaluate(() => {
      const selector = "[data-markdown-source-start]";
      const viewport = document.documentElement;
      const centerY = viewport.clientHeight / 2;
      const target = document.elementFromPoint(
        viewport.clientWidth / 2,
        centerY,
      );
      const direct = target?.closest<HTMLElement>(selector);
      if (direct) return direct.dataset.markdownSourceStart ?? null;

      let closest: { position: string; distance: number } | null = null;
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const rect = element.getBoundingClientRect();
        if (rect.bottom < 0 || rect.top > viewport.clientHeight) continue;
        const position = element.dataset.markdownSourceStart;
        if (!position) continue;
        const distance = Math.abs(rect.top + rect.height / 2 - centerY);
        if (!closest || distance < closest.distance) {
          closest = { position, distance };
        }
      }
      return closest?.position ?? null;
    });
  expect(previewCenterSourcePosition).toMatch(/^\d+$/);
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    cursorBeforeLockedScroll ?? "0",
  );

  await page.mouse.wheel(0, -2_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeLessThan(100);

  await page.screenshot({
    path: "test-results/markdown-preview-locked-sync.png",
    fullPage: true,
  });

  await scrollSyncLockButton.click();
  await expect(
    page.getByRole("button", { name: "Enable synchronized scrolling" }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(locatePreviewButton).toBeEnabled();
  await expect(locateEditorButton).toBeEnabled();

  await editorScroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(200);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBe(0);

  await page.screenshot({
    path: "test-results/markdown-preview-github.png",
    fullPage: true,
  });

  await locatePreviewButton.click();
  await expect(preview.locator("[data-navigation-highlight]")).toBeInViewport();
  await expect(
    page.locator('[data-navigation-highlight="editor"]'),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement?.scrollTop ?? 0),
    )
    .toBeGreaterThan(200);
  await expect
    .poll(() =>
      preview
        .getByRole("heading", { name: "Sync destination" })
        .evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
        }),
    )
    .toBeLessThan(180);

  const centerSourcePosition = await preview.locator("body").evaluate(() => {
    const target = document.elementFromPoint(
      document.documentElement.clientWidth / 2,
      document.documentElement.clientHeight / 2,
    );
    return target
      ?.closest("[data-markdown-source-start]")
      ?.getAttribute("data-markdown-source-start");
  });
  expect(centerSourcePosition).toMatch(/^\d+$/);
  await locateEditorButton.click();
  await expect(
    page.locator('[data-navigation-highlight="editor"]'),
  ).toBeInViewport();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    centerSourcePosition!,
  );
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  const doubleClickHeading = preview.getByRole("heading", {
    name: "Section four",
  });
  const doubleClickSourcePosition = await doubleClickHeading.getAttribute(
    "data-markdown-source-start",
  );
  expect(doubleClickSourcePosition).toMatch(/^\d+$/);
  // Start the double-click jump with the editor scrolled away from its target.
  await editorScroller.hover();
  await page.mouse.wheel(0, -10_000);
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBe(0);
  await doubleClickHeading.dblclick();
  await expect(
    page.locator('[data-navigation-highlight="editor"]'),
  ).toBeInViewport();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    doubleClickSourcePosition!,
  );
  const activeEditorLine = page.locator(".cm-line.cm-activeLine");
  await expect(activeEditorLine).toContainText("### Section four");
  await expect(activeEditorLine).toBeInViewport();
  await expect
    .poll(() => editorScroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);

  await page.screenshot({
    path: "test-results/markdown-preview-sync.png",
    fullPage: true,
  });

  await preview.locator("html").evaluate(() => {
    const style = document.querySelector("#catalex-markdown-preview-style");
    const math = document.querySelector<HTMLElement>(".katex-display .katex");
    if (!style || !math) throw new Error("Markdown math preview is not ready");
    math.dataset.renderIdentity = "before-edit";
    document.documentElement.dataset.previewStyleMutations = "0";
    const observer = new MutationObserver(() => {
      const currentCount = Number(
        document.documentElement.dataset.previewStyleMutations ?? "0",
      );
      document.documentElement.dataset.previewStyleMutations = String(
        currentCount + 1,
      );
    });
    observer.observe(style, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
  await page.getByRole("button", { name: "Update content" }).click();
  await expect(
    preview.getByRole("heading", { name: "Updated Preview" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  const liveRenderStability = await preview.locator("html").evaluate(() => ({
    mathNodePreserved: Boolean(
      document.querySelector('.katex[data-render-identity="before-edit"]'),
    ),
    styleMutations: Number(
      document.documentElement.dataset.previewStyleMutations ?? "0",
    ),
  }));
  expect(liveRenderStability).toEqual({
    mathNodePreserved: true,
    styleMutations: 0,
  });

  await page.getByRole("button", { name: "Markdown preview settings" }).click();
  await page
    .getByRole("menuitem", { name: "All Typora themes", exact: true })
    .click();
  await page
    .getByRole("menuitemradio", { name: "themes/academic.css" })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await expect
    .poll(() =>
      preview
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe("rgb(126, 58, 47)");

  await page
    .getByRole("button", { name: "Use configured Typora theme" })
    .click();
  await expect
    .poll(() =>
      preview
        .locator("h1")
        .evaluate((element) => getComputedStyle(element).color),
    )
    .toBe("rgb(35, 99, 235)");
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview.locator("body").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        appColorScheme: element.getAttribute("data-color-scheme"),
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
      appColorScheme: null,
    });

  await page.getByRole("button", { name: "Switch to dark mode" }).click();
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview.locator("body").evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        appColorScheme: element.getAttribute("data-color-scheme"),
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
      appColorScheme: null,
    });
  await expect
    .poll(() =>
      markdownToolbar.evaluate((element) => ({
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
      })),
    )
    .toEqual({
      background: "rgb(248, 250, 252)",
      color: "rgb(23, 37, 84)",
    });

  await page
    .getByRole("button", { name: "Disable Typora theme loading" })
    .click();
  await expect(themeSelect).toContainText("GitHub Dark");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(13, 17, 23)");

  await page
    .getByRole("button", { name: "Enable Typora theme loading" })
    .click();
  await expect(themeSelect).toContainText("Academic");
  await expect
    .poll(() =>
      preview
        .locator("body")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(248, 250, 252)");

  await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          byteLength: number;
          customThemeCssLoaded: boolean;
          nativeAvailable: boolean;
          nativePath: string;
        };
      }
    ).__markdownPdfExportHarness;
    if (!harness) throw new Error("PDF export harness is unavailable");
    harness.byteLength = 0;
    harness.customThemeCssLoaded = false;
    harness.nativeAvailable = true;
    harness.nativePath = "";
  });
  await page.emulateMedia({ media: "print" });
  await exportPdfButton.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __markdownPdfExportHarness?: {
                customThemeCssLoaded: boolean;
                nativePath: string;
              };
            }
          ).__markdownPdfExportHarness,
      ),
    )
    .toMatchObject({
      customThemeCssLoaded: true,
      nativePath: "/tmp/README.pdf",
    });
  const typoraNativeExport = await page.evaluate(() => {
    const harness = (
      window as Window & {
        __markdownPdfExportHarness?: {
          byteLength: number;
          previewTheme: string | null;
          printDisplay: string | null;
        };
      }
    ).__markdownPdfExportHarness;
    return harness;
  });
  expect(typoraNativeExport).toMatchObject({
    byteLength: 0,
    previewTheme: "typora",
    printDisplay: "block",
  });
  await page.emulateMedia({ media: "screen" });
  await expect(exportPdfButton).toBeEnabled();

  await page.screenshot({
    path: "test-results/markdown-preview-harness.png",
    fullPage: true,
  });
});

test("outline follows editor scrolling without moving the cursor", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace", {
    waitUntil: "domcontentloaded",
  });
  const outline = page.locator('[data-sidebar-section="outline"]');
  await expect(outline.locator('[aria-current="location"]')).toBeVisible();
  const initialHeading = await outline
    .locator('[aria-current="location"]')
    .textContent();
  const cursorPosition = () =>
    page.evaluate(async () => {
      const modulePath = "/src/renderer/stores/document-store.ts";
      return (await import(modulePath)).useDocumentStore.getState()
        .cursorPosition;
    });
  const initialCursor = await cursorPosition();
  const scroller = page.locator(".cm-scroller");
  await scroller.hover();
  await page.mouse.wheel(0, 700);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(300);
  await expect
    .poll(() => outline.locator('[aria-current="location"]').textContent())
    .not.toBe(initialHeading);
  expect(await cursorPosition()).toBe(initialCursor);
  const sectionThree = page
    .locator(".cm-line")
    .filter({ hasText: "### Section three" });
  await sectionThree.click({ position: { x: 60, y: 8 } });
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    "Section three",
  );
  // Allow the editor to finish revealing the clicked caret before measuring scrolling.
  await page.waitForTimeout(300);
  const scrollBefore = await scroller.evaluate((el) => el.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 40);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(scrollBefore);
  await expect
    .poll(() => outline.locator('[aria-current="location"]').textContent())
    .not.toBe("Section three");
  // Re-click the same caret after scrolling; it must reclaim the highlight even without a selection change.
  await sectionThree.click({ position: { x: 60, y: 8 } });
  await page.waitForTimeout(300);
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    "Section three",
  );
  await page.screenshot({
    path: "test-results/outline-scroll-highlight.png",
    fullPage: true,
  });
  await page.mouse.wheel(0, -3000);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(outline.locator('[aria-current="location"]')).toHaveText(
    initialHeading!,
  );
});

test("follows heading, HTML anchor and line links while rendering HTML snippets", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const waitForNavigation = () =>
    expect
      .poll(() =>
        page.evaluate(async () => {
          const { isNavigationScrolling } = await import(
            "/src/renderer/lib/navigation-scroll.ts"
          );
          const scrolls = [
            ...document.querySelectorAll<HTMLElement>(".cm-scroller"),
            document.querySelector("iframe")?.contentDocument?.scrollingElement,
          ].filter(Boolean);
          return scrolls.some((scroll) =>
            isNavigationScrolling(scroll as HTMLElement),
          );
        }),
      )
      .toBe(false);
  const content = page.locator(".cm-content");
  const source =
    '[Heading](#deep-heading) [HTML](#colored) [Line](#L30) [Other file](notes.md#linked-note)\n\n<span id="colored" style="color:red;background-color:#ffeeaa">Colored text</span>\n\n<details><summary>More information</summary>Hidden details</details>\n\n' +
    Array.from({ length: 35 }, (_, i) => `Paragraph ${i}.\n`).join("\n") +
    "\n## Deep *heading*\n\nDestination text.";
  await content.fill(source);
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  await expect(preview.locator("#catalex-anchor-colored")).toHaveCSS(
    "color",
    "rgb(255, 0, 0)",
  );
  await preview.getByText("More information").click();
  await expect(preview.getByText("Hidden details")).toBeVisible();
  await page.screenshot({
    path: "../../output/playwright/markdown-html-snippets.png",
  });
  await preview.getByRole("link", { name: "Heading", exact: true }).click();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    String(source.indexOf("## Deep")),
  );
  await expect
    .poll(() =>
      preview.getByRole("heading", { name: "Deep heading" }).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <= el.ownerDocument.documentElement.clientHeight
        );
      }),
    )
    .toBe(true);
  await waitForNavigation();
  await preview.getByRole("link", { name: "HTML", exact: true }).click();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    String(source.indexOf("<span")),
  );
  await waitForNavigation();
  await preview.getByRole("link", { name: "Line", exact: true }).click();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    String(source.split("\n").slice(0, 29).join("\n").length + 1),
  );
  await waitForNavigation();
  await preview.getByRole("link", { name: "Other file" }).click();
  await expect(
    page
      .frameLocator('iframe[title="notes.md preview"]')
      .getByRole("heading", { name: "Linked note" }),
  ).toBeVisible();
  await expect(page.getByTestId("markdown-editor-cursor-position")).toHaveText(
    "0",
  );
  await page.screenshot({
    path: "../../output/playwright/markdown-linked-note.png",
  });
});

test("previews the sidebar file insertion caret without editing, and clears it on drop or cancel", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace");
  const file = page.locator('[data-sidebar-file-id="notes.md"]');
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  const original = `alpha beta gamma\nsecond line\n${"Wrapped text ".repeat(120)}\nlast line`;
  await editor.fill(original);
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(editor).toContainText("alpha beta gamma");
  const readDocument = () =>
    page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const state = useDocumentStore.getState();
      return {
        content: state.files.find((file) => file.id === state.activeFileId)
          ?.content,
        cursor: state.cursorPosition,
        selection: state.selectionRange,
      };
    });
  const before = await readDocument();
  const caret = page.locator(".cm-markdown-file-drop-caret");
  const start = await file.boundingBox();
  const target = await editor
    .locator(".cm-line")
    .first()
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 6);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
  const startDrag = async () => {
    await page.mouse.move(start!.x + 70, start!.y + start!.height / 2);
    await page.mouse.down();
    await page.mouse.move(start!.x + 85, start!.y + start!.height / 2, {
      steps: 3,
    });
    await page.mouse.move(target.x, target.y, { steps: 15 });
    await expect(caret).toBeVisible();
  };
  await startDrag();
  const bounds = await caret.boundingBox();
  expect(Math.abs(bounds!.x - target.x)).toBeLessThan(3);
  expect(bounds!.y).toBeLessThan(target.y);
  expect(bounds!.y + bounds!.height).toBeGreaterThan(target.y);
  expect(await readDocument()).toEqual(before);
  await page.screenshot({
    path: "../../output/playwright/markdown-file-drop-caret.png",
  });
  await page.mouse.move(10, 10, { steps: 5 });
  await expect(caret).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 5 });
  await expect(caret).toBeVisible();
  await page.mouse.up();
  await expect(caret).toHaveCount(0);
  await expect
    .poll(async () => (await readDocument()).content)
    .toBe(
      "alpha [notes.md](notes.md)beta gamma" +
        original.slice("alpha beta gamma".length),
    );
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await readDocument()).content).toBe(original);
  await startDrag();
  await page.keyboard.press("Escape");
  await expect(
    page.locator('[data-slot="dropdown-menu-content"]'),
  ).toBeHidden();
  await page.mouse.up();
  await expect(caret).toHaveCount(0);
  expect((await readDocument()).content).toBe(original);
  // Wrapped text and a stationary pointer remain accurate while scrolling.
  const scroller = page.locator(".cm-scroller");
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBe(0);
  const wrappedPoint = await editor
    .locator(".cm-line")
    .nth(2)
    .evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 250);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    });
  await startDrag();
  await page.mouse.move(wrappedPoint.x, wrappedPoint.y, { steps: 5 });
  await expect(caret).toBeVisible();
  const previousScroll = await scroller.evaluate(
    (element) => element.scrollTop,
  );
  await page.mouse.wheel(0, 160);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(previousScroll + 100);
  await expect
    .poll(async () => {
      const rect = await caret.boundingBox();
      return (
        rect !== null &&
        rect.y <= wrappedPoint.y &&
        rect.y + rect.height >= wrappedPoint.y
      );
    })
    .toBe(true);
  await page.screenshot({
    path: "../../output/playwright/markdown-file-drop-caret-scrolled.png",
  });
  await page.mouse.up();
  await expect(caret).toHaveCount(0);
  expect(
    (await readDocument()).content!.indexOf("[notes.md](notes.md)"),
  ).toBeGreaterThan(original.indexOf("Wrapped text") + 250);
});

for (const previewOnly of [false, true]) {
  test(`returns from Markdown hyperlink jumps (preview only: ${previewOnly})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?debug=markdown-preview");
    const paragraphs = Array.from(
      { length: 25 },
      (_, i) => `Paragraph ${i}.\n`,
    ).join("\n");
    const source = `# Start\n\n${paragraphs}\n[First jump](#destination) [Other note](notes.md#linked-note)\n\n${paragraphs}\n## Destination\n\n[Next jump](#last)\n\n${paragraphs}\n## Last\n\n${paragraphs}`;
    await page.locator(".cm-content").fill(source);
    if (previewOnly)
      await page
        .getByRole("button", { name: "Toggle editor", exact: true })
        .click();
    const preview = page.frameLocator('iframe[title="README.md preview"]');
    const scrollTop = () =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement!.scrollTop);
    const first = preview.getByRole("link", {
      name: "First jump",
      exact: true,
    });
    await first.scrollIntoViewIfNeeded();
    const origin = await scrollTop();
    expect(origin).toBeGreaterThan(200);
    await first.click();
    const back = page.getByRole("button", { name: "Jump back", exact: true });
    await expect(back).toBeVisible();
    await expect.poll(scrollTop).toBeGreaterThan(origin + 200);
    await page.screenshot({
      path: `../../output/playwright/markdown-jump-back-${previewOnly}.png`,
    });
    await back.click();
    await expect(back).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await scrollTop()) - origin))
      .toBeLessThan(2);

    // A second jump replaces the return point, like the PDF preview.
    await first.click();
    const next = preview.getByRole("link", { name: "Next jump", exact: true });
    await next.scrollIntoViewIfNeeded();
    const secondOrigin = await scrollTop();
    await next.click();
    await expect.poll(scrollTop).toBeGreaterThan(secondOrigin + 200);
    await back.click();
    await expect
      .poll(async () => Math.abs((await scrollTop()) - secondOrigin))
      .toBeLessThan(2);

    // The return point includes the source file for cross-file anchors.
    const other = preview.getByRole("link", {
      name: "Other note",
      exact: true,
    });
    await other.scrollIntoViewIfNeeded();
    const crossFileOrigin = await scrollTop();
    await other.click();
    const backToFile = page.getByRole("button", {
      name: "Jump back to README.md",
      exact: true,
    });
    await expect(backToFile).toBeVisible();
    await backToFile.focus();
    await page.keyboard.press("Enter");
    await expect(backToFile).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await scrollTop()) - crossFileOrigin))
      .toBeLessThan(2);

    // Dismissal leaves the reading position and editor cursor untouched.
    await first.click();
    await expect(back).toBeVisible();
    const dismissedScroll = await scrollTop();
    const cursor = page.getByTestId("markdown-editor-cursor-position");
    const cursorBeforeDismiss = await cursor.textContent();
    const dismiss = page.getByRole("button", {
      name: "Dismiss jump back",
      exact: true,
    });
    if (previewOnly) {
      await dismiss.focus();
      await page.keyboard.press("Enter");
    } else {
      await dismiss.click();
    }
    await expect(back).toHaveCount(0);
    await expect(dismiss).toHaveCount(0);
    await expect
      .poll(async () => Math.abs((await scrollTop()) - dismissedScroll))
      .toBeLessThan(2);
    await expect(cursor).toHaveText(cursorBeforeDismiss!);

    // A new jump can show the popup again; unrelated file selection clears it.
    await first.click();
    await expect(back).toBeVisible();
    await page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.getState().setActiveFile("notes.md");
    });
    await expect(page.getByRole("button", { name: /Jump back/ })).toHaveCount(
      0,
    );
  });
}

for (const direction of ["down", "up"] as const) {
  test(`dismisses the Markdown return popup when scrolling past its origin after a ${direction} jump`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: direction === "up" ? "reduce" : "no-preference",
    });
    await page.goto("/?debug=markdown-preview");
    const paragraphs = Array.from(
      { length: 35 },
      (_, i) => `Paragraph ${i}.\n`,
    ).join("\n");
    await page
      .locator(".cm-content")
      .fill(
        `# Top\n\n${paragraphs}\n[Down](#bottom)\n\n${paragraphs}\n# Bottom\n\n[Up](#top)\n\n${paragraphs}`,
      );
    const preview = page.frameLocator('iframe[title="README.md preview"]');
    const link = preview.getByRole("link", {
      name: direction === "down" ? "Down" : "Up",
      exact: true,
    });
    const top = () =>
      preview
        .locator("html")
        .evaluate(() => document.scrollingElement!.scrollTop);
    await link.scrollIntoViewIfNeeded();
    const origin = await top();
    await link.click();
    const back = page.getByRole("button", { name: "Jump back", exact: true });
    await expect(back).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const { isNavigationScrolling } = await import(
            "/src/renderer/lib/navigation-scroll.ts"
          );
          return isNavigationScrolling(
            document.querySelector("iframe")!.contentDocument!
              .scrollingElement as HTMLElement,
          );
        }),
      )
      .toBe(false);
    const destination = await top();
    expect(Math.abs(destination - origin)).toBeGreaterThan(300);
    await expect(back).toBeVisible();
    await page.locator('iframe[title="README.md preview"]').hover();
    // Ordinary reading that has not reached the origin keeps the popup.
    await page.mouse.wheel(0, direction === "down" ? 120 : 40);
    await expect.poll(top).toBeGreaterThan(destination + 20);
    await expect(back).toBeVisible();
    const current = await top();
    await page.mouse.wheel(
      0,
      origin - current + (direction === "down" ? -150 : 150),
    );
    await expect(back).toHaveCount(0);
    if (direction === "down") await expect.poll(top).toBeLessThan(origin);
    else await expect.poll(top).toBeGreaterThan(origin);
    await page.screenshot({
      path: `../../output/playwright/markdown-return-passed-${direction}.png`,
    });
  });
}
