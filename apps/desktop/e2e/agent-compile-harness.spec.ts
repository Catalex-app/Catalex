import { expect, test } from "@playwright/test";

test("an in-turn Catalex verification compile renders in the PDF preview", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-preview&sample=paper-standard", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("pdf-preview-harness-shell");
  await expect(shell).toHaveAttribute("data-compile-phase", "succeeded");

  const firstPage = page.locator(".mupdf-page").first();
  await expect(firstPage).toBeVisible();
  const canvas = firstPage.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () =>
      canvas.evaluate((element) => element.width > 0 && element.height > 0),
    )
    .toBe(true);

  const size = await canvas.evaluate((element) => ({
    width: element.width,
    height: element.height,
  }));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);

  await expect
    .poll(async () =>
      canvas.evaluate((element) => {
        const renderedCanvas = element as HTMLCanvasElement;
        const context = renderedCanvas.getContext("2d");
        if (!context) return false;

        const pixels = context.getImageData(
          0,
          0,
          renderedCanvas.width,
          renderedCanvas.height,
        ).data;
        for (let index = 0; index < pixels.length; index += 4) {
          const isOpaque = pixels[index + 3] > 0;
          const isInk =
            pixels[index] < 245 ||
            pixels[index + 1] < 245 ||
            pixels[index + 2] < 245;
          if (isOpaque && isInk) return true;
        }
        return false;
      }),
    )
    .toBe(true);

  await page.screenshot({
    path: "test-results/agent-compile-harness.png",
    fullPage: false,
  });
});

test("a merge choice schedules one debounced PDF recompile", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-preview&sample=paper-standard", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("pdf-preview-harness-shell");
  await expect(shell).toHaveAttribute("data-compile-phase", "succeeded");
  await page.waitForFunction(() => !!window.__pdfPreviewHarness);

  const initialCompileCount = await page.evaluate(
    () => window.__pdfPreviewHarness?.getCompileRequestCount() ?? 0,
  );
  await page.evaluate(() => {
    window.__pdfPreviewHarness?.requestMergePreviewRefresh();
    window.__pdfPreviewHarness?.requestMergePreviewRefresh();
  });

  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__pdfPreviewHarness?.getCompileRequestCount() ?? 0,
        ),
      { timeout: 5_000 },
    )
    .toBe(initialCompileCount + 1);

  await page.waitForFunction(
    () => window.__pdfPreviewHarness?.isCompiling() === false,
  );
  await page.evaluate(() => {
    window.__pdfPreviewHarness?.setCompileDelay(2_500);
    window.__pdfPreviewHarness?.setSourceContent("Incoming merge choice");
    window.__pdfPreviewHarness?.requestMergePreviewRefresh();
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__pdfPreviewHarness?.getCompileRequestCount() ?? 0,
        ),
      { timeout: 5_000 },
    )
    .toBe(initialCompileCount + 2);

  await page.evaluate(() => {
    window.__pdfPreviewHarness?.setSourceContent("Current merge choice");
    window.__pdfPreviewHarness?.requestMergePreviewRefresh();
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () => window.__pdfPreviewHarness?.getCompileRequestCount() ?? 0,
        ),
      { timeout: 7_000 },
    )
    .toBe(initialCompileCount + 3);

  const compiledContents = await page.evaluate(
    () => window.__pdfPreviewHarness?.getCompileRequestContents() ?? [],
  );
  expect(compiledContents.slice(-2)).toEqual([
    "Incoming merge choice",
    "Current merge choice",
  ]);
});
