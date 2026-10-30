import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1200, height: 750 } });

test("trackpad zoom previews existing pixels and preserves its PDF anchor", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&performance");
  const firstPage = page.locator('[data-page-number="1"]').first();
  await expect(firstPage.locator(".mupdf-text-layer")).toContainText(
    "Your abstract here.",
  );
  await expect
    .poll(() =>
      firstPage
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL().length),
    )
    .toBeGreaterThan(10000);
  const before = await firstPage.evaluate((element) => {
    const container = element.closest(
      '[data-testid="pdf-scroll-container"]',
    ) as HTMLElement;
    container.scrollTop = 150;
    const rect = element.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = Math.max(
      viewport.top + 60,
      Math.min(viewport.bottom - 60, rect.top + rect.height / 2),
    );
    return {
      x,
      y,
      fractionY: (y - rect.top) / rect.height,
      width: rect.width,
      pixels: element.querySelector("canvas")!.width,
    };
  });
  await page.evaluate(async ({ x, y }) => {
    const container = document.querySelector(
      '[data-testid="pdf-scroll-container"]',
    )!;
    for (let i = 0; i < 10; i++) {
      container.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -8,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise(requestAnimationFrame);
    }
  }, before);
  expect(
    await firstPage
      .locator("canvas")
      .evaluate((canvas: HTMLCanvasElement) => canvas.width),
  ).toBe(before.pixels);
  await page.screenshot({ path: test.info().outputPath("pinch-preview.png") });
  await expect
    .poll(() => firstPage.evaluate((el) => el.getBoundingClientRect().width))
    .toBeGreaterThan(before.width * 1.45);
  await expect
    .poll(() =>
      page
        .locator("[data-pdf-scroll-content]")
        .first()
        .evaluate((el) => (el as HTMLElement).style.transform),
    )
    .toBe("");
  const after = await firstPage.evaluate((el, fractionY) => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height * fractionY,
    };
  }, before.fractionY);
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  await expect
    .poll(() =>
      firstPage
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.width),
    )
    .toBeGreaterThan(before.pixels);
  await page.screenshot({ path: test.info().outputPath("pinch-settled.png") });
});

test("repeated zoom in and out preserves a later-page position and ordinary scrolling", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&multipage");
  const target = page.locator('[data-page-number="2"]').first();
  await expect(target).toBeAttached();
  await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await expect
    .poll(() =>
      target
        .locator("canvas")
        .evaluate((canvas: HTMLCanvasElement) => canvas.width),
    )
    .toBeGreaterThan(0);
  // Measure the gesture from the fitted size, not halfway through initial fit.
  await target.evaluate(async (el) => {
    await Promise.all(
      el
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    el.scrollIntoView({ block: "center" });
  });
  for (const delta of [-8, 8, -8, 8]) {
    const anchor = await target.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const container = el.closest('[data-testid="pdf-scroll-container"]')!;
      const bounds = container.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = (bounds.top + bounds.bottom) / 2;
      return {
        x,
        y,
        fraction: (y - rect.top) / rect.height,
        width: rect.width,
      };
    });
    await page.evaluate(
      async ({ anchor, delta }) => {
        const container = document.querySelector(
          '[data-testid="pdf-scroll-container"]',
        )!;
        for (let i = 0; i < 10; i++) {
          container.dispatchEvent(
            new WheelEvent("wheel", {
              ctrlKey: true,
              deltaY: delta,
              clientX: anchor.x,
              clientY: anchor.y,
              bubbles: true,
              cancelable: true,
            }),
          );
          await new Promise(requestAnimationFrame);
        }
      },
      { anchor, delta },
    );
    await expect
      .poll(() =>
        page
          .locator("[data-pdf-scroll-content]")
          .first()
          .evaluate((el) => (el as HTMLElement).style.transform),
      )
      .toBe("");
    const after = await target.evaluate((el, fraction) => {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height * fraction,
        width: rect.width,
      };
    }, anchor.fraction);
    expect(after.width / anchor.width).toBeCloseTo(
      Math.exp(-delta * 10 * 0.005),
      2,
    );
    expect(Math.abs(after.x - anchor.x)).toBeLessThan(2);
    expect(Math.abs(after.y - anchor.y)).toBeLessThan(2);
  }
  const scroller = page.getByTestId("pdf-scroll-container").first();
  const beforeScroll = await scroller.evaluate((el) => el.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 120);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(beforeScroll);
  await page.screenshot({ path: test.info().outputPath("multipage-zoom.png") });
});

test("a fitted page smoothly returns to center after pointer-anchored zoom", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&performance");
  const target = page.locator('[data-page-number="1"]').first();
  await expect(target.locator(".mupdf-text-layer")).toBeVisible();
  const content = page.locator("[data-pdf-scroll-content]").first();
  await target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    el.closest('[data-testid="pdf-scroll-container"]')!.dispatchEvent(
      new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: 60,
        clientX: rect.left + 50,
        clientY: rect.top + 200,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() => content.evaluate((el) => el.getAnimations().length), {
      intervals: [10],
    })
    .toBeGreaterThan(0);
  await content.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  const offset = await target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const container = el.closest('[data-testid="pdf-scroll-container"]')!;
    const bounds = container.getBoundingClientRect();
    return rect.left + rect.width / 2 - bounds.left - container.clientWidth / 2;
  });
  expect(Math.abs(offset)).toBeLessThan(2);
  await page.screenshot({ path: test.info().outputPath("center-settle.png") });
});
