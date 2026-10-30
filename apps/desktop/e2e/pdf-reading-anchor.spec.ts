import { expect, test, type Page } from "@playwright/test";

type AnchorProbeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __anchorCalls: { view: number; edit: number };
};

async function settle(page: Page) {
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await page.waitForTimeout(650);
}

async function prepare(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const layer = page.locator(".mupdf-text-layer").first();
  await expect(layer).toBeVisible();
  const size = await layer.evaluate((element) => {
    const box = (element as SVGSVGElement).viewBox.baseVal;
    return { width: box.width, height: box.height };
  });
  await settle(page);
  await page.evaluate(({ width }) => {
    const win = window as AnchorProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__anchorCalls = { view: 0, edit: 0 };
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_view") {
        win.__anchorCalls.view++;
        return { page: 3, x: width / 2, y: 350 };
      }
      if (cmd === "synctex_edit") {
        win.__anchorCalls.edit++;
        return { file: "sample.tex", line: 90, column: 1 };
      }
      return invoke(cmd, args);
    };
  }, size);
  return size;
}

async function readingPoint(page: Page, height: number) {
  return page
    .getByTestId("pdf-scroll-container")
    .evaluate((container, height) => {
      const center =
        container.getBoundingClientRect().top + container.clientHeight / 2;
      const pages = [...container.querySelectorAll<HTMLElement>(".mupdf-page")];
      const distance = (page: HTMLElement) => {
        const rect = page.getBoundingClientRect();
        return Math.max(rect.top - center, center - rect.bottom, 0);
      };
      const paper = pages.reduce((best, next) =>
        distance(next) < distance(best) ? next : best,
      );
      const rect = paper.getBoundingClientRect();
      return {
        page: Number(paper.dataset.pageNumber),
        y: ((center - rect.top) / rect.height) * height,
      };
    }, height);
}

async function pointY(page: Page, height: number, number: number) {
  return page.getByTestId("pdf-scroll-container").evaluate(
    (container, { height, number }) => {
      const rect = container
        .querySelector<HTMLElement>(`[data-page-number="${number}"]`)!
        .getBoundingClientRect();
      return (
        ((container.getBoundingClientRect().top +
          container.clientHeight / 2 -
          rect.top) /
          rect.height) *
        height
      );
    },
    { height, number },
  );
}

for (const sync of [true, false]) {
  test(`resizing preserves the shared PDF reading point with sync ${sync ? "on" : "off"}`, async ({
    page,
  }) => {
    const size = await prepare(page);
    const editor = page.locator(".cm-scroller");
    const pdf = page.getByTestId("pdf-scroll-container");
    if (!sync) {
      await page.evaluate(async () => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const { useSettingsStore } = await import(
          "/src/renderer/stores/settings-store.ts"
        );
        const state = useDocumentStore.getState();
        useSettingsStore
          .getState()
          .setFileScrollSync(state.projectRoot!, state.activeFileId, false);
      });
      await pdf.evaluate((container, height) => {
        const paper = container
          .querySelector<HTMLElement>('[data-page-number="3"]')!
          .getBoundingClientRect();
        container.scrollTop +=
          paper.top -
          container.getBoundingClientRect().top +
          (350 / height) * paper.height -
          container.clientHeight / 2;
      }, size.height);
    }
    const pdfBefore = await pdf.evaluate((element) => element.scrollTop);
    await editor.evaluate((element) => {
      element.scrollTop = 900;
    });
    if (sync) {
      // A cached map can align without a native lookup. Observe the reading
      // position itself, including the absence of a trailing idle correction.
      await expect
        .poll(() => pdf.evaluate((element) => element.scrollTop))
        .not.toBe(pdfBefore);
    }
    await page.waitForTimeout(650);
    const expected = await readingPoint(page, size.height);
    if (!sync) {
      expect(expected.page).toBe(3);
      expect(Math.abs(expected.y - 350)).toBeLessThan(2);
    }
    const before = await page.evaluate(() => ({
      ...(window as AnchorProbeWindow).__anchorCalls,
    }));
    const modes = page.getByRole("tablist", { name: "Workspace view mode" });
    for (const name of ["PDF", "Split", "PDF", "Split"]) {
      await modes.getByRole("tab", { name, exact: true }).click();
      await settle(page);
      expect(
        Math.abs((await pointY(page, size.height, expected.page)) - expected.y),
      ).toBeLessThan(2);
    }
    const after = await page.evaluate(
      () => (window as AnchorProbeWindow).__anchorCalls,
    );
    if (sync) expect(after).toEqual(before);
    else {
      // PDF-only mode still maps its outline, without moving the editor.
      expect(after.view).toBe(0);
      expect(
        Math.abs((await editor.evaluate((element) => element.scrollTop)) - 900),
      ).toBeLessThan(2);
    }
    await page.screenshot({
      path: test.info().outputPath(`reading-anchor-sync-${sync}.png`),
    });
  });
}

test("a hidden PDF resolves its reading anchor before opening and holds it throughout motion", async ({
  page,
}) => {
  const size = await prepare(page);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const modes = page.getByRole("tablist", { name: "Chat workspace content" });
  await modes.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle(page);
  const pdf = page.getByTestId("pdf-scroll-container");
  const before = await pdf.evaluate((element) => element.scrollTop);
  await page.locator(".cm-scroller").evaluate((element) => {
    element.scrollTop = 900;
  });
  await expect
    .poll(() => pdf.evaluate((element) => element.scrollTop))
    .not.toBe(before);
  await page.waitForTimeout(150);
  const expected = await readingPoint(page, size.height);
  const callsBeforeOpen = await page.evaluate(() => ({
    ...(window as AnchorProbeWindow).__anchorCalls,
  }));
  const motion = page.getByTestId("pdf-scroll-container").evaluate(
    (container, { height, expected }) =>
      new Promise<number[]>((resolve) => {
        const errors: number[] = [];
        const start = performance.now();
        const sample = () => {
          const moving =
            document
              .querySelector("[data-workspace-layout-animating]")
              ?.getAttribute("data-workspace-layout-animating") === "true";
          if (moving && container.clientWidth > 100) {
            const paper = container
              .querySelector<HTMLElement>(
                `[data-page-number="${expected.page}"]`,
              )!
              .getBoundingClientRect();
            const y =
              ((container.getBoundingClientRect().top +
                container.clientHeight / 2 -
                paper.top) /
                paper.height) *
              height;
            errors.push(Math.abs(y - expected.y));
          }
          if (performance.now() - start < 900)
            requestAnimationFrame(() => setTimeout(sample, 0));
          else resolve(errors);
        };
        requestAnimationFrame(() => setTimeout(sample, 0));
      }),
    { height: size.height, expected },
  );
  await modes.getByRole("tab", { name: "PDF", exact: true }).click();
  const errors = await motion;
  await settle(page);
  expect(errors.length).toBeGreaterThan(3);
  expect(Math.max(...errors)).toBeLessThan(3);
  expect(
    Math.abs((await pointY(page, size.height, expected.page)) - expected.y),
  ).toBeLessThan(2);
  expect(
    await page.evaluate(() => (window as AnchorProbeWindow).__anchorCalls),
  ).toEqual(callsBeforeOpen);
  await page.screenshot({
    path: test.info().outputPath("reading-anchor-opening.png"),
  });
});
