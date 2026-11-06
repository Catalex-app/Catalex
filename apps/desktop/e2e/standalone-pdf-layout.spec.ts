import { expect, type Locator, type Page, test } from "@playwright/test";

async function openStandalonePdf(page: Page) {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    const { useDocumentStore: doc, getPdfBytes } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const bytes = getPdfBytes("sample.tex");
    const host = (window as any).__TAURI_INTERNALS__;
    const invoke = host.invoke.bind(host);
    host.invoke = (command: string, args: any, ...rest: any[]) =>
      command === "plugin:fs|read_file" && args.path.endsWith("/paper.pdf")
        ? Promise.resolve(bytes)
        : invoke(command, args, ...rest);
    const file = {
      ...doc.getState().files.find((file: any) => file.id === "sample.tex"),
      id: "paper.pdf",
      name: "paper.pdf",
      relativePath: "paper.pdf",
      absolutePath: "/demo/paper.pdf",
      type: "pdf",
      content: "",
    };
    doc.setState({ files: [...doc.getState().files, file] });
    doc.getState().setActiveFile(file.id);
  });
  await expect(page.getByTestId("pdf-scroll-container")).toHaveCount(1);
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.waitForTimeout(700);
}

function recordMotion(scroller: Locator) {
  return scroller.evaluate(
    (el) =>
      new Promise<
        {
          width: number;
          viewport: number;
          gutter: number;
          height: number;
          moving: boolean;
        }[]
      >((resolve) => {
        const samples: {
          width: number;
          viewport: number;
          gutter: number;
          height: number;
          moving: boolean;
        }[] = [];
        const start = performance.now();
        const sample = () => {
          const rect = el.querySelector(".mupdf-page")!.getBoundingClientRect();
          samples.push({
            width: rect.width,
            height: rect.height,
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
          });
          if (performance.now() - start < 1000)
            requestAnimationFrame(() => setTimeout(sample, 0));
          else resolve(samples);
        };
        sample();
      }),
  );
}

function readingPoint(scroller: Locator) {
  return scroller.evaluate((el) => {
    const y = el.getBoundingClientRect().top + el.clientHeight / 2;
    const page = Array.from(
      el.querySelectorAll<HTMLElement>(".mupdf-page"),
    ).find((page) => {
      const rect = page.getBoundingClientRect();
      return rect.top <= y && rect.bottom >= y;
    })!;
    const rect = page.getBoundingClientRect();
    return { page: page.dataset.pageNumber, y: (y - rect.top) / rect.height };
  });
}

for (const width of [1440, 1024]) {
  for (const fit of ["Fit width", "Fit height"]) {
    test(`standalone PDF ${fit} follows drawer and panel motion at ${width}px`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize({ width, height: 900 });
      await openStandalonePdf(page);
      const scroller = page.getByTestId("pdf-scroll-container");
      await page.getByRole("button", { name: fit, exact: true }).click();
      await page.waitForTimeout(500);
      await scroller.evaluate((el) => {
        const page = el.querySelectorAll<HTMLElement>(".mupdf-page")[1];
        el.scrollTop +=
          page.getBoundingClientRect().top +
          page.getBoundingClientRect().height / 2 -
          el.getBoundingClientRect().top -
          el.clientHeight / 2;
      });
      await page.waitForTimeout(250);
      const initial = await readingPoint(scroller);
      const checkReadingPoint = async () => {
        const after = await readingPoint(scroller);
        expect(after.page).toBe(initial.page);
        expect(Math.abs(after.y - initial.y)).toBeLessThan(0.025);
      };
      for (const drawer of ["Full", "Half"]) {
        if (drawer === "Full")
          await page
            .getByRole("button", { name: "Toggle drawer", exact: true })
            .locator("..")
            .hover();
        const motion = recordMotion(scroller);
        await page.getByRole("button", { name: drawer, exact: true }).click();
        const frames = await motion;
        const moving = frames.filter(
          (frame) => frame.moving && frame.viewport > 50,
        );
        expect(moving.length).toBeGreaterThan(3);
        if (fit === "Fit width") {
          if (
            moving.some(
              (frame) =>
                Math.abs(frame.width - (frame.viewport - frame.gutter)) >= 4,
            )
          )
            await test.info().attach(`fit-motion-${drawer}`, {
              body: JSON.stringify(frames),
              contentType: "application/json",
            });
          expect(
            Math.max(
              ...moving.map((frame) =>
                Math.abs(frame.width - (frame.viewport - frame.gutter)),
              ),
            ),
          ).toBeLessThan(4);
        } else {
          expect(
            Math.max(...frames.map((frame) => frame.height)) -
              Math.min(...frames.map((frame) => frame.height)),
          ).toBeLessThan(4);
        }
        await checkReadingPoint();
      }
      await page
        .getByRole("button", { name: "More Editor view actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Expand Editor", exact: true })
        .click();
      const expanded = page.getByRole("dialog", { name: "Editor expanded" });
      await expect(expanded).toBeVisible();
      await expect(expanded).not.toHaveAttribute("data-panel-expansion-motion");
      await page.waitForTimeout(300);
      await checkReadingPoint();
      await page.screenshot({
        path: test.info().outputPath(`standalone-${fit}-${width}.png`),
        animations: "disabled",
      });
      await page
        .getByRole("button", { name: "Restore Editor", exact: true })
        .click();
      await expect(expanded).toHaveCount(0);
      await page.waitForTimeout(400);
      await checkReadingPoint();
      for (const mode of ["Artisan", "Duet"]) {
        await page.getByRole("tab", { name: mode, exact: true }).click();
        await page.waitForTimeout(700);
        await checkReadingPoint();
      }
      const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
      await zoom.fill("125%");
      await zoom.press("Enter");
      await page.waitForTimeout(400);
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
      const manual = recordMotion(scroller);
      await page.getByRole("button", { name: "Full", exact: true }).click();
      const frames = await manual;
      expect(
        Math.max(...frames.map((frame) => frame.width)) -
          Math.min(...frames.map((frame) => frame.width)),
      ).toBeLessThan(1);
      await expect(zoom).toHaveValue("125%");
    });
  }
}

test("standalone PDF pop-outs retain fit, explicit zoom animation and manual zoom on resize", async ({
  page,
}) => {
  await openStandalonePdf(page);
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Editor", exact: true })
    .click();
  const child = await opened;
  const scroller = child.getByTestId("pdf-scroll-container");
  await expect(scroller.locator(".mupdf-text-layer").first()).toBeVisible();
  for (const fit of ["Fit height", "Fit width"]) {
    const motion = recordMotion(scroller);
    await child.getByRole("button", { name: fit, exact: true }).click();
    const frames = await motion;
    const min = Math.min(...frames.map((frame) => frame.width));
    const max = Math.max(...frames.map((frame) => frame.width));
    expect(
      new Set(
        frames
          .filter((frame) => frame.width > min + 1 && frame.width < max - 1)
          .map((frame) => Math.round(frame.width)),
      ).size,
    ).toBeGreaterThan(3);
    for (const width of [800, 1200]) {
      await child.setViewportSize({ width, height: width === 800 ? 700 : 900 });
      await expect
        .poll(() =>
          scroller.evaluate((el, fit) => {
            const rect = el
              .querySelector(".mupdf-page")!
              .getBoundingClientRect();
            const contentStyle = getComputedStyle(
              el.querySelector("[data-pdf-scroll-content]")!,
            );
            const horizontalPadding =
              Number.parseFloat(contentStyle.paddingLeft) +
              Number.parseFloat(contentStyle.paddingRight);
            return Math.abs(
              fit === "Fit width"
                ? rect.width - el.clientWidth + horizontalPadding
                : rect.height - el.clientHeight + 32,
            );
          }, fit),
        )
        .toBeLessThan(1);
    }
  }
  const zoom = child.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("125%");
  await zoom.press("Enter");
  await child.waitForTimeout(400);
  const before = await scroller.locator(".mupdf-page").first().boundingBox();
  await child.setViewportSize({ width: 800, height: 700 });
  await child.waitForTimeout(400);
  const after = await scroller.locator(".mupdf-page").first().boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  await expect(zoom).toHaveValue("125%");
  await child.screenshot({
    path: test.info().outputPath("standalone-pdf-popout.png"),
    animations: "disabled",
  });
  await child.close();
});
