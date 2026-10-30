import { expect, test } from "@playwright/test";

test("editor scroll harness reproduces scrollbar drag selection behavior", async ({
  page,
}) => {
  await page.goto("/?debug=editor-scroll", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-scroll-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    const win = window as Window & {
      __editorScrollHarness?: { ready?: boolean };
    };
    return !!win.__editorScrollHarness?.ready;
  });

  const scroller = page.locator(".cm-scroller");
  await expect(scroller).toBeVisible();

  const scrollerBox = await scroller.boundingBox();
  if (!scrollerBox) throw new Error("Scroller bounding box not available");

  await page.mouse.click(scrollerBox.x + 180, scrollerBox.y + 120);
  await page.waitForTimeout(100);

  await page.mouse.move(
    scrollerBox.x + scrollerBox.width - 3,
    scrollerBox.y + 120,
  );
  await page.mouse.down();
  await page.mouse.move(
    scrollerBox.x + scrollerBox.width - 3,
    scrollerBox.y + 480,
    {
      steps: 12,
    },
  );
  await page.mouse.up();
  await page.waitForTimeout(120);

  await page.mouse.click(scrollerBox.x + 220, scrollerBox.y + 280);
  await page.waitForTimeout(120);

  const state = await page.evaluate(() => {
    const win = window as Window & {
      __editorScrollHarness?: { getState: () => unknown };
    };
    return win.__editorScrollHarness?.getState() ?? null;
  });

  console.log(JSON.stringify(state, null, 2));

  await page.screenshot({
    path: "test-results/editor-scroll-harness.png",
    fullPage: true,
  });
});
