import { expect, test, type Page, type Locator } from "@playwright/test";

async function observeScroll(page: Page, scroller: Locator) {
  await scroller.evaluate((element) => {
    const samples: number[] = [];
    const editor = element.closest(".cm-editor");
    const win = window as unknown as { navigationMaxRenderedLines: number };
    win.navigationMaxRenderedLines = 0;
    const began = performance.now();
    (
      window as unknown as { navigationSamples: Promise<number[]> }
    ).navigationSamples = new Promise((resolve) => {
      const sample = () => {
        samples.push(element.scrollTop);
        if (editor)
          win.navigationMaxRenderedLines = Math.max(
            win.navigationMaxRenderedLines,
            editor.querySelectorAll(".cm-line").length,
          );
        if (performance.now() - began < 650) requestAnimationFrame(sample);
        else resolve(samples);
      };
      sample();
    });
  });
  return async () => {
    const samples = await page.evaluate(
      () =>
        (window as unknown as { navigationSamples: Promise<number[]> })
          .navigationSamples,
    );
    const start = samples[0];
    const end = samples.at(-1)!;
    expect(Math.abs(end - start)).toBeGreaterThan(100);
    const between = samples.filter(
      (value) =>
        value > Math.min(start, end) + 2 && value < Math.max(start, end) - 2,
    );
    expect(new Set(between.map(Math.round)).size).toBeGreaterThan(2);
    return samples;
  };
}

test("Locate PDF/editor uses short scrolling without per-frame native mappings", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=latex-scroll-sync");
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-ready", "true");
  await page
    .getByRole("button", {
      name: "Disable synchronized scrolling",
      exact: true,
    })
    .click();
  const editor = page.locator(".cm-scroller");
  const pdf = page.getByTestId("pdf-scroll-container");
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page.waitForTimeout(500);
  await pdf.evaluate((element) => {
    element.scrollTop = 0;
  });
  const callsBefore = Number(
    await page.getByTestId("synctex-view-calls").textContent(),
  );
  await page.evaluate(async () => {
    const clientPath = "/src/renderer/lib/mupdf/mupdf-client.ts";
    const scrollPath = "/src/renderer/lib/navigation-scroll.ts";
    const { getMupdfClient } = await import(clientPath);
    const { isNavigationScrolling } = await import(scrollPath);
    const client = getMupdfClient();
    const original = client.drawPage.bind(client);
    const win = window as unknown as {
      navigationDraws: number;
      navigationObserverAdds: number;
    };
    win.navigationDraws = 0;
    win.navigationObserverAdds = 0;
    const observe = IntersectionObserver.prototype.observe;
    IntersectionObserver.prototype.observe = function (element) {
      if (element.classList.contains("mupdf-page"))
        win.navigationObserverAdds++;
      return observe.call(this, element);
    };
    client.drawPage = (...args: unknown[]) => {
      const scroll = document.querySelector(
        '[data-testid="pdf-scroll-container"]',
      );
      if (scroll && isNavigationScrolling(scroll)) win.navigationDraws++;
      return original(...args);
    };
  });
  const pdfSamples = await observeScroll(page, pdf);
  await page
    .getByRole("button", { name: "Locate PDF position", exact: true })
    .click();
  await pdfSamples();
  expect(
    Number(await page.getByTestId("synctex-view-calls").textContent()) -
      callsBefore,
  ).toBe(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { navigationDraws: number }).navigationDraws,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { navigationObserverAdds: number })
          .navigationObserverAdds,
    ),
  ).toBe(0);
  await editor.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  const editsBefore = Number(
    await page.getByTestId("synctex-edit-calls").textContent(),
  );
  const editorSamples = await observeScroll(page, editor);
  await page
    .getByRole("button", { name: "Locate editor position", exact: true })
    .click();
  await editorSamples();
  expect(
    Number(await page.getByTestId("synctex-edit-calls").textContent()) -
      editsBefore,
  ).toBe(1);
  await page.screenshot({ path: test.info().outputPath("located-editor.png") });
});

test("reduced motion locates the PDF immediately", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?debug=latex-scroll-sync");
  await expect(
    page.getByTestId("latex-scroll-sync-harness-shell"),
  ).toHaveAttribute("data-ready", "true");
  await page
    .getByRole("button", {
      name: "Disable synchronized scrolling",
      exact: true,
    })
    .click();
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("ControlOrMeta+End");
  await page
    .getByRole("button", { name: "Locate PDF position", exact: true })
    .click();
  const pdf = page.getByTestId("pdf-scroll-container");
  await expect
    .poll(() => pdf.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  expect(
    await pdf.evaluate(async (element) => {
      const path = "/src/renderer/lib/navigation-scroll.ts";
      const { isNavigationScrolling } = await import(path);
      return isNavigationScrolling(element);
    }),
  ).toBe(false);
});

test("PDF highlight clicks animate the source comment into view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=comment-workspace&pdf");
  const highlight = page.locator('[data-pdf-comment-id="A-9"]').first();
  await expect(highlight).toBeAttached();
  await highlight.evaluate((element) =>
    element.scrollIntoView({ block: "center" }),
  );
  const editor = page.locator(".cm-scroller").first();
  await editor.evaluate((element) => {
    element.scrollTop = 0;
  });
  const samples = await observeScroll(page, editor);
  const bounds = (await highlight.boundingBox())!;
  await page.mouse.click(bounds.x + 3, bounds.y + bounds.height / 2);
  await expect(highlight).toHaveAttribute("aria-pressed", "true");
  await samples();
  const card = page.locator(
    '.cm-editor .cm-inlineCommentCard[data-inline-comment-id="A-9"]',
  );
  await expect(card).toBeVisible();
  const target = (await card.boundingBox())!;
  const viewport = (await editor.boundingBox())!;
  expect(
    Math.abs(target.y + target.height / 2 - viewport.y - viewport.height / 2),
  ).toBeLessThan(12);
  await page.screenshot({
    path: test.info().outputPath("located-comment.png"),
  });
});

test("a 100,000-line editor stays virtualized during navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?debug=editor-scroll");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    const content = Array.from(
      { length: 100_000 },
      (_, i) => `Long editor row ${String(i + 1).padStart(6, "0")}`,
    ).join("\n");
    useDocumentStore.getState().updateFileContent("main.tex", content);
  });
  await expect(page.locator(".cm-content")).toContainText(
    "Long editor row 000001",
  );
  const editor = page.locator(".cm-scroller");
  const samples = await observeScroll(page, editor);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    const store = useDocumentStore.getState();
    store.requestJumpToPosition(
      store.files[0].content.indexOf("Long editor row 090000"),
    );
  });
  await samples();
  await expect(page.locator(".cm-content")).toContainText(
    "Long editor row 090000",
  );
  expect(await page.locator(".cm-line").count()).toBeLessThan(300);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { navigationMaxRenderedLines: number })
          .navigationMaxRenderedLines,
    ),
  ).toBeLessThan(300);
});
