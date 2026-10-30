import { expect, test } from "@playwright/test";
import * as mupdf from "mupdf";

function fixture() {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addSimpleFont(font);
  try {
    for (let n = 1; n <= 2; n++) {
      const content: string[] = [];
      for (let y = 20; y < 780; y += 12) {
        content.push(`0.15 0.35 0.7 RG 0.15 w 15 ${y - 2} m 590 ${y - 2} l S`);
        for (let x = 20; x < 570; x += 65)
          content.push(
            `BT /F1 4 Tf ${x} ${y} Td (Page ${n} - ${x},${y}) Tj ET`,
          );
      }
      const object = doc.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: fontRef } },
        content.join("\n"),
      );
      doc.insertPage(-1, object);
      object.destroy();
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

test.use({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
test("high zoom details track the viewport, preserve selection, and release offscreen pixels", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  const pdf = fixture();
  await page.route("**/examples/paper-standard/main.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdf }),
  );
  await page.goto("/?debug=pdf-comments");
  const papers = page.locator(".mupdf-page");
  await expect(papers).toHaveCount(2);
  const first = papers.first();
  await expect(first.locator(".mupdf-text-layer")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Zoom percentage" });
  await input.fill("1200");
  await input.press("Enter");
  await first.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  const viewport = page.getByTestId("pdf-scroll-container").first();
  const base = first.locator<HTMLCanvasElement>("[data-pdf-page-canvas]");
  const detail = first.locator<HTMLCanvasElement>("[data-pdf-detail-canvas]");
  await viewport.evaluate((element) =>
    element.scrollTo({ left: 1200, top: 1400 }),
  );
  await expect(detail).toHaveAttribute("data-pdf-rendered-scale", "24");
  const baseSize = await base.evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  expect(baseSize.width * baseSize.height).toBeLessThan(8_500_000);
  async function coversViewport() {
    return detail.evaluate((canvas) => {
      const paper = canvas.parentElement!.getBoundingClientRect();
      const viewport = canvas.closest<HTMLElement>(
        '[data-testid="pdf-scroll-container"]',
      )!;
      const frame = viewport.getBoundingClientRect();
      const bounds = canvas.getBoundingClientRect();
      return (
        bounds.left <= Math.max(paper.left, frame.left) + 1 &&
        bounds.top <= Math.max(paper.top, frame.top) + 1 &&
        bounds.right >=
          Math.min(paper.right, frame.left + viewport.clientWidth) - 1 &&
        bounds.bottom >=
          Math.min(paper.bottom, frame.top + viewport.clientHeight) - 1
      );
    });
  }
  await expect.poll(coversViewport).toBe(true);
  const initial = await detail.evaluate((canvas) => ({
    left: canvas.style.left,
    top: canvas.style.top,
  }));
  await viewport.evaluate((element) => element.scrollBy({ left: 20, top: 20 }));
  await page.waitForTimeout(200);
  expect(
    await detail.evaluate((canvas) => ({
      left: canvas.style.left,
      top: canvas.style.top,
    })),
  ).toEqual(initial);
  await viewport.screenshot({
    path: testInfo.outputPath("sharp-1200-percent.png"),
  });
  await viewport.evaluate((element) =>
    element.scrollBy({ left: 1600, top: 900 }),
  );
  await expect.poll(coversViewport).toBe(true);
  expect(
    await base.evaluate((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    })),
  ).toEqual(baseSize);
  const metrics = await detail.evaluate((canvas) => ({
    pixels: canvas.width * canvas.height,
    side: Math.max(canvas.width, canvas.height),
    ratio: canvas.width / canvas.getBoundingClientRect().width,
    pointerEvents: getComputedStyle(canvas).pointerEvents,
  }));
  expect(metrics.pixels).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(metrics.side).toBeLessThanOrEqual(8192);
  expect(metrics.ratio).toBeCloseTo(2, 2);
  expect(metrics.pointerEvents).toBe("none");
  // The detail canvas must not intercept the SVG text selection layer.
  const selected = await first.evaluate((element) => {
    const viewport = element
      .closest<HTMLElement>('[data-testid="pdf-scroll-container"]')!
      .getBoundingClientRect();
    const line = [
      ...element.querySelectorAll<SVGTextElement>(".mupdf-text-layer text"),
    ].find((text) => {
      const b = text.getBoundingClientRect();
      return (
        b.right > viewport.left + 10 &&
        b.left < viewport.right - 10 &&
        b.top > viewport.top + 5 &&
        b.bottom < viewport.bottom - 5
      );
    })!;
    const bounds = line.getBoundingClientRect();
    const target = document.elementFromPoint(
      (Math.max(bounds.left, viewport.left) +
        Math.min(bounds.right, viewport.right)) /
        2,
      bounds.top + bounds.height / 2,
    );
    const range = document.createRange();
    range.selectNodeContents(line);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      text: selection.toString(),
      hitText: Boolean(target?.closest(".mupdf-text-layer")),
    };
  });
  expect(selected.text).toContain("Page 1");
  expect(selected.hitText).toBe(true);
  await viewport.screenshot({
    path: testInfo.outputPath("panned-1200-percent.png"),
  });
  await papers
    .nth(1)
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect.poll(() => detail.evaluate((canvas) => canvas.width)).toBe(0);
  const secondDetail = papers
    .nth(1)
    .locator<HTMLCanvasElement>("[data-pdf-detail-canvas]");
  await expect(secondDetail).toHaveAttribute("data-pdf-rendered-scale", "24");
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await expect(page.locator("[data-pdf-detail-canvas]")).toHaveCount(0);
  await expect(papers.nth(1).locator(".mupdf-text-layer")).toBeVisible();
});

test("details recover after panel resizing and pinch zoom settles", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=comment-workspace&pdf");
  const first = page.locator(".mupdf-page").first();
  await expect(first.locator(".mupdf-text-layer")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Zoom percentage" });
  await input.fill("1200");
  await input.press("Enter");
  const detail = first.locator("[data-pdf-detail-canvas]");
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  const scroller = page.getByTestId("pdf-scroll-container");
  for (const name of ["PDF", "Split"]) {
    await modes.getByRole("tab", { name, exact: true }).click();
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await expect(input).toHaveValue("1200%");
    await expect(detail).toHaveAttribute("data-pdf-rendered-scale", "24");
    expect(
      await detail.evaluate(
        (canvas: HTMLCanvasElement) => canvas.width * canvas.height,
      ),
    ).toBeLessThanOrEqual(8 * 1024 * 1024);
  }
  await scroller.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    element.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: 20,
        clientX: bounds.left + 100,
        clientY: bounds.top + 100,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).not.toHaveValue("1200%");
  await expect(detail).toHaveAttribute("data-pdf-rendered-scale", /.+/);
  await scroller.evaluate((element) => {
    const line = element
      .querySelector(".mupdf-text-layer text")!
      .getBoundingClientRect();
    const frame = element.getBoundingClientRect();
    element.scrollBy(line.left - frame.left - 30, line.top - frame.top - 30);
  });
  await expect
    .poll(() =>
      detail.evaluate((canvas: HTMLCanvasElement) => {
        const bounds = canvas.getBoundingClientRect();
        const line = canvas
          .parentElement!.querySelector(".mupdf-text-layer text")!
          .getBoundingClientRect();
        const frame = canvas
          .closest('[data-testid="pdf-scroll-container"]')!
          .getBoundingClientRect();
        return (
          bounds.left <= Math.max(line.left, frame.left) &&
          bounds.top <= line.top &&
          bounds.right >= Math.min(line.right, frame.right)
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("detail-after-layout-and-pinch.png"),
  });
});
