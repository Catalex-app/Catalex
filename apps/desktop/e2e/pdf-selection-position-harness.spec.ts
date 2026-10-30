import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";
import { extractStructuredText } from "../src/renderer/lib/mupdf/structured-text";

test("selection characters follow PDF glyph positions and mouse dragging", async ({
  page,
}) => {
  const doc = mupdf.Document.openDocument(
    readFileSync("public/examples/paper-standard/main.pdf"),
    "application/pdf",
  );
  const pdfPage = doc.loadPage(0);
  const structured = pdfPage.toStructuredText();
  const lines = extractStructuredText(structured).blocks.flatMap(
    (block) => block.lines,
  );
  structured.destroy();
  pdfPage.destroy();
  doc.destroy();
  await page.goto("/?debug=pdf-comments");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await expect(line).toBeVisible();
  const expected = lines.find((line) => line.text === "Your abstract here.")!;
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await line.scrollIntoViewIfNeeded();
    await line.screenshot();
    const error = await line.evaluate((element, chars) => {
      const text = element as SVGTextElement;
      return Math.max(
        ...chars.map((char, i) =>
          Math.abs(text.getStartPositionOfChar(i).x - char.origin.x),
        ),
      );
    }, expected.chars!);
    expect(error).toBeLessThan(0.01);
    const points = await line.evaluate((element) => {
      const text = element as SVGTextElement;
      const matrix = text.getScreenCTM()!;
      return [5, 13, 18].map((index) => {
        const p = text.getStartPositionOfChar(index);
        return new DOMPoint(p.x + 0.1, p.y - 2)
          .matrixTransform(matrix)
          .toJSON();
      });
    });
    await page.mouse.move(points[0].x, points[0].y);
    await page.mouse.down();
    await page.mouse.move(points[1].x, points[1].y, { steps: 12 });
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("abstract");
    await page.mouse.move(width - 30, points[1].y);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("abstract here.");
    await page.mouse.move(points[2].x, points[2].y);
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("abstract here");
    await page.mouse.move(points[1].x, points[1].y);
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("abstract");
    await page.keyboard.press("Escape");
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(points[1].x, points[1].y);
    await page.mouse.down();
    await page.mouse.move(points[0].x, points[0].y, { steps: 12 });
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("abstract");
    await page.mouse.move(30, points[0].y);
    await page.mouse.up();
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe("Your abstract");
    await expect(page.locator(".pdf-selection-highlight")).toHaveCount(1);
    expect(
      await line.evaluate(
        (element) => getComputedStyle(element, "::selection").backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0)");
  }
  await page.screenshot({
    path: test.info().outputPath("mouse-selection.png"),
  });
});

test("paints separate continuous lines for backward multiline selection and clears on dismissal", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&lists");
  const start = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "and like this." })
    .first();
  await expect(start).toBeVisible();
  await start.evaluate((element) => {
    const end = [...element.closest("svg")!.querySelectorAll("text")].find(
      (line) => line.textContent?.includes("or bullet points"),
    )!;
    window
      .getSelection()!
      .setBaseAndExtent(
        end.firstChild!,
        end.textContent!.length,
        element.firstChild!,
        0,
      );
  });
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(2);
  await page.screenshot({
    path: test.info().outputPath("continuous-lines.png"),
  });
  await page.evaluate(() => window.getSelection()!.removeAllRanges());
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
});

test("follows the cursor row while dragging down through the right margin", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&lists");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  const first = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Like this," })
    .first();
  await expect(first).toBeVisible();
  await first.screenshot();
  const points = await first.evaluate((element) => {
    const lines = [...element.closest("svg")!.querySelectorAll("text")];
    return [
      element,
      lines.find((line) => line.textContent?.includes("and like this."))!,
      lines.find((line) => line.textContent?.includes("or bullet points"))!,
    ].map((line) => {
      const rect = line.getBoundingClientRect();
      return {
        x: rect.left + 0.1,
        y: (rect.top + rect.bottom) / 2,
        right: rect.right + 60,
      };
    });
  });
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  await page.mouse.move(points[0].x + 20, points[0].y, { steps: 5 });
  await page.mouse.move(points[1].right, points[1].y);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().trim()))
    .toMatch(/and like this\.$/);
  await page.mouse.move(points[2].right, points[2].y);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("or bullet points");
  await page.mouse.up();
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("row-selection.png") });
});

test("scopes Select All and copying to PDF text across all pages", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&multipage");
  await expect(page.locator(".mupdf-text-layer text").first()).toBeVisible();
  const viewport = page.getByTestId("pdf-scroll-container");
  await viewport.focus();
  await page.keyboard.press("Meta+a");
  await expect(page.locator(".mupdf-text-layer")).toHaveCount(3);
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("Third page comment target.");
  const copied = await page.evaluate(() => {
    const data = new DataTransfer();
    document.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return data.getData("text/plain");
  });
  expect(copied).toContain("First page comment target.");
  expect(copied).toContain("Third page comment target.");
  expect(copied).not.toContain("Toggle editor");
  expect(copied).not.toContain("comment must stay hidden");
  expect(
    await page
      .locator(".mupdf-page canvas")
      .first()
      .evaluate((el) =>
        getComputedStyle(el).getPropertyValue("-webkit-user-select"),
      ),
  ).toBe("none");
  expect(
    await page
      .locator(".mupdf-page canvas")
      .first()
      .evaluate((el) => getComputedStyle(el, "::selection").backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  await page
    .locator('.mupdf-page[data-page-number="2"]')
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("cross-page-selection.png"),
  });
  await page.keyboard.press("Escape");
  await expect(page.locator(".pdf-selection-highlight")).toHaveCount(0);
});

test("new controls inherit shell defaults while editors and readable content remain selectable", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  const result = await page.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "New control";
    const content = document.createElement("div");
    content.dataset.selectableContent = "true";
    content.textContent = "Readable text";
    document.body.append(button, content);
    const result = {
      button: getComputedStyle(button).getPropertyValue("-webkit-user-select"),
      readable: getComputedStyle(content).getPropertyValue(
        "-webkit-user-select",
      ),
      editor: getComputedStyle(
        document.querySelector(".cm-content")!,
      ).getPropertyValue("-webkit-user-select"),
    };
    button.focus();
    return result;
  });
  expect(result).toEqual({ button: "none", readable: "text", editor: "text" });
  await page.keyboard.press("Meta+a");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.locator(".cm-content").first().click();
  await page.keyboard.press("Meta+a");
  const selected = await page.evaluate(() => window.getSelection()?.toString());
  expect(selected).not.toContain("New control");
  const copied = await page
    .locator(".cm-content")
    .first()
    .evaluate((editor) => {
      const data = new DataTransfer();
      editor.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      return data.getData("text/plain");
    });
  expect(copied).toContain("documentclass");
  expect(copied).not.toContain("New control");
});

test("keeps the drag anchor when crossing virtualized PDF pages", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&multipage");
  await page
    .getByRole("button", { name: "Toggle editor", exact: true })
    .click();
  // Comment highlights intentionally intercept clicks; exercise the text drag surface.
  await page
    .getByRole("button", { name: "Toggle PDF comments", exact: true })
    .click();
  const first = page
    .locator('.mupdf-page[data-page-number="1"] text')
    .filter({ hasText: "First page comment target." });
  await expect(first).toBeVisible();
  await first.screenshot();
  const start = await first.boundingBox();
  await page.mouse.move(start!.x + 0.1, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + 30, start!.y + start!.height / 2);
  await expect(page.locator(".mupdf-text-layer")).toHaveCount(3);
  await page.getByTestId("pdf-scroll-container").evaluate((viewport) => {
    viewport.scrollTop = (
      viewport.querySelector('.mupdf-page[data-page-number="2"]') as HTMLElement
    ).offsetTop;
  });
  const second = page.locator('.mupdf-page[data-page-number="2"] text').first();
  await expect(second).toBeVisible();
  const end = await second.boundingBox();
  await page.mouse.move(end!.x + end!.width + 20, end!.y + end!.height / 2);
  await page.mouse.up();
  const selected = await page.evaluate(() => ({
    text: window.getSelection()?.toString(),
    anchorPage: window
      .getSelection()
      ?.anchorNode?.parentElement?.closest(".mupdf-page")
      ?.getAttribute("data-page-number"),
    focusPage: window
      .getSelection()
      ?.focusNode?.parentElement?.closest(".mupdf-page")
      ?.getAttribute("data-page-number"),
  }));
  expect(selected.anchorPage).toBe("1");
  expect(selected.focusPage).toBe("2");
  expect(selected.text).toContain("First page comment target.");
  expect(selected.text).toContain("This paragraph");
});
