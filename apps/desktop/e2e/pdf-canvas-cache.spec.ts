import { expect, test } from "@playwright/test";
import * as mupdf from "mupdf";

// Generated, deterministic image pages: no binary fixture or native compiler needed.
function fixture(pageCount: number, images: boolean) {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addSimpleFont(font);
  try {
    for (let n = 0; n < pageCount; n++) {
      let imageRef: mupdf.PDFObject | undefined;
      if (images) {
        const pixmap = new mupdf.Pixmap(
          mupdf.ColorSpace.DeviceRGB,
          [0, 0, 512, 512],
          false,
        );
        const pixels = pixmap.getPixels();
        for (let i = 0; i < pixels.length; i++)
          pixels[i] = (i * 17 + n * 31 + (i >> 9)) % 256;
        const image = new mupdf.Image(pixmap);
        imageRef = doc.addImage(image);
        image.destroy();
        pixmap.destroy();
      }
      const page = doc.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: fontRef }, XObject: imageRef ? { Im1: imageRef } : {} },
        `BT /F1 18 Tf 50 740 Td (Canvas memory test page ${n + 1}) Tj 0 -25 Td (Synthetic document heading) Tj 0 -25 Td (Your abstract here.) Tj ET\n${images ? "q 500 0 0 500 50 100 cm /Im1 Do Q" : ""}`,
      );
      doc.insertPage(-1, page);
      page.destroy();
      imageRef?.destroy();
    }
    const bytes = doc.saveToBuffer("compress");
    try {
      return Buffer.from(bytes.asUint8Array());
    } finally {
      bytes.destroy();
    }
  } finally {
    fontRef.destroy();
    font.destroy();
    doc.destroy();
  }
}

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

test("page clicks and dismissed selections release offscreen PDF text", async ({
  page,
}) => {
  const count = 30;
  await page.route("**/examples/paper-standard/main.pdf", (route) =>
    route.fulfill({
      contentType: "application/pdf",
      body: fixture(count, false),
    }),
  );
  await page.goto("/?debug=pdf-comments");
  await page
    .getByRole("button", { name: "Toggle PDF comments", exact: true })
    .click();
  const viewport = page.getByTestId("pdf-scroll-container");
  const layers = page.locator(".mupdf-text-layer");
  const first = page.locator('[data-page-number="1"] .mupdf-text-layer');
  await expect(first).toBeVisible();
  const nearby = await layers.count();
  expect(nearby).toBeLessThan(count);
  await first.click({ position: { x: 20, y: 20 } });
  // Wait past the deferred text-loading timer: a click must not leave a
  // document-wide request behind after mouseup, even without pressing Escape.
  await page.waitForTimeout(400);
  await expect(layers).toHaveCount(nearby);

  await viewport.focus();
  await page.keyboard.press("ControlOrMeta+a");
  await expect(layers).toHaveCount(count);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("page 30");
  await page.keyboard.press("Escape");
  await expect(layers).toHaveCount(nearby);

  const line = first.locator("text").first();
  const bounds = await line.boundingBox();
  await page.mouse.move(bounds!.x + 2, bounds!.y + bounds!.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 100, bounds!.y + bounds!.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.isCollapsed))
    .toBe(false);
  await expect(layers).toHaveCount(nearby);
  // Keep the selected page through focus loss and virtualization of its neighbors.
  await page.getByRole("textbox", { name: "Zoom percentage" }).focus();
  await page
    .locator('[data-page-number="30"]')
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect(first).toHaveCount(1);
  await expect.poll(() => layers.count()).toBeLessThan(count);
  await viewport.focus();
  await page.keyboard.press("Escape");
  await expect(first).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("text-virtualization-restored.png"),
  });
});

for (const [count, images] of [
  [30, true],
  [100, false],
] as const) {
  test(`${count} PDF pages bound canvas pixels and restore an evicted page exactly`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const pdf = fixture(count, images);
    await page.route("**/examples/paper-standard/main.pdf", (route) =>
      route.fulfill({ contentType: "application/pdf", body: pdf }),
    );
    await page.goto("/?debug=pdf-comments");
    await expect(page.locator(".mupdf-page")).toHaveCount(count);
    const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
    await zoom.fill("125%");
    await zoom.press("Enter");
    await expect(zoom).toHaveValue("125%");
    // Let the viewer's 180ms size transition finish before measuring its pixels.
    await page.waitForTimeout(250);
    const first = page.locator('[data-page-number="1"] canvas');
    await expect
      .poll(() => first.evaluate((c: HTMLCanvasElement) => c.width))
      .toBeGreaterThan(1000);
    const pixels = () =>
      first.evaluate((c: HTMLCanvasElement) => c.toDataURL());
    await expect
      .poll(async () => (await pixels()).length)
      .toBeGreaterThan(10000);
    const original = await pixels();
    const size = await first.evaluate((c: HTMLCanvasElement) => ({
      width: c.width,
      height: c.height,
    }));
    const metrics = () =>
      page.evaluate(() => {
        const cs = [
          ...document.querySelectorAll<HTMLCanvasElement>(".mupdf-page canvas"),
        ];
        return {
          allocated: cs.filter((c) => c.width > 0).length,
          bytes: cs.reduce((s, c) => s + c.width * c.height * 4, 0),
        };
      });
    for (let n = 2; n <= count; n++) {
      const target = page.locator(`[data-page-number="${n}"]`);
      await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await expect
        .poll(() =>
          target.locator("canvas").evaluate((c: HTMLCanvasElement) => c.width),
        )
        .toBe(size.width);
    }
    await expect
      .poll(async () => (await metrics()).bytes)
      .toBeLessThanOrEqual(128 * 1024 * 1024);
    await expect
      .poll(() => first.evaluate((c: HTMLCanvasElement) => c.width))
      .toBe(0);
    const afterScroll = await metrics();
    // Pixel eviction must leave every page's layout available for ordinary navigation.
    await expect(page.locator(".mupdf-page")).toHaveCount(count);
    await first.evaluate((el) =>
      el.closest(".mupdf-page")!.scrollIntoView({ block: "center" }),
    );
    await expect.poll(pixels).toBe(original);
    await expect(
      page.locator('[data-page-number="1"] .mupdf-text-layer'),
    ).toContainText("Canvas memory test page 1");
    // Simulate lost backing pixels while this recently visited page is offscreen.
    await page
      .locator('[data-page-number="4"]')
      .evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(
      page.locator('[data-page-number="1"] .mupdf-text-layer'),
    ).toHaveCount(0);
    await first.evaluate((c: HTMLCanvasElement) => {
      if (!c.width) throw new Error("Expected page 1 to remain cached");
      c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
      window.dispatchEvent(new Event("app-visibility-restored"));
    });
    await first.evaluate((el) =>
      el.closest(".mupdf-page")!.scrollIntoView({ block: "center" }),
    );
    await expect.poll(pixels).toBe(original);
    await page.screenshot({
      path: test.info().outputPath("returned-page.png"),
    });
    await test.info().attach("canvas-memory", {
      body: JSON.stringify({
        pages: count,
        imagePages: images,
        afterScroll,
        allPagesRgbaBytes: count * size.width * size.height * 4,
      }),
      contentType: "application/json",
    });
  });
}
