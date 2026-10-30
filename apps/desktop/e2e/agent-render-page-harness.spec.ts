import { expect, test } from "@playwright/test";

test("an in-turn Catalex page render returns a real image without disturbing the preview", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-preview&sample=paper-standard", {
    waitUntil: "domcontentloaded",
  });

  const shell = page.getByTestId("pdf-preview-harness-shell");
  await expect(shell).toHaveAttribute("data-compile-phase", "succeeded");
  await expect(shell).toHaveAttribute("data-render-phase", "succeeded");

  const agentImage = page.getByTestId("agent-rendered-page");
  await expect(agentImage).toBeVisible();
  const agentImageSize = await agentImage.evaluate((element) => {
    const image = element as HTMLImageElement;
    return { width: image.naturalWidth, height: image.naturalHeight };
  });
  expect(agentImageSize.width).toBeGreaterThan(0);
  expect(agentImageSize.height).toBeGreaterThan(0);

  const previewCanvas = page.locator(".mupdf-page canvas").first();
  await expect(previewCanvas).toBeVisible();
  await expect
    .poll(async () =>
      previewCanvas.evaluate(
        (element) => element.width > 0 && element.height > 0,
      ),
    )
    .toBe(true);

  await page.screenshot({
    path: "test-results/agent-render-page-harness.png",
    fullPage: false,
  });
});
