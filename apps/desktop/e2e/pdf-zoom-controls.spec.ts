import { expect, test } from "@playwright/test";

test("joined zoom input and fit buttons work in wide and narrow panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(
    page.locator('[data-page-number="1"] .mupdf-text-layer').first(),
  ).toBeVisible();
  const input = page.getByRole("textbox", { name: "Zoom percentage" });
  const width = page.getByRole("button", { name: "Fit width", exact: true });
  const height = page.getByRole("button", { name: "Fit height", exact: true });
  await expect(width).toHaveAttribute("aria-pressed", "true");
  await input.fill("125%");
  await expect(input).toHaveCSS("outline-style", "none");
  await expect(input).toHaveCSS("box-shadow", "none");
  for (const dark of [false, true]) {
    await page.evaluate((dark) => {
      document.documentElement.classList.toggle("dark", dark);
    }, dark);
    await expect(
      page.getByRole("group", { name: "PDF zoom", exact: true }),
    ).toHaveCSS(
      "border-color",
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--ring")
          .trim(),
      ),
    );
    await page
      .getByRole("group", { name: "PDF zoom", exact: true })
      .screenshot({
        path: test
          .info()
          .outputPath(`zoom-focus-${dark ? "dark" : "light"}.png`),
      });
  }
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await input.press("Enter");
  await expect(input).toHaveValue("125%");
  await expect(width).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(input).toHaveValue("135%");
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await expect(input).toHaveValue("125%");
  await input.fill("200");
  await input.press("Escape");
  await expect(input).toHaveValue("125%");
  await input.fill("invalid");
  await input.press("Enter");
  await expect(input).toHaveValue("125%");
  await input.fill("400");
  await input.press("Enter");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(input).toHaveValue("410%");
  await input.fill("999");
  await input.press("Enter");
  await expect(input).toHaveValue("999%");
  await input.fill("9999");
  await input.press("Enter");
  await expect(input).toHaveValue("1200%");
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeDisabled();
  const scroller = page.getByTestId("pdf-scroll-container").first();
  await scroller.press("Control+-");
  await expect(input).toHaveValue("1175%");
  await scroller.press("Control+=");
  await expect(input).toHaveValue("1200%");
  await input.fill("10");
  await input.press("Tab");
  await expect(input).toHaveValue("25%");
  await expect(
    page.getByRole("button", { name: "Zoom out", exact: true }),
  ).toBeDisabled();
  await height.click();
  await expect(height).toHaveAttribute("aria-pressed", "true");
  await width.click();
  await expect(width).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: test.info().outputPath("zoom-controls-wide.png"),
  });
  await page.setViewportSize({ width: 1000, height: 800 });
  for (const control of [
    page.getByRole("button", { name: "Export PDF", exact: true }),
    width,
    height,
    input,
    page.getByRole("button", { name: "Zoom out", exact: true }),
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ]) {
    await expect(control).toBeVisible();
    await expect
      .poll(async () => {
        const bounds = await control.boundingBox();
        return bounds!.x + bounds!.width;
      })
      .toBeLessThanOrEqual(1000);
  }
  await height.click();
  await expect(height).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: test.info().outputPath("zoom-controls-narrow.png"),
  });
});

test("page gaps and shadows scale with zoom and stay consistent when a pinch settles", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&multipage");
  const pages = page.locator(".mupdf-page");
  await expect(pages.nth(1)).toBeAttached();
  const content = page.locator("[data-pdf-scroll-content]").first();
  const input = page.getByRole("textbox", { name: "Zoom percentage" });
  const settle = () =>
    content.evaluate(async (element) => {
      await Promise.allSettled(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
  const pageGap = () =>
    pages
      .first()
      .evaluate(
        (element) =>
          element.nextElementSibling!.getBoundingClientRect().top -
          element.getBoundingClientRect().bottom,
      );
  const pageShadow = () =>
    pages.first().evaluate((element) => {
      const content = element.parentElement!;
      const previewScale = new DOMMatrix(getComputedStyle(content).transform).a;
      return (
        getComputedStyle(element).boxShadow.match(/-?[\d.]+px/g) ?? []
      ).map((length) => parseFloat(length) * previewScale);
    });
  for (const percent of [25, 50, 100, 200, 400, 1200, 100]) {
    await input.fill(String(percent));
    await input.press("Enter");
    await settle();
    await expect.poll(pageGap).toBeCloseTo((12 * percent) / 100, 0);
    const shadow = await pageShadow();
    expect(shadow).toHaveLength(8);
    for (const [index, length] of [0, 10, 15, -3, 0, 4, 6, -4].entries())
      expect(shadow[index]).toBeCloseTo((length * percent) / 100, 1);
  }
  await pages.first().evaluate((element) => {
    const viewport = element.closest<HTMLElement>(
      '[data-testid="pdf-scroll-container"]',
    )!;
    viewport.scrollTop +=
      element.getBoundingClientRect().bottom -
      viewport.getBoundingClientRect().top -
      viewport.clientHeight / 2;
  });
  await page.screenshot({
    path: test.info().outputPath("page-shadow-100-percent.png"),
  });
  await content.evaluate(async (element) => {
    const viewport = element.parentElement!;
    const frame = viewport.getBoundingClientRect();
    viewport.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -Math.log(2) / 0.005,
        clientX: frame.left + viewport.clientWidth / 2,
        clientY: frame.top + viewport.clientHeight / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise(requestAnimationFrame);
  });
  const previewGap = await pageGap();
  const previewShadow = await pageShadow();
  expect(previewGap).toBeCloseTo(24, 0);
  await expect(input).toHaveValue("200%");
  await expect
    .poll(() => content.evaluate((element) => element.style.transform))
    .toBe("");
  await settle();
  expect(await pageGap()).toBeCloseTo(previewGap, 0);
  const settledShadow = await pageShadow();
  for (const [index, length] of previewShadow.entries())
    expect(settledShadow[index]).toBeCloseTo(length, 1);
  await page.screenshot({
    path: test.info().outputPath("scaled-page-gap.png"),
  });
});

test.describe("Retina high zoom", () => {
  test.use({ deviceScaleFactor: 2, viewport: { width: 1200, height: 800 } });
  test("renders and pans a 1200% PDF without allocating an unbounded page bitmap", async ({
    page,
  }, testInfo) => {
    await page.goto("/?debug=pdf-comments&performance");
    const paper = page.locator(".mupdf-page").first();
    await expect(paper.locator(".mupdf-text-layer")).toBeVisible();
    const input = page.getByRole("textbox", { name: "Zoom percentage" });
    await input.fill("1200");
    await input.press("Enter");
    await expect(input).toHaveValue("1200%");
    await expect
      .poll(() =>
        paper
          .locator("[data-pdf-page-canvas]")
          .evaluate((canvas) => Number(canvas.dataset.pdfRenderedScale)),
      )
      .toBeGreaterThan(2);
    await paper.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    const geometry = await paper.evaluate((element) => {
      const canvas = element.querySelector<HTMLCanvasElement>(
        "[data-pdf-page-canvas]",
      )!;
      const text = element.querySelector<SVGSVGElement>(".mupdf-text-layer")!;
      return {
        width: element.getBoundingClientRect().width,
        pageWidth: text.viewBox.baseVal.width,
        pixels: canvas.width * canvas.height,
        longestSide: Math.max(canvas.width, canvas.height),
      };
    });
    expect(geometry.width).toBeCloseTo(geometry.pageWidth * 12, 0);
    expect(geometry.pixels).toBeLessThan(8_500_000);
    expect(geometry.longestSide).toBeLessThanOrEqual(16384);
    const scroller = page.getByTestId("pdf-scroll-container").first();
    await scroller.evaluate((element) =>
      element.scrollTo({ left: 800, top: 700 }),
    );
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollLeft))
      .toBe(800);
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBe(700);
    await paper.evaluate((element) => {
      const line = element.querySelector(".mupdf-text-layer text")!;
      const viewport = element.closest<HTMLElement>(
        '[data-testid="pdf-scroll-container"]',
      )!;
      const text = line.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      viewport.scrollBy(
        text.left - bounds.left - 30,
        text.top - bounds.top - 30,
      );
    });
    await scroller.screenshot({
      path: testInfo.outputPath("retina-1200-percent.png"),
    });
    await page.getByRole("button", { name: "Fit width", exact: true }).click();
    await expect(input).not.toHaveValue("1200%");
    await expect(paper.locator(".mupdf-text-layer")).toBeVisible();
    await scroller.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -10000,
          clientX: bounds.left + 100,
          clientY: bounds.top + 100,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(input).toHaveValue("1200%");
    await scroller.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      element.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: 10000,
          clientX: bounds.left + 100,
          clientY: bounds.top + 100,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(input).toHaveValue("25%");
  });
});
