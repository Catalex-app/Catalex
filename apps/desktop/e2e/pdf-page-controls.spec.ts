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
  test(`${theme} PDF controls overflow in priority order and retain navigation`, async ({
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
    const counter = navigation.getByRole("button", {
      name: "Click to jump to page",
    });
    const previous = navigation.getByRole("button", {
      name: "Page Up",
      exact: true,
    });
    const next = navigation.getByRole("button", {
      name: "Page Down",
      exact: true,
    });
    await expect(counter).toHaveText("1/123");
    await expect(previous).toBeDisabled();
    await next.click();
    await expect(counter).toHaveText("2/123");
    const before = (await counter.boundingBox())!.width;
    await counter.click();
    const inlineInput = navigation.getByRole("textbox", {
      name: "Page number",
    });
    await inlineInput.fill("123");
    expect((await inlineInput.boundingBox())!.width).toBeCloseTo(before, 1);
    expect(
      await inlineInput.evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
    await inlineInput.press("Enter");
    await expect(counter).toHaveText("123/123");
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(counter).toHaveText("122/123");

    const stages = new Set<number>();
    let compactBeforeOverflow = false;
    for (let width = 1200; width >= 560; width -= 20) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(90);
      const hidden = await Promise.all([
        counter.isVisible(),
        toolbar
          .getByRole("button", { name: "Fit height", exact: true })
          .isVisible(),
        toolbar
          .getByRole("button", { name: "Fit width", exact: true })
          .isVisible(),
        toolbar
          .getByRole("button", { name: "Export PDF", exact: true })
          .isVisible(),
      ]).then((visible) => visible.map((value) => !value));
      const stage = hidden.filter(Boolean).length;
      const compileWidth = (await toolbar
        .getByRole("button", { name: "Recompile", exact: true })
        .boundingBox())!.width;
      if (stage === 0 && compileWidth === 28) compactBeforeOverflow = true;
      if (stage > 0) expect(compileWidth).toBe(28);
      stages.add(stage);
      expect(hidden).toEqual([0, 1, 2, 3].map((index) => index < stage));
      expect(
        await toolbar
          .locator("[data-panel-header-space]")
          .evaluate((el) => el.getBoundingClientRect().width),
      ).toBe(56);
      expect(
        await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth),
      ).toBeLessThanOrEqual(1);
      await expect(
        toolbar.getByRole("button", { name: "Recompile", exact: true }),
      ).toBeVisible();
      await expect(
        toolbar.getByRole("group", { name: "PDF zoom", exact: true }),
      ).toBeVisible();
    }
    expect(compactBeforeOverflow).toBe(true);
    expect([...stages].sort()).toEqual([0, 1, 2, 3, 4]);
    await expect(navigation).toHaveCount(0);
    await expect(toolbar.locator("[data-pdf-page-separator]")).toHaveCount(0);
    await toolbar
      .getByRole("button", { name: "More PDF view actions" })
      .click();
    await expect(page.getByRole("menu")).toBeVisible();
    const pageItem = page.getByRole("menuitem", {
      name: /^Page \d+ \/ 123$/,
      exact: true,
    });
    const currentLabel = (await pageItem.getAttribute("aria-label"))!;
    const countBounds = (await pageItem
      .locator("[data-pdf-menu-page-count]")
      .boundingBox())!;
    const rowHeight = (await pageItem.boundingBox())!.height;
    await pageItem.click();
    const input = page.getByRole("textbox", { name: "Page number" });
    await expect(input).toBeFocused();
    const inputBounds = (await input.boundingBox())!;
    expect(inputBounds.x).toBeCloseTo(countBounds.x, 1);
    expect(inputBounds.width).toBeCloseTo(countBounds.width, 1);
    expect((await pageItem.boundingBox())!.height).toBe(rowHeight);
    await page.getByRole("menu").screenshot({
      path: testInfo.outputPath(`pdf-page-input-${theme}.png`),
      animations: "disabled",
    });
    await input.fill("1");
    await input.press("Escape");
    await expect(pageItem).toHaveAttribute("aria-label", currentLabel);
    await pageItem.click();
    await input.fill("1");
    await input.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "Previous page", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("menuitem", { name: "Next page", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: "Page 2 / 123", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`pdf-overflow-${theme}.png`),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1600, height: 900 });
    await expect(counter).toHaveText("2/123");
    await expect(
      toolbar.getByRole("button", { name: "Fit height", exact: true }),
    ).toBeVisible();
    await expect(
      toolbar.getByRole("button", { name: "Export PDF", exact: true }),
    ).toBeVisible();
  });
}
