import { expect, test, type Page } from "@playwright/test";

test.use({ viewport: { width: 1600, height: 1000 } });

async function renderedPage(page: Page) {
  return page.locator('[data-page-number="1"]').evaluate((element) => {
    const canvas = element.querySelector("canvas")!;
    return {
      pixels: canvas.toDataURL(),
      text: element.querySelector(".mupdf-text-layer")?.textContent,
      width: canvas.width,
      height: canvas.height,
    };
  });
}

async function currentDocumentId(page: Page) {
  return page.evaluate(async () => {
    // Vite may already have hot-reloaded these singletons. Use the modules
    // loaded by the application, including their current revision query.
    const moduleUrl = (path: string) => {
      const url = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .find((url) => new URL(url).pathname === path);
      if (!url) throw new Error(`App module not loaded: ${path}`);
      return url;
    };
    const { getOrOpenDocument } = await import(
      moduleUrl("/src/renderer/lib/mupdf/pdf-doc-cache.ts")
    );
    const { getCurrentPdfBytes } = await import(
      moduleUrl("/src/renderer/stores/document-store.ts")
    );
    return (await getOrOpenDocument(getCurrentPdfBytes()!)).docId;
  });
}

test("PDF refresh retains one worker and identical page pixels and text", async ({
  page,
}) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto("/?debug=pdf-comments&performance");
  await expect(
    page.locator('[data-page-number="1"] .mupdf-text-layer'),
  ).toContainText("Your abstract here.");
  await expect
    .poll(async () => (await renderedPage(page)).width)
    .toBeGreaterThan(0);
  // Wait for the asynchronous bitmap upload, not just canvas allocation.
  await expect
    .poll(async () => (await renderedPage(page)).pixels.length)
    .toBeGreaterThan(10_000);
  const before = await renderedPage(page);
  const initialWorkers = workers.length;
  expect(initialWorkers).toBeGreaterThan(0);
  for (let i = 0; i < 8; i++) {
    // The cache ID must change, establishing that this really opened a new PDF.
    const previous = await currentDocumentId(page);
    await page.getByRole("button", { name: "Refresh fixture PDF" }).click();
    await expect.poll(() => currentDocumentId(page)).toBeGreaterThan(previous);
    await expect.poll(() => renderedPage(page)).toEqual(before);
  }
  expect(workers).toHaveLength(initialWorkers);
  await page.screenshot({ path: test.info().outputPath("reused-worker.png") });
});

test("worker replacement discards page state even when document IDs repeat", async ({
  page,
}) => {
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto("/?debug=pdf-comments&performance");
  await expect(
    page.locator('[data-page-number="1"] .mupdf-text-layer'),
  ).toContainText("Your abstract here.");
  await expect
    .poll(async () => (await renderedPage(page)).pixels.length)
    .toBeGreaterThan(10_000);
  const before = await renderedPage(page);
  const workerCount = workers.length;
  await page
    .locator('[data-page-number="1"]')
    .evaluate((el) => el.setAttribute("data-old-worker", "true"));
  await page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find(
        (url) =>
          new URL(url).pathname === "/src/renderer/lib/mupdf/mupdf-client.ts",
      )!;
    const { resetMupdfClient } = await import(moduleUrl);
    resetMupdfClient();
  });
  await page.getByRole("button", { name: "Refresh fixture PDF" }).click();
  await expect(page.locator("[data-old-worker]")).toHaveCount(0);
  await expect.poll(() => renderedPage(page)).toEqual(before);
  expect(workers).toHaveLength(workerCount + 1);
});
