import { expect, test } from "@playwright/test";
import * as mupdf from "mupdf";

function imageDocument() {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addSimpleFont(font);
  try {
    for (let n = 0; n < 24; n++) {
      const pixmap = new mupdf.Pixmap(
        mupdf.ColorSpace.DeviceRGB,
        [0, 0, 2048, 2048],
        false,
      );
      const pixels = pixmap.getPixels();
      for (let i = 0; i < pixels.length; i++)
        pixels[i] = (i * 17 + n * 31 + (i >> 11)) % 256;
      const image = new mupdf.Image(pixmap);
      const imageRef = doc.addImage(image);
      const object = doc.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: fontRef }, XObject: { Im1: imageRef } },
        `BT /F1 18 Tf 50 740 Td (Image document page ${n + 1}) Tj 0 -25 Td (Synthetic document heading) Tj 0 -25 Td (Your abstract here.) Tj ET\nq 500 0 0 500 50 100 cm /Im1 Do Q`,
      );
      doc.insertPage(-1, object);
      object.destroy();
      imageRef.destroy();
      image.destroy();
      pixmap.destroy();
    }
    const buffer = doc.saveToBuffer("compress");
    try {
      return Buffer.from(buffer.asUint8Array());
    } finally {
      buffer.destroy();
    }
  } finally {
    fontRef.destroy();
    font.destroy();
    doc.destroy();
  }
}

test.use({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

test("image-heavy PDFs render only the settled zoom during repeated controls", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const pdf = imageDocument();
  await page.route("**/examples/paper-standard/main.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdf }),
  );
  await page.goto("/?debug=pdf-comments");
  await expect(page.locator(".mupdf-page")).toHaveCount(24);
  const first = page.locator('[data-page-number="1"]');
  await expect(first.locator(".mupdf-text-layer")).toBeVisible();
  const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("100%");
  await zoom.press("Enter");
  await expect(first.locator("[data-pdf-page-canvas]")).toHaveAttribute(
    "data-pdf-rendered-scale",
    "1",
  );
  await page.waitForTimeout(500);

  const draws = await page.evaluate(async () => {
    const draws: { page: number; dpi: number; moving: boolean }[] = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, options) {
      if (Array.isArray(message) && message[0] === "drawPage") {
        draws.push({
          page: message[2][1],
          dpi: message[2][2],
          moving: [...document.querySelectorAll(".mupdf-page")].some((page) =>
            page.getAnimations().some((a) => a.playState === "running"),
          ),
        });
      }
      return post.call(this, message, options as StructuredSerializeOptions);
    };
    try {
      const button = document.querySelector<HTMLButtonElement>(
        '[aria-label="Zoom in"]',
      )!;
      for (let i = 0; i < 6; i++) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return draws;
    } finally {
      Worker.prototype.postMessage = post;
    }
  });
  await testInfo.attach("zoom-render-jobs", {
    body: JSON.stringify(draws),
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("image-heavy-zoom.png") });
  expect(draws.length).toBeGreaterThan(0);
  expect(new Set(draws.map(({ dpi }) => dpi)).size).toBe(1);
  expect(draws.some(({ moving }) => moving)).toBe(false);
  const finalScale = Number((await zoom.inputValue()).replace("%", "")) / 100;
  await expect
    .poll(async () =>
      Number(
        await first
          .locator("[data-pdf-page-canvas]")
          .getAttribute("data-pdf-rendered-scale"),
      ),
    )
    .toBeCloseTo(finalScale, 5);

  // Reuse the real split-panel animation with the same long image document.
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await page.waitForTimeout(600);
  const visibilityScans = await page.evaluate(async () => {
    let observations = 0;
    const observe = IntersectionObserver.prototype.observe;
    IntersectionObserver.prototype.observe = function (target) {
      if (target.matches(".mupdf-page")) observations++;
      return observe.call(this, target);
    };
    try {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Toggle editor")!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return observations;
    } finally {
      IntersectionObserver.prototype.observe = observe;
    }
  });
  await testInfo.attach("panel-visibility-observations", {
    body: String(visibilityScans),
    contentType: "text/plain",
  });
  expect(visibilityScans).toBeGreaterThanOrEqual(24);
  expect(visibilityScans).toBeLessThanOrEqual(48);
  await page.screenshot({ path: testInfo.outputPath("image-heavy-panel.png") });
});
