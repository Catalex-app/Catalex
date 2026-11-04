import { expect, test } from "@playwright/test";

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
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Expand Preview", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Expand Preview", exact: true })
    .click();
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
    const samples = await page.evaluate(
      async ({ action, toolbar }) => {
        const panel = document.querySelector<HTMLElement>(
          '[data-workspace-column="preview"]',
        )!;
        const viewport = panel.querySelector<HTMLElement>(
          '[data-testid="pdf-scroll-container"]',
        )!;
        const pdfPage = panel.querySelector<HTMLElement>(".mupdf-page")!;
        const button = [
          ...panel.querySelectorAll<HTMLButtonElement>("button"),
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
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
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
  await expanded
    .getByRole("button", { name: "Expand Editor", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(expanded).not.toHaveAttribute(
    "data-panel-expansion-motion",
    /.+/,
  );
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(page.locator("[data-expanded-panel-ancestor]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
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
    await page
      .getByRole("button", { name: `Expand ${label}`, exact: true })
      .click();
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
