import { expect, test } from "@playwright/test";
import * as mupdf from "mupdf";

function fixture(count: number) {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addSimpleFont(font);
  try {
    for (let n = 1; n <= count; n++) {
      const page = doc.addPage(
        [0, 0, 612, 792],
        0,
        { Font: { F1: fontRef } },
        `BT /F1 16 Tf 50 730 Td (Page navigation test page ${n}) Tj 0 -24 Td (Counter sizing and navigation.) Tj 0 -24 Td (A paragraph for the comment harness.) Tj ET`,
      );
      doc.insertPage(-1, page);
      page.destroy();
    }
    const bytes = doc.saveToBuffer("compress");
    try {
      return Buffer.from(bytes.asUint8Array());
    } finally {
      bytes.destroy();
    }
  } finally {
    fontRef.destroy();
    font.destroy();
    doc.destroy();
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`${theme} page navigation stays grouped and fits across toolbar widths`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width: 1600, height: 900 });
    const pdf = fixture(123);
    await page.route("**/examples/paper-standard/main.pdf", (route) =>
      route.fulfill({ contentType: "application/pdf", body: pdf }),
    );
    await page.goto("/?debug=pdf-comments");
    await page.evaluate((theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    }, theme);
    const toolbar = page.locator("[data-pdf-toolbar]");
    const navigation = toolbar.getByRole("group", {
      name: "PDF pages",
      exact: true,
    });
    const indicator = toolbar.locator("[data-pdf-page-indicator]");
    const current = navigation.getByRole("button", {
      name: "Click to jump to page",
    });
    const pageValue = navigation.locator("[data-pdf-page-current]");
    const separator = toolbar.locator("[data-pdf-page-separator]");
    const previous = navigation.getByRole("button", {
      name: "Page Up",
      exact: true,
    });
    const next = navigation.getByRole("button", {
      name: "Page Down",
      exact: true,
    });
    const fit = toolbar.getByRole("button", { name: "Fit width", exact: true });
    await expect(indicator).toContainText("/123");
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(pageValue).toHaveText("2");

    const readingWidth = (await indicator.boundingBox())!.width;
    await current.click();
    const input = navigation.getByRole("textbox", { name: "Page number" });
    await input.fill("123");
    expect((await indicator.boundingBox())!.width).toBeCloseTo(readingWidth, 1);
    // Every digit should fit inside the input, including its padding/borders.
    expect(
      await input.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await input.press("Enter");
    await expect(pageValue).toHaveText("123");
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(pageValue).toHaveText("122");

    let expanded = false;
    let compact = false;
    for (const width of [1600, 1200, 1000, 850, 700, 1600]) {
      await page.setViewportSize({ width, height: 900 });
      await page
        .getByTestId("pdf-scroll-container")
        .evaluate(async (element) => {
          await Promise.allSettled(
            element
              .getAnimations({ subtree: true })
              .map((animation) => animation.finished),
          );
        });
      await expect
        .poll(async () => {
          const row = await toolbar.boundingBox();
          const group = await navigation.boundingBox();
          const end = await toolbar
            .getByRole("button", { name: "Export PDF", exact: true })
            .boundingBox();
          const fitBounds = await fit.boundingBox();
          const left = await toolbar
            .locator(":scope > div")
            .first()
            .boundingBox();
          return (
            group!.x >= left!.x + left!.width - 1 &&
            fitBounds!.x - (group!.x + group!.width) >= 3 &&
            end!.x + end!.width <= row!.x + row!.width - 1
          );
        })
        .toBe(true);
      expanded ||= await next.isVisible();
      compact ||= !(await next.isVisible());
      await expect(separator).toBeVisible();
      const rule = (await separator.boundingBox())!;
      const groupBounds = (await navigation.boundingBox())!;
      const fitBounds = (await fit.boundingBox())!;
      expect(rule.x).toBeGreaterThan(groupBounds.x + groupBounds.width);
      expect(rule.x + rule.width).toBeLessThan(fitBounds.x);
      await current.click();
      const editor = navigation.getByRole("textbox", { name: "Page number" });
      await expect(editor).toBeFocused();
      const fitHeight = toolbar.getByRole("button", {
        name: "Fit height",
        exact: true,
      });
      expect((await editor.boundingBox())!.height).toBe(
        (await fitHeight.boundingBox())!.height,
      );
      const focusStyle = await editor.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          radius: style.borderRadius,
          outlineStyle: style.outlineStyle,
          borderColor: style.borderColor,
          focusColor: getComputedStyle(document.documentElement)
            .getPropertyValue("--ring")
            .trim(),
          boxShadow: style.boxShadow,
        };
      });
      expect(focusStyle.radius).toBe(
        await fitHeight.evaluate(
          (element) => getComputedStyle(element).borderRadius,
        ),
      );
      expect(focusStyle.outlineStyle).toBe("none");
      expect(focusStyle.borderColor).toBe(focusStyle.focusColor);
      expect(focusStyle.boxShadow).toBe("none");
      if (width === 1600 || width === 700) {
        await toolbar.screenshot({
          path: testInfo.outputPath(`page-focus-${theme}-${width}.png`),
        });
      }
      const beforeEdit = await editor.inputValue();
      const editWidth = (await indicator.boundingBox())!.width;
      await editor.fill("1");
      await editor.press("Escape");
      await expect(pageValue).toHaveText(beforeEdit);
      expect((await indicator.boundingBox())!.width).toBeCloseTo(editWidth, 1);
      if (width === 1600 || width === 700) {
        await page.mouse.move(0, 0);
        await toolbar.screenshot({
          path: testInfo.outputPath(`pages-${theme}-${width}.png`),
        });
      }
    }
    expect(expanded).toBe(true);
    expect(compact).toBe(true);
    await current.click();
    const inputAgain = navigation.getByRole("textbox", { name: "Page number" });
    await inputAgain.fill("1");
    await inputAgain.press("Enter");
    await expect(pageValue).toHaveText("1");
    await expect(previous).toBeDisabled();
  });
}

test("single-digit tight navigation stays compact and keeps its separator when arrows collapse", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?debug=pdf-comments&multipage");
  const toolbar = page.locator("[data-pdf-toolbar]");
  const navigation = toolbar.getByRole("group", {
    name: "PDF pages",
    exact: true,
  });
  const current = navigation.getByRole("button", {
    name: "Click to jump to page",
  });
  const next = navigation.getByRole("button", {
    name: "Page Down",
    exact: true,
  });
  const separator = toolbar.locator("[data-pdf-page-separator]");
  await expect(current).toHaveText("1/3");
  await expect(next).toBeVisible();
  expect((await navigation.boundingBox())!.width).toBeLessThanOrEqual(76);
  const step = (await next.boundingBox())!;
  expect(step.width).toBe(20);
  expect(step.height).toBe(28);
  await current.click();
  const input = navigation.getByRole("textbox", { name: "Page number" });
  await expect(input).toBeFocused();
  await input.fill("2");
  await input.press("Enter");
  await expect(current).toHaveText("2/3");
  await page.mouse.move(0, 0);
  await toolbar.screenshot({
    path: testInfo.outputPath("tight-inline-wide.png"),
  });
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(next).toHaveCount(0);
  await expect(separator).toBeVisible();
  expect((await navigation.boundingBox())!.width).toBeLessThanOrEqual(36);
  await toolbar.screenshot({
    path: testInfo.outputPath("tight-inline-compact.png"),
  });
});
