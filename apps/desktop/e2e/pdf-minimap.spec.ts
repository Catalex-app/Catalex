import { expect, type Page, test } from "@playwright/test";
import * as mupdf from "mupdf";

async function openPdf(page: Page, standalone = false, minimap = true) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible({
    timeout: 30_000,
  });
  if (standalone) {
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
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  }
  await expect(
    page.getByRole("complementary", { name: "PDF minimap" }),
  ).toHaveCount(minimap ? 1 : 0);
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
}

async function scrollLimits(page: Page) {
  return page.getByTestId("pdf-scroll-container").evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
}

for (const standalone of [false, true]) {
  test(`${standalone ? "standalone" : "compiled"} PDF minimap scrolls, drags, follows zoom and restores the scrollbar when disabled`, async ({
    page,
  }) => {
    await openPdf(page, standalone);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const map = page.getByRole("complementary", { name: "PDF minimap" });
    const scroller = page.getByTestId("pdf-scroll-container");
    const bars = await scroller.evaluate((element) => ({
      width: getComputedStyle(element, "::-webkit-scrollbar").width,
      height: getComputedStyle(element, "::-webkit-scrollbar").height,
      standard: getComputedStyle(element).scrollbarWidth,
    }));
    expect(bars.width).toBe("0px");
    expect(Number.parseFloat(bars.height)).toBeGreaterThan(0);
    expect(bars.standard).toBe("auto");
    await expect(map).toHaveCSS(
      "background-color",
      await map.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--pdf-panel-background)";
        el.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }),
    );
    await expect(map).toHaveCSS("border-radius", "8px");
    await expect(map).toHaveCSS("box-shadow", "none");
    const mapBox = (await map.boundingBox())!;
    const viewportBox = (await scroller.boundingBox())!;
    expect(viewportBox.x + viewportBox.width).toBeGreaterThan(
      mapBox.x + mapBox.width,
    );
    await expect
      .poll(async () => {
        const pdf = (await scroller
          .locator(".mupdf-page")
          .first()
          .boundingBox())!;
        return pdf.x + pdf.width - mapBox.x;
      })
      .toBeLessThan(0);
    await page.screenshot({
      path: test.info().outputPath("pdf-minimap-fit-island.png"),
    });
    const scrubber = map.getByRole("button", { name: /Navigate PDF/ });
    await scrubber.focus();
    await page.keyboard.press("End");
    await expect
      .poll(async () => {
        const { top, max } = await scrollLimits(page);
        return max - top;
      })
      .toBeLessThan(2);
    await expect(scrubber).toHaveAttribute("aria-label", /to 4 of 4/);
    await page.keyboard.press("Home");
    await expect.poll(async () => (await scrollLimits(page)).top).toBe(0);
    const track = (await map.locator("[data-minimap-track]").boundingBox())!;
    await page.mouse.click(track.x + 1, track.y + track.height * 0.65);
    await expect
      .poll(async () => {
        const { top, max } = await scrollLimits(page);
        return top / max;
      })
      .toBeGreaterThan(0.5);
    const handle = (await map
      .locator("[data-minimap-viewport]")
      .boundingBox())!;
    await page.mouse.move(track.x + 1, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + 1, track.y + 2, { steps: 12 });
    await page.mouse.up();
    await expect
      .poll(async () => (await scrollLimits(page)).top)
      .toBeLessThan(2);
    const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
    await zoom.fill("200%");
    await zoom.press("Enter");
    await expect
      .poll(async () =>
        map
          .locator("[data-minimap-viewport]")
          .evaluate((el) => el.getBoundingClientRect().height),
      )
      .toBeLessThan(handle.height);
    await expect
      .poll(() =>
        page
          .locator(".mupdf-page")
          .first()
          .evaluate((el) =>
            Math.abs(
              el.getBoundingClientRect().height -
                Number.parseFloat((el as HTMLElement).style.height),
            ),
          ),
      )
      .toBeLessThan(0.1);
    await scrubber.focus();
    await page.keyboard.press("End");
    await expect
      .poll(async () => {
        const { top, max } = await scrollLimits(page);
        return max - top;
      })
      .toBeLessThan(2);
    await page.keyboard.press("Home");
    await expect(scroller.locator(".mupdf-text-layer").first()).toBeVisible();
    await expect
      .poll(async () => {
        const pdf = (await scroller
          .locator(".mupdf-page")
          .first()
          .boundingBox())!;
        return pdf.x + pdf.width - mapBox.x;
      })
      .toBeGreaterThan(0);
    await scroller.focus();
    await page.screenshot({
      path: test.info().outputPath("pdf-minimap-scrollbar-hidden.png"),
    });
    await page.goto("/?debug=markdown-settings&section=appearance");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const toggle = page.getByRole("switch", {
      name: "Show minimap",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await openPdf(page, standalone, false);
    await expect(map).toHaveCount(0);
    await expect(page.locator(".pdf-with-minimap")).toHaveCount(0);
    await expect(scroller).toHaveCSS("scrollbar-width", "thin");
    expect(
      await scroller.evaluate(
        (el) => getComputedStyle(el, "::-webkit-scrollbar").width,
      ),
    ).toBe("6px");
    await page.goto("/?debug=markdown-settings&section=appearance");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await openPdf(page, standalone);
    await expect(map).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("compiled markers show PDF page labels, navigate source comments, and work in the preview pop-out", async ({
  page,
}) => {
  await openPdf(page);
  const map = page.getByRole("complementary", { name: "PDF minimap" });
  await expect(map.locator('[data-kind="human"]')).toHaveCount(1);
  await expect(map.locator('[data-kind="agent"]')).toHaveCount(1);
  await map.locator("[data-minimap-marker]").first().hover();
  const card = page.locator('.editor-minimap-card[data-state="open"]');
  await expect(card).toContainText("Page 1");
  await page.screenshot({
    path: test.info().outputPath("compiled-minimap.png"),
  });
  await card
    .getByRole("button")
    .filter({ hasText: "Describe the problem" })
    .click();
  await expect(
    page
      .locator(".cm-inlineCommentCard")
      .filter({ hasText: "Describe the problem" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "More PDF view actions", exact: true })
    .click();
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("menuitem", { name: "Pop out PDF", exact: true })
    .click();
  const child = await opened;
  const childMap = child.getByRole("complementary", { name: "PDF minimap" });
  await expect(childMap.locator('[data-kind="agent"]')).toHaveCount(1);
  await childMap.locator("[data-minimap-marker]").first().hover();
  await child
    .locator('.editor-minimap-card[data-state="open"]')
    .getByRole("button")
    .filter({ hasText: "Describe the problem" })
    .click();
  await expect(
    child.getByRole("dialog", { name: "PDF comment", exact: true }),
  ).toContainText("Describe the problem");
  await child.screenshot({
    path: test.info().outputPath("compiled-minimap-popout.png"),
  });
  await child.close();
});

test("standalone markers filter by author, open the comment and disappear on resolution", async ({
  page,
}) => {
  await openPdf(page, true);
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await line.scrollIntoViewIfNeeded();
  await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const comment = page.getByRole("dialog", {
    name: "PDF comment",
    exact: true,
  });
  await comment
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Minimap human comment");
  await comment
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  // Add an agent-authored comment through the same persisted store, sharing the passage.
  await page.evaluate(async () => {
    const storage = await import(
      /* @vite-ignore */ "/src/renderer/components/workspace/editor/inline-comment-storage.ts"
    );
    const { useDocumentStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const root = useDocumentStore.getState().projectRoot;
    const before = await storage.loadProjectInlineComments(root);
    const first = before["paper.pdf"][0];
    await storage.saveProjectInlineComments(root, before, {
      ...before,
      "paper.pdf": [
        ...before["paper.pdf"],
        {
          ...first,
          id: "pdf-minimap-agent",
          number: 99,
          text: "Minimap agent comment",
          origin: { provider: "codex", sessionId: "minimap" },
        },
      ],
    });
    storage.notifyProjectCommentsRestored(root);
  });
  const map = page.getByRole("complementary", { name: "PDF minimap" });
  await expect(map.locator('[data-kind="agent"]')).toHaveCount(1);
  await expect(map.locator('[data-kind="human"]')).toHaveCount(1);
  await map
    .getByRole("button", { name: "Minimap layers", exact: true })
    .click();
  await expect(page.getByRole("menuitemcheckbox")).toHaveCount(2);
  await page
    .getByRole("menuitemcheckbox", { name: "Human comments", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(map.locator('[data-kind="human"]')).toHaveCount(0);
  await expect(map.locator('[data-kind="agent"]')).toHaveCount(1);
  await map.locator("[data-minimap-marker]").click();
  await expect(comment).toContainText("Minimap agent comment");
  await page.getByRole("button", { name: "Toggle theme", exact: true }).click();
  await page.waitForTimeout(400);
  await map.locator("[data-minimap-marker]").click();
  await expect(comment).toContainText("Minimap agent comment");
  await page.screenshot({
    path: test.info().outputPath("standalone-minimap-dark.png"),
  });
  await comment
    .getByRole("button", { name: "Resolve comment", exact: true })
    .click();
  await comment
    .getByRole("button", { name: "Confirm resolve comment", exact: true })
    .click();
  await expect(map.locator("[data-minimap-marker]")).toHaveCount(0);
});

test("mixed-size pages use physical scroll positions and retain comment navigation", async ({
  page,
}) => {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("Helvetica");
  const fontRef = doc.addSimpleFont(font);
  let pdf: Buffer;
  try {
    for (const [width, height] of [
      [400, 400],
      [700, 2400],
      [500, 600],
    ]) {
      const object = doc.addPage(
        [0, 0, width, height],
        0,
        { Font: { F1: fontRef } },
        `BT /F1 16 Tf 30 ${height - 50} Td (Mixed page heading.) Tj 0 -24 Td (Different page dimensions.) Tj 0 -24 Td (Your abstract here.) Tj 0 -24 Td (A paragraph for the comment harness.) Tj ET`,
      );
      doc.insertPage(-1, object);
      object.destroy();
    }
    const bytes = doc.saveToBuffer("compress");
    try {
      pdf = Buffer.from(bytes.asUint8Array());
    } finally {
      bytes.destroy();
    }
  } finally {
    fontRef.destroy();
    font.destroy();
    doc.destroy();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/examples/paper-standard/main.pdf", (route) =>
    route.fulfill({ contentType: "application/pdf", body: pdf }),
  );
  await page.goto("/?debug=pdf-comments");
  const map = page.getByRole("complementary", { name: "PDF minimap" });
  await expect(map).toBeVisible();
  const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("100%");
  await zoom.press("Enter");
  await expect(page.locator("[data-pdf-page-canvas]").first()).toHaveAttribute(
    "data-pdf-rendered-scale",
    "1",
  );
  const track = (await map.locator("[data-minimap-track]").boundingBox())!;
  await page.mouse.click(track.x + 1, track.y + track.height * 0.6);
  await expect
    .poll(() =>
      page.getByTestId("pdf-scroll-container").evaluate((el) => {
        const center = el.getBoundingClientRect().top + el.clientHeight / 2;
        const visible = [
          ...el.querySelectorAll<HTMLElement>("[data-page-number]"),
        ].find((page) => {
          const rect = page.getBoundingClientRect();
          return rect.top <= center && rect.bottom >= center;
        });
        return visible?.dataset.pageNumber;
      }),
    )
    .toBe("2");
  await map.locator("[data-minimap-marker]").first().click();
  await expect(
    map.getByRole("button", { name: /Navigate PDF/ }),
  ).toHaveAttribute("aria-label", /visible pages 1/);
  await page.screenshot({
    path: test.info().outputPath("mixed-size-minimap.png"),
  });
});

test("PDF overlays stay beneath the opaque minimap in both themes", async ({
  page,
}) => {
  await openPdf(page, true);
  const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
  await zoom.fill("200%");
  await zoom.press("Enter");
  await expect(page.locator("[data-pdf-page-canvas]").first()).toHaveAttribute(
    "data-pdf-rendered-scale",
    "2",
  );
  // A controlled long PDF link exercises the real overlay CSS at the island edge.
  await page
    .locator(".mupdf-page")
    .first()
    .evaluate((paper) => {
      let layer = paper.querySelector(".mupdf-link-layer");
      if (!layer) {
        layer = document.createElement("div");
        layer.className = "mupdf-link-layer";
        paper.append(layer);
      }
      const link = document.createElement("a");
      link.href = "#fixture";
      link.setAttribute("aria-label", "Long PDF fixture link");
      link.dataset.minimapOverlapFixture = "true";
      link.style.cssText = "left:0;top:120px;width:100%;height:24px";
      layer.append(link);
    });
  const map = page.getByRole("complementary", { name: "PDF minimap" });
  for (const theme of ["modern", "classic"])
    for (const dark of [false, true]) {
      await page.evaluate(
        async ({ theme, dark }) => {
          const { useSettingsStore } = await import(
            /* @vite-ignore */ "/src/renderer/stores/settings-store.ts"
          );
          useSettingsStore.getState().setModeTheme("duet", theme);
          document.documentElement.classList.toggle("dark", dark);
        },
        { theme, dark },
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-ui-theme",
        theme,
      );
      const surface = await map.evaluate((el) => {
        const css = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const link = document
          .querySelector("[data-minimap-overlap-fixture]")!
          .getBoundingClientRect();
        const front = document.elementFromPoint(
          rect.left + rect.width / 2,
          link.top + link.height / 2,
        );
        const probe = document.createElement("span");
        probe.style.backgroundColor = "var(--pdf-panel-background)";
        el.append(probe);
        const expectedColor = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return {
          front: !!front?.closest("[data-pdf-minimap]"),
          filter: css.backdropFilter,
          color: css.backgroundColor,
          expectedColor,
          shadow: css.boxShadow,
        };
      });
      expect(surface.front).toBe(true);
      expect(surface.filter).toBe("none");
      expect(surface.color).toBe(surface.expectedColor);
      expect(surface.shadow).toBe("none");
      await page.screenshot({
        path: test
          .info()
          .outputPath(`minimap-opaque-${theme}-${dark ? "dark" : "light"}.png`),
      });
    }
});
