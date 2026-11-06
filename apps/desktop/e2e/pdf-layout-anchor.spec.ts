import { expect, test, type Locator } from "@playwright/test";

function recordMotion(scroller: Locator) {
  return scroller.evaluate(
    (el) =>
      new Promise<
        {
          width: number;
          viewport: number;
          gutter: number;
          moving: boolean;
          fade: boolean;
        }[]
      >((resolve) => {
        const samples: {
          width: number;
          viewport: number;
          gutter: number;
          moving: boolean;
          fade: boolean;
        }[] = [];
        const start = performance.now();
        const sample = () => {
          samples.push({
            viewport: el.clientWidth,
            gutter:
              Number.parseFloat(
                getComputedStyle(el.querySelector("[data-pdf-scroll-content]")!)
                  .paddingLeft,
              ) +
              Number.parseFloat(
                getComputedStyle(el.querySelector("[data-pdf-scroll-content]")!)
                  .paddingRight,
              ),
            moving:
              document
                .querySelector("[data-workspace-layout-animating]")
                ?.getAttribute("data-workspace-layout-animating") === "true",
            width: el.querySelector(".mupdf-page")!.getBoundingClientRect()
              .width,
            fade: Boolean(
              el.parentElement!.querySelector("[data-pdf-fit-crossfade]"),
            ),
          });
          if (performance.now() - start < 900)
            requestAnimationFrame(() => setTimeout(sample, 0));
          else resolve(samples);
        };
        sample();
      }),
  );
}

test("Duet preserves the PDF center through split and preview-only resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const scroller = page.getByTestId("pdf-scroll-container");
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight * 0.55;
  });
  await page.waitForTimeout(700);
  const point = () =>
    scroller.evaluate((el) => {
      const viewport = el.getBoundingClientRect();
      const y = viewport.top + el.clientHeight / 2;
      const page = Array.from(
        el.querySelectorAll<HTMLElement>(".mupdf-page"),
      ).find((page) => {
        const r = page.getBoundingClientRect();
        return r.top <= y && r.bottom >= y;
      })!;
      const rect = page.getBoundingClientRect();
      return {
        page: page.dataset.pageNumber,
        y: (y - rect.top) / rect.height,
        width: rect.width,
      };
    });
  const initial = await point();
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  for (const name of ["PDF", "Split", "PDF", "Split"]) {
    const widths = recordMotion(scroller);
    await modes.getByRole("tab", { name, exact: true }).click();
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await page.waitForTimeout(500);
    const samples = await widths;
    const min = Math.min(...samples.map((sample) => sample.width));
    const max = Math.max(...samples.map((sample) => sample.width));
    expect(
      new Set(
        samples
          .filter(({ width }) => width > min + 1 && width < max - 1)
          .map(({ width }) => Math.round(width)),
      ).size,
    ).toBeGreaterThan(3);
    expect(samples.some((sample) => sample.fade)).toBe(false);
    await expect(page.locator("[data-pdf-fit-crossfade]")).toHaveCount(0);
    const after = await point();
    expect(after.page).toBe(initial.page);
    expect(Math.abs(after.y - initial.y)).toBeLessThan(0.025);
    if (name === "PDF")
      expect(after.width).toBeGreaterThan(initial.width * 1.5);
  }
  await page.screenshot({
    path: test.info().outputPath("pdf-layout-anchor.png"),
  });
});

test("fit buttons keep their zoom animation and manual scale does not crossfade on layout changes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const scroller = page.getByTestId("pdf-scroll-container");
  await expect(scroller.locator(".mupdf-text-layer").first()).toBeVisible();
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  await modes.getByRole("tab", { name: "PDF", exact: true }).click();
  await page.waitForTimeout(650);
  for (const name of ["Fit height", "Fit width"]) {
    const motion = recordMotion(scroller);
    await page.getByRole("button", { name, exact: true }).click();
    const samples = await motion;
    const min = Math.min(...samples.map(({ width }) => width));
    const max = Math.max(...samples.map(({ width }) => width));
    expect(
      new Set(
        samples
          .filter(({ width }) => width > min + 1 && width < max - 1)
          .map(({ width }) => Math.round(width)),
      ).size,
    ).toBeGreaterThan(3);
    expect(samples.some(({ fade }) => fade)).toBe(false);
  }
  const input = page.getByRole("textbox", { name: "Zoom percentage" });
  await input.fill("125%");
  await input.press("Enter");
  await page.waitForTimeout(250);
  const motion = recordMotion(scroller);
  await modes.getByRole("tab", { name: "Split", exact: true }).click();
  const samples = await motion;
  expect(
    Math.max(...samples.map(({ width }) => width)) -
      Math.min(...samples.map(({ width }) => width)),
  ).toBeLessThan(1);
  expect(samples.some(({ fade }) => fade)).toBe(false);
  await expect(input).toHaveValue("125%");
});

test("a closing PDF keeps its zoom and reopening starts at the destination zoom", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await page.waitForTimeout(600);
  const modes = page.getByRole("tablist", { name: "Chat workspace content" });
  const scroller = page.getByTestId("pdf-scroll-container");
  const initial = await scroller
    .locator(".mupdf-page")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  const closing = recordMotion(scroller);
  await modes.getByRole("tab", { name: "Editor", exact: true }).click();
  const closed = await closing;
  expect(
    Math.max(...closed.map((frame) => frame.width)) -
      Math.min(...closed.map((frame) => frame.width)),
  ).toBeLessThan(1);
  // Reopen into a different destination size, rather than reusing the old zoom.
  await page.setViewportSize({ width: 1200, height: 900 });
  const opening = recordMotion(scroller);
  await modes.getByRole("tab", { name: "PDF", exact: true }).click();
  const opened = await opening;
  const visibleOpening = opened.filter(
    (frame) => frame.moving && frame.viewport > 10,
  );
  expect(visibleOpening.length).toBeGreaterThan(3);
  expect(
    Math.max(...visibleOpening.map((frame) => frame.width)) -
      Math.min(...visibleOpening.map((frame) => frame.width)),
  ).toBeLessThan(1);
  const final = opened.at(-1)!;
  expect(Math.abs(final.width - (final.viewport - final.gutter))).toBeLessThan(
    1,
  );
  expect(final.width).toBeLessThan(initial - 50);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect(page.locator("[data-pdf-fit-crossfade]")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("pdf-fit-after-chat-layout.png"),
  });
});

test("fit controls and rapid panel switches leave no visual effects", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  await modes.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "true");
  await page.getByRole("button", { name: "Fit height", exact: true }).click();
  await expect(page.locator("[data-pdf-fit-crossfade]")).toHaveCount(0);
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  for (const name of ["Split", "PDF", "Split", "PDF"])
    await modes.getByRole("tab", { name, exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect(page.locator("[data-pdf-fit-crossfade]")).toHaveCount(0);
  await expect(page.locator("[data-pdf-fit-concealed]")).toHaveCount(0);
  await expect(page.locator("[data-pdf-scroll-content]")).toHaveCSS(
    "filter",
    "none",
  );
  await expect(page.locator("[data-pdf-scroll-content]")).toHaveCSS(
    "opacity",
    "1",
  );
});

test("reduced motion still fits the final panel without visual effects", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.goto("/?debug=comment-workspace&pdf");
  const scroller = page.getByTestId("pdf-scroll-container");
  await expect(scroller.locator(".mupdf-text-layer").first()).toBeVisible();
  const motion = recordMotion(scroller);
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "PDF", exact: true })
    .click();
  expect((await motion).some(({ fade }) => fade)).toBe(false);
  await expect(page.locator("[data-pdf-fit-concealed]")).toHaveCount(0);
  const fitError = await scroller.evaluate((el) => {
    const content = getComputedStyle(
      el.querySelector("[data-pdf-scroll-content]")!,
    );
    return (
      el.clientWidth -
      el.querySelector(".mupdf-page")!.getBoundingClientRect().width -
      Number.parseFloat(content.paddingLeft) -
      Number.parseFloat(content.paddingRight)
    );
  });
  expect(Math.abs(fitError)).toBeLessThan(1);
});
