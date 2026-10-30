import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page, query: string) {
  await page.goto(`/?debug=latex-scroll-sync&${query}`);
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".mupdf-page")).toHaveCount(8);
  await expect(page.getByTestId("synctex-map-calls")).toHaveText("1");
  await page.waitForTimeout(650);
}

// Keep sending input past the old debounce interval. The follower must move
// during this stream, rather than only after the final event.
async function stream(
  page: Page,
  driver: "editor" | "pdf",
  delta = 45,
  minimumPositions = 5,
) {
  const leader =
    driver === "editor"
      ? page.locator(".cm-scroller")
      : page.getByTestId("pdf-scroll-container");
  await leader.hover();
  await page.evaluate((driver) => {
    const follower = document.querySelector<HTMLElement>(
      driver === "editor"
        ? '[data-testid="pdf-scroll-container"]'
        : ".cm-scroller",
    )!;
    const start = performance.now();
    const frames: { time: number; top: number }[] = [];
    (window as any).syncFrames = frames;
    (window as any).syncFrameStart = follower.scrollTop;
    const sample = () => {
      frames.push({ time: performance.now() - start, top: follower.scrollTop });
      if (performance.now() - start < 1100) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, driver);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(16);
  }
  const motion = await page.evaluate(() => ({
    frames: (window as any).syncFrames as { time: number; top: number }[],
    start: (window as any).syncFrameStart as number,
  }));
  expect(
    motion.frames.filter(
      (frame) => frame.time < 600 && Math.abs(frame.top - motion.start) > 20,
    ).length,
  ).toBeGreaterThan(3);
  expect(
    new Set(
      motion.frames
        .filter((frame) => frame.time < 600)
        .map((frame) => Math.round(frame.top)),
    ).size,
  ).toBeGreaterThan(minimumPositions);
}

test("cached mapping follows continuous scrolling in both directions without native work per frame", async ({
  page,
}) => {
  await ready(page, "cached-map");
  const viewBefore = Number(
    await page.getByTestId("synctex-view-calls").textContent(),
  );
  await stream(page, "editor");
  const viewAfter = Number(
    await page.getByTestId("synctex-view-calls").textContent(),
  );
  expect(viewAfter - viewBefore).toBeLessThanOrEqual(1);
  await page.waitForTimeout(350);
  const editBefore = Number(
    await page.getByTestId("synctex-edit-calls").textContent(),
  );
  await stream(page, "pdf");
  expect(
    Number(await page.getByTestId("synctex-edit-calls").textContent()) -
      editBefore,
  ).toBeLessThanOrEqual(1);
  await page.waitForTimeout(350);
  await expect(page.getByTestId("latex-editor-cursor")).toHaveText("0");
  await expect(page.getByTestId("synctex-map-calls")).toHaveText("1");
  await page.screenshot({
    path: test.info().outputPath("continuous-sync.png"),
  });
  await page.getByTestId("simulate-latex-recompile").click();
  await expect(page.getByTestId("synctex-map-calls")).toHaveText("2");
});

test("missing maps use bounded serialized native lookups during continuous input", async ({
  page,
}) => {
  await ready(page, "slow-native");
  await stream(page, "editor", 45, 1);
  await page.waitForTimeout(400);
  await stream(page, "pdf", 45, 1);
  await page.waitForTimeout(400);
  const shell = page.getByTestId("latex-scroll-sync-harness-shell");
  await expect(shell).toHaveAttribute("data-native-concurrency", "1");
  expect(
    Number(await page.getByTestId("synctex-view-calls").textContent()),
  ).toBeLessThan(13);
  expect(
    Number(await page.getByTestId("synctex-edit-calls").textContent()),
  ).toBeLessThan(13);
  await page
    .getByRole("button", { name: "Disable synchronized scrolling" })
    .click();
  const top = await page
    .getByTestId("pdf-scroll-container")
    .evaluate((e) => e.scrollTop);
  await page.locator(".cm-scroller").hover();
  await page.mouse.wheel(0, 1000);
  await page.waitForTimeout(350);
  expect(
    await page.getByTestId("pdf-scroll-container").evaluate((e) => e.scrollTop),
  ).toBe(top);
});

test("changing the scroll driver discards old results and shares one native request budget", async ({
  page,
}) => {
  await ready(page, "slow-native");
  const view = page.getByTestId("synctex-view-calls");
  const before = Number(await view.textContent());
  await page.locator(".cm-scroller").hover();
  await page.mouse.wheel(0, 1800);
  await expect
    .poll(async () => Number(await view.textContent()))
    .toBeGreaterThan(before);
  const pdf = page.getByTestId("pdf-scroll-container");
  await pdf.hover();
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(35);
  const target = await pdf.evaluate((e) => e.scrollTop);
  await page.waitForTimeout(550);
  expect(await pdf.evaluate((e) => e.scrollTop)).toBeCloseTo(target, 0);
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-native-concurrency", "1");
  await page.locator(".cm-scroller").hover();
  const next = Number(await view.textContent());
  await page.mouse.wheel(0, 900);
  await expect
    .poll(async () => Number(await view.textContent()))
    .toBeGreaterThan(next);
  await page
    .getByRole("button", { name: "Disable synchronized scrolling" })
    .click();
  const disabled = await pdf.evaluate((e) => e.scrollTop);
  await page.waitForTimeout(350);
  expect(await pdf.evaluate((e) => e.scrollTop)).toBe(disabled);
});

for (const driver of ["editor", "pdf"] as const) {
  test(`cached ${driver}-led scrolling stays still after the wheel stops`, async ({
    page,
  }) => {
    await ready(page, "cached-map");
    const nativeCalls = page.getByTestId(
      driver === "editor" ? "synctex-view-calls" : "synctex-edit-calls",
    );
    const before = await nativeCalls.textContent();
    await stream(page, driver);
    // Allow the final wheel frame to propagate, then observe across the old
    // 140 ms native-correction boundary. Neither axis may jump at idle.
    await page.waitForTimeout(60);
    const frames = await page.evaluate(async (driver) => {
      const follower = document.querySelector<HTMLElement>(
        driver === "editor"
          ? '[data-testid="pdf-scroll-container"]'
          : ".cm-scroller",
      )!;
      const samples: { top: number; left: number }[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          samples.push({ top: follower.scrollTop, left: follower.scrollLeft });
          if (performance.now() - start < 600) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    }, driver);
    for (const axis of ["top", "left"] as const) {
      const positions = frames.map((frame) => frame[axis]);
      expect(
        Math.max(...positions) - Math.min(...positions),
      ).toBeLessThanOrEqual(1);
    }
    await expect(nativeCalls).toHaveText(before!);
    await page.screenshot({
      path: test.info().outputPath(`idle-${driver}-stable.png`),
    });
  });
}
