import { expect, type Page, test } from "@playwright/test";

async function openExpandAction(page: Page, label: string) {
  await page
    .getByRole("button", { name: `More ${label} view actions`, exact: true })
    .click();
  return page.getByRole("menuitem", { name: `Expand ${label}`, exact: true });
}

for (const markdown of [false, true]) {
  test(`${markdown ? "Markdown" : "LaTeX"} formatting switches once and fades during panel resizing`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(
      markdown ? "/?debug=markdown-workspace" : "/?debug=comment-workspace&pdf",
    );
    const toolbar = page.getByTestId(
      markdown ? "markdown-editor-toolbar" : "latex-editor-toolbar",
    );
    const formatting = toolbar.locator("[data-formatting-collapsed]");
    await expect(formatting).toHaveAttribute(
      "data-formatting-collapsed",
      "true",
    );
    for (const action of ["Expand Editor", "Restore Editor"]) {
      const button = await (action === "Expand Editor"
        ? await openExpandAction(page, "Editor")
        : page.getByRole("button", { name: action, exact: true })
      ).elementHandle();
      const samples = await button!.evaluate(async (button) => {
        const panel = document
          .querySelector(
            '[data-testid="latex-editor-toolbar"], [data-testid="markdown-editor-toolbar"]',
          )!
          .closest("[data-workspace-panel-screen]")!;
        const formatting = panel.querySelector<HTMLElement>(
          "[data-formatting-collapsed]",
        )!;
        const tools = formatting.firstElementChild!;
        const samples: {
          collapsed: boolean;
          moving: boolean;
          opacity: number;
          height: number;
          gap: number;
        }[] = [];
        button.click();
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const sample = () => {
            samples.push({
              collapsed: formatting.dataset.formattingCollapsed === "true",
              moving: panel.hasAttribute("data-panel-expansion-motion"),
              opacity: Number(getComputedStyle(tools).opacity),
              height: formatting.getBoundingClientRect().height,
              gap: Number.parseFloat(
                getComputedStyle(
                  panel.querySelector("[data-panel-control-separator]")!,
                ).marginLeft,
              ),
            });
            // Include menu dismissal, the panel morph, and the formatting fade.
            if (performance.now() - start < 900) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return samples;
      });
      const changes = samples.filter(
        (sample, index) =>
          index > 0 && sample.collapsed !== samples[index - 1].collapsed,
      );
      expect(changes).toHaveLength(1);
      expect(samples.some((s) => s.opacity > 0 && s.opacity < 1)).toBe(true);
      expect(samples.every((s) => Math.abs(s.height - 28) < 1)).toBe(true);
      expect(samples.every((sample) => sample.gap === 8)).toBe(true);
      if (action === "Expand Editor")
        expect(samples.filter((s) => s.moving).every((s) => s.collapsed)).toBe(
          true,
        );
      expect(samples.at(-1)!.collapsed).toBe(action === "Restore Editor");
      await toolbar.screenshot({
        path: test
          .info()
          .outputPath(
            `${action.startsWith("Expand") ? "expanded" : "compact"}-formatting.png`,
          ),
      });
    }
    await toolbar
      .getByRole("button", { name: "Formatting options", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog", { name: "Formatting options", exact: true })
        .getByRole("button", { name: "Bold", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(formatting.locator(":scope > div").first()).toHaveCSS(
      "transition-property",
      "none",
    );
  });
}

test("Escape restores the editor without moving focus or its caret to the toolbar", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const content = page.locator(".cm-content").first();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.press("ArrowRight");
  const selection = await page.evaluate(() =>
    window.__getInputTransferHarnessSelectionState?.(),
  );
  const expand = page.getByRole("button", {
    name: "More Editor view actions",
    exact: true,
  });
  await expand.click();
  await page.getByRole("menuitem", { name: /^Expand / }).click();
  const panel = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  await expect(content).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(content).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.__getInputTransferHarnessSelectionState?.(),
    ),
  ).toEqual(selection);
  expect(await expand.evaluate((e) => e.matches(":focus-visible"))).toBe(false);
  await page.keyboard.insertText("focus-preserved");
  await expect(content).toContainText("focus-preserved");
});

test("PDF Escape preserves reading focus and Tab still exposes window-control focus", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const expand = page.getByRole("button", {
    name: "More PDF view actions",
    exact: true,
  });
  const panel = page.getByRole("dialog", { name: "PDF expanded", exact: true });
  const content = page.getByTestId("pdf-scroll-container");
  await expand.click();
  await page.getByRole("menuitem", { name: /^Expand / }).click();
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  await expect(content).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(content).toBeFocused();
  expect(await expand.evaluate((e) => e.matches(":focus-visible"))).toBe(false);
  await expand.click();
  await page.getByRole("menuitem", { name: /^Expand / }).click();
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  await page.keyboard.press("Tab");
  expect(await panel.evaluate((p) => p.contains(document.activeElement))).toBe(
    true,
  );
  const restore = panel.getByRole("button", {
    name: "Restore PDF",
    exact: true,
  });
  await restore.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    panel.getByRole("button", {
      name: "Pop out PDF",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(restore).toBeFocused();
  expect(await restore.evaluate((e) => e.matches(":focus-visible"))).toBe(true);
  // A keyboard-opened hint gets Escape before the enclosing panel does.
  if (await page.getByRole("tooltip").isVisible()) {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(panel).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(expand).toBeFocused();
  expect(await expand.evaluate((e) => e.matches(":focus-visible"))).toBe(true);
});

test("Markdown Escape keeps focus in the preview iframe", async ({ page }) => {
  await page.goto("/?debug=markdown-workspace");
  const frame = page.getByTestId("markdown-preview").locator("iframe");
  await expect(frame.contentFrame().locator("#write h1")).toBeVisible();
  await (await openExpandAction(page, "Preview")).click();
  const panel = page.getByRole("dialog", {
    name: "Preview expanded",
    exact: true,
  });
  await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
  await expect(frame).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(frame).toBeFocused();
});

test("expanded editor hides file tabs and retains its mounted editor, selection and undo", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?debug=input-transfer");
  const content = page.locator(".cm-content").first();
  await expect(content).toBeVisible();
  await content.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.insertText("% expansion edit\n");
  await page.keyboard.press("Shift+ArrowUp");
  const originalEditor = await content.elementHandle();
  const selection = await page.evaluate(() =>
    window.__getInputTransferHarnessSelectionState?.(),
  );
  const before = await content.innerText();
  await (await openExpandAction(page, "Editor")).click();
  const expanded = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(expanded.locator("[data-editor-toolbar]")).toHaveCount(0);
  await expect(expanded.getByTestId("latex-editor-toolbar")).toBeVisible();
  await expect(expanded.locator(".cm-content")).toContainText("expansion edit");
  expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  expect(
    await page.evaluate(() =>
      window.__getInputTransferHarnessSelectionState?.(),
    ),
  ).toEqual(selection);
  await expanded
    .getByRole("button", { name: "Sectioning command", exact: true })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(expanded).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("expanded-editor-light.png"),
  });
  await page
    .getByRole("button", { name: "Restore Editor", exact: true })
    .click();
  await expect(expanded).toHaveCount(0);
  await expect(page.locator("[data-editor-toolbar]")).toBeVisible();
  expect(await originalEditor!.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  expect(await content.innerText()).toBe(before);
  await content.focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(content).not.toContainText("expansion edit");
});

test("Markdown expansion supports its theme menu, iframe Escape and backdrop focus", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto("/?debug=markdown-workspace");
  const preview = page.getByTestId("markdown-preview");
  await expect(preview).toBeVisible();
  await (await openExpandAction(page, "Preview")).click();
  const expanded = page.getByRole("dialog", {
    name: "Preview expanded",
    exact: true,
  });
  await expect(expanded).toBeVisible();
  await expanded
    .getByRole("combobox", { name: "Markdown preview theme" })
    .click();
  await expect(
    page.getByRole("option", { name: "GitHub Dark", exact: true }),
  ).toBeVisible();
  await page.getByRole("option", { name: "GitHub Dark", exact: true }).click();
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: test.info().outputPath("expanded-markdown-dark-narrow.png"),
  });
  await expanded.locator("iframe").contentFrame().locator("body").click();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await (await openExpandAction(page, "Preview")).click();
  await page.mouse.click(5, 300);
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(page.locator("[data-expanded-panel-ancestor]")).toHaveCount(0);
  await expect(page.locator("[data-workspace-panel-backdrop]")).toHaveCount(0);
});

test("PDF and panel morph together on expand and restore", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const panel = page.locator('[data-workspace-column="preview"]');
  const original = await panel.boundingBox();
  const toolbar = await page
    .getByText("Browser demo · Comment Review", { exact: true })
    .locator("..")
    .elementHandle();
  for (const action of ["Expand PDF", "Restore PDF"]) {
    if (action === "Expand PDF") await openExpandAction(page, "PDF");
    const samples = await page.evaluate(
      async ({ action, toolbar }) => {
        const panel = document.querySelector<HTMLElement>(
          '[data-workspace-column="preview"]',
        )!;
        const button = [
          ...document.querySelectorAll<HTMLElement>(
            'button, [role="menuitem"]',
          ),
        ].find((button) => button.getAttribute("aria-label") === action)!;
        const samples: {
          width: number;
          pageWidth: number;
          viewportWidth: number;
          top: number;
          left: number;
          moving: boolean;
          transition: string;
          backgroundWidth: number;
          backgroundTop: number;
        }[] = [];
        const start = performance.now();
        button.click();
        await new Promise<void>((resolve) => {
          const sample = () => {
            const rect = panel.getBoundingClientRect();
            // A background compile can replace the PDF while the menu closes.
            // Measure the live page rather than retaining its previous DOM node.
            const viewport = panel.querySelector<HTMLElement>(
              '[data-testid="pdf-scroll-container"]',
            )!;
            const pdfPage = panel.querySelector<HTMLElement>(".mupdf-page")!;
            samples.push({
              width: rect.width,
              pageWidth: pdfPage.getBoundingClientRect().width,
              viewportWidth: viewport.clientWidth,
              top: rect.top,
              left: rect.left,
              moving: panel.hasAttribute("data-panel-expansion-motion"),
              transition: getComputedStyle(pdfPage).transitionDuration,
              backgroundWidth: toolbar!.getBoundingClientRect().width,
              backgroundTop: toolbar!.getBoundingClientRect().top,
            });
            if (performance.now() - start < 700) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return samples;
      },
      { action, toolbar },
    );
    const first = samples[0];
    const last = samples[samples.length - 1];
    const intermediate = samples.filter(
      (sample) =>
        Math.abs(sample.width - first.width) > 5 &&
        Math.abs(sample.width - last.width) > 5,
    );
    expect(intermediate.length).toBeGreaterThan(2);
    for (const sample of intermediate) {
      expect(sample.moving).toBe(true);
      // Fit width keeps the same 16px page padding on every rendered frame.
      expect(
        Math.abs(sample.pageWidth - (sample.viewportWidth - 32)),
      ).toBeLessThan(3);
      expect(sample.transition).toBe("0s");
    }
    expect(Math.abs(last.width - first.width)).toBeGreaterThan(300);
    expect(last.backgroundTop).toBeCloseTo(action === "Expand PDF" ? 36 : 0, 1);
    const direction = action === "Expand PDF" ? 1 : -1;
    for (let i = 1; i < samples.length; i++) {
      expect(
        (samples[i].width - samples[i - 1].width) * direction,
      ).toBeGreaterThanOrEqual(-1);
      expect(
        (samples[i].backgroundWidth - samples[i - 1].backgroundWidth) *
          direction,
      ).toBeLessThanOrEqual(1);
    }
    for (const sample of intermediate)
      expect(sample.backgroundTop).toBeGreaterThan(0);
    await test.info().attach(`${action}-frames`, {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: test.info().outputPath(`${action}.png`) });
  }
  expect((await panel.boundingBox())!.width).toBeCloseTo(original!.width, 0);
  await expect(page.locator("[data-expanded-panel-ancestor]")).toHaveCount(0);
  await expect(page.locator("[data-workspace-panel-background]")).toHaveCount(
    0,
  );
});

test("expansion reverses smoothly and honors reduced motion", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await (await openExpandAction(page, "Editor")).click();
  const expanded = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(expanded).toHaveAttribute(
    "data-panel-expansion-motion",
    "entering",
  );
  // Programmatic activation avoids Playwright waiting for the moving button to settle.
  await expanded
    .getByRole("button", { name: "Restore Editor", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(expanded).toHaveAttribute(
    "data-panel-expansion-motion",
    "exiting",
  );
  await expect(expanded).toHaveCount(0);
  await expect(page.locator("[data-expanded-panel-ancestor]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await (await openExpandAction(page, "Editor")).click();
  await expect(expanded).toBeVisible();
  await expect(expanded).not.toHaveAttribute(
    "data-panel-expansion-motion",
    /.+/,
  );
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
});

test("editor restore lands on the split width without shifting the text inset", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await (await openExpandAction(page, "Editor")).click();
  const expanded = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(expanded).not.toHaveAttribute(
    "data-panel-expansion-motion",
    /.+/,
  );
  const frames = await expanded.evaluate(async (panel) => {
    const content = panel.querySelector<HTMLElement>(".cm-content")!;
    const frames: {
      floating: boolean;
      width: number;
      insetX: number;
      insetY: number;
    }[] = [];
    panel
      .querySelector<HTMLButtonElement>('[aria-label="Restore Editor"]')!
      .click();
    await new Promise<void>((resolve) => {
      const sample = () => {
        const rect = panel.getBoundingClientRect();
        const text = content.getBoundingClientRect();
        const floating = panel.hasAttribute("data-expanded-workspace-panel");
        frames.push({
          floating,
          width: rect.width,
          insetX: text.x - rect.x,
          insetY: text.y - rect.y,
        });
        if (floating) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return frames;
  });
  expect(frames.length).toBeGreaterThan(3);
  const lastMoving = frames[frames.length - 2];
  const restored = frames[frames.length - 1];
  expect(lastMoving.floating).toBe(true);
  expect(restored.floating).toBe(false);
  expect(Math.abs(lastMoving.width - restored.width)).toBeLessThan(1);
  expect(Math.abs(lastMoving.insetX - restored.insetX)).toBeLessThan(0.1);
  expect(Math.abs(lastMoving.insetY - restored.insetY)).toBeLessThan(0.1);
  await page.screenshot({
    path: test.info().outputPath("editor-restored-alignment.png"),
  });
});

for (const label of ["Editor", "PDF", "Preview"]) {
  test(`${label} fullscreen selection toolbar stays clickable and opens a comment`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(
      label === "Preview"
        ? "/?debug=markdown-workspace"
        : "/?debug=comment-workspace&pdf",
    );
    if (label !== "Preview")
      await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    await (await openExpandAction(page, label)).click();
    const panel = page.getByRole("dialog", {
      name: `${label} expanded`,
      exact: true,
    });
    await expect(panel).not.toHaveAttribute("data-panel-expansion-motion");
    const select = async () => {
      if (label === "Editor") {
        await panel.locator(".cm-content").focus();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("Shift+End");
      } else if (label === "Preview") {
        const text = panel
          .locator("iframe")
          .contentFrame()
          .locator("strong [data-comment-start]")
          .first();
        await expect(text).toBeVisible();
        await text.evaluate((element) => {
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          const selection = element.ownerDocument.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
        });
      } else {
        const line = panel
          .locator(".mupdf-text-layer text")
          .filter({ hasText: "Your abstract here." })
          .first();
        await line.evaluate((element) => {
          const node = element.firstChild!;
          const text = node.textContent!;
          const start = text.indexOf("Your");
          window
            .getSelection()!
            .setBaseAndExtent(
              node,
              start,
              node,
              start + "Your abstract here.".length,
            );
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        });
      }
    };
    await select();
    const toolbar = page.locator("[data-selection-toolbar]");
    const comment = toolbar.getByRole("button", {
      name: "Comment",
      exact: true,
    });
    await expect(comment).toBeVisible();
    // Visibility alone does not detect a popup painted underneath the panel.
    await comment.click({ trial: true });
    await toolbar.hover();
    await expect(toolbar).toHaveCSS("width", "184px");
    await page.screenshot({
      path: test.info().outputPath("fullscreen-selection-toolbar.png"),
    });
    await comment.focus();
    if (label !== "Editor") {
      // The comment action's hint takes the first Escape while it is open.
      await expect(page.getByRole("tooltip")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    }
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
    await expect(panel).toBeVisible();
    await select();
    await comment.click();
    const input = panel.getByRole("textbox", {
      name: "Comment text",
      exact: true,
    });
    await expect(input).toBeVisible();
    await input.fill("Comment from the fullscreen panel");
    if (label === "Editor") await input.press("Enter");
    else
      await panel
        .getByRole("button", { name: "Save comment", exact: true })
        .click();
    await expect(
      panel
        .getByText("Comment from the fullscreen panel", { exact: true })
        .last(),
    ).toBeVisible();
    await expect(panel).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("fullscreen-comment.png"),
    });
  });
}

test("the chat drawer fades out and back in when focusing a panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator("[data-chat-drawer-overlay]");
  const composer = drawer.locator('textarea[data-chat-composer-input="true"]');
  await composer.fill("Preserve this draft while focusing the editor.");
  const originalComposer = await composer.elementHandle();
  for (const entering of [true, false]) {
    const action = entering
      ? await openExpandAction(page, "Editor")
      : page.getByRole("button", { name: "Restore Editor", exact: true });
    const recording = action.evaluate(
      (button) =>
        new Promise<{ opacity: number; width: number }[]>((resolve) => {
          const overlay = document.querySelector("[data-chat-drawer-overlay]")!;
          const drawer = overlay.querySelector("[data-chat-drawer-panel]")!;
          const samples: { opacity: number; width: number }[] = [];
          const start = performance.now();
          (button as HTMLElement).click();
          const sample = () => {
            samples.push({
              opacity: Number(getComputedStyle(overlay).opacity),
              width: parseFloat(getComputedStyle(drawer).width),
            });
            if (performance.now() - start < 500) requestAnimationFrame(sample);
            else resolve(samples);
          };
          requestAnimationFrame(sample);
        }),
    );
    if (entering)
      await expect(
        page.locator("[data-expanded-workspace-panel]"),
      ).toBeVisible();
    await page.waitForTimeout(80);
    await page.screenshot({
      path: test
        .info()
        .outputPath(entering ? "drawer-exiting.png" : "drawer-returning.png"),
    });
    const frames = await recording;
    expect(frames.some(({ opacity }) => opacity > 0 && opacity < 1)).toBe(true);
    expect(
      Math.max(...frames.map(({ width }) => width)) -
        Math.min(...frames.map(({ width }) => width)),
    ).toBeLessThan(2);
    await expect(drawer).toHaveCSS("opacity", entering ? "0" : "1");
    await expect(composer).toHaveValue(
      "Preserve this draft while focusing the editor.",
    );
    expect(
      await originalComposer!.evaluate((element) => element.isConnected),
    ).toBe(true);
  }
  await expect(page.locator(".cm-content").first()).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await (await openExpandAction(page, "Editor")).click();
  await expect(drawer).toHaveCSS("transition-duration", "0s");
  await expect(drawer).toHaveCSS("opacity", "0");
  await page
    .getByRole("button", { name: "Restore Editor", exact: true })
    .click();
  await expect(drawer).toHaveCSS("opacity", "1");
});
