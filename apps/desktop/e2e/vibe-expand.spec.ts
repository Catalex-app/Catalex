import { expect, type Page, test } from "@playwright/test";

type ScrollSyncProbeWindow = Window & {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  __scrollSyncProbe: {
    lines: number[];
    inverse?: { page: number; y: number }[];
    release?: () => void;
    releaseInverse?: () => void;
  };
};

for (const preview of ["pdf", "markdown"] as const) {
  test(`Locate highlight in ${preview} expires while the pointer moves`, async ({
    page,
  }) => {
    const isPdf = preview === "pdf";
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/?debug=comment-workspace${isPdf ? "&pdf" : ""}`);
    const surface = isPdf
      ? page
      : page.frameLocator('[data-testid="markdown-preview"] iframe');
    await expect(
      surface.locator(isPdf ? ".mupdf-text-layer" : "#write").first(),
    ).toBeVisible();

    const sync = page.getByTestId("sync-navigation-control");
    if ((await sync.getAttribute("data-scroll-sync-linked")) === "true")
      await sync
        .getByRole("button", { name: "Disable synchronized scrolling" })
        .click();
    await sync
      .getByRole("button", {
        name: `Locate ${isPdf ? "PDF" : "preview"} position`,
        exact: true,
      })
      .click();

    const marker = surface.locator(`[data-navigation-highlight="${preview}"]`);
    await expect(marker).toBeInViewport();
    const { x, y, width, height } = (await marker.boundingBox())!;
    let across = false;
    await expect
      .poll(
        async () => {
          across = !across;
          await page.mouse.move(
            x + width * (across ? 0.25 : 0.75),
            y + height / 2,
          );
          return marker.count();
        },
        { intervals: [40], timeout: 1900 },
      )
      .toBe(0);
  });
}

test("Duet workspace expands a live panel and restores the split and chat draft", async ({
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
  const chat = page.locator('[data-workspace-chat-pane="true"]');
  const input = chat.locator("textarea");
  await expect(input).toBeVisible();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect(chat.locator("[data-chat-composer-shell]")).toHaveAttribute(
    "data-composer-transfer-phase",
    "idle",
  );
  await expect(page.locator("[data-chat-drawer-overlay]")).toHaveCount(0);
  await input.fill("Keep this draft");
  await expect(input).toHaveValue("Keep this draft");
  await page
    .getByRole("button", { name: "Click to jump to page", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Page number", exact: true })
    .fill("3");
  await page
    .getByRole("textbox", { name: "Page number", exact: true })
    .press("Enter");
  const currentPage = page.locator("[data-pdf-page-current]").first();
  await expect(currentPage).toHaveText("3");
  const pdfScroller = await page
    .getByTestId("pdf-scroll-container")
    .elementHandle();
  const initial = await chat.boundingBox();
  for (const label of ["PDF", "Chat"]) {
    await page
      .getByRole("button", { name: `Expand ${label}`, exact: true })
      .click();
    const expanded = page.getByRole("dialog", {
      name: `${label} expanded`,
      exact: true,
    });
    await expect(expanded).toBeVisible();
    if (label === "PDF") {
      await expect(currentPage).toHaveText("3");
      expect(
        await pdfScroller!.evaluate((element) => element.isConnected),
      ).toBe(true);
    }
    await expect(expanded).not.toHaveAttribute(
      "data-panel-expansion-motion",
      /.+/,
    );
    const bounds = await expanded.boundingBox();
    expect(bounds!.x).toBe(12);
    expect(bounds!.y).toBe(36);
    expect(bounds!.width).toBe(1416);
    expect(bounds!.height).toBe(852);
    await page.screenshot({
      path: test.info().outputPath(`expanded-${label}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(expanded).toHaveCount(0);
    await expect(input).toHaveValue("Keep this draft");
    await expect(currentPage).toHaveText("3");
    expect((await chat.boundingBox())!.width).toBeCloseTo(initial!.width, 0);
  }
  await page
    .getByRole("tablist", { name: "Chat workspace content" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand Editor", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "Editor expanded",
    exact: true,
  });
  await expect(editor.locator("[data-editor-toolbar]")).toHaveCount(0);
  await expect(editor.getByTestId("latex-editor-toolbar")).toBeVisible();
  await expect(editor.locator(".cm-content")).toBeVisible();
  await expect(editor).not.toHaveAttribute("data-panel-expansion-motion");
  await page.screenshot({
    path: test.info().outputPath("expanded-editor.png"),
  });
  await page
    .getByRole("button", { name: "Restore Editor", exact: true })
    .click();
  await expect(editor).toHaveCount(0);
  await expect(input).toHaveValue("Keep this draft");
  expect((await chat.boundingBox())!.width).toBeCloseTo(initial!.width, 0);
});

const editorHighlight = (page: Page) =>
  page.locator('[data-navigation-highlight="editor"]');
const pdfHighlight = (page: Page) =>
  page.locator('[data-navigation-highlight="pdf"]');

test("Full chat follows PDF reading points and restores both sides without drift", async ({
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
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  const editor = page.locator(".cm-scroller");
  const pdf = page.getByTestId("pdf-scroll-container");
  const settle = async () => {
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await page.waitForTimeout(600);
  };
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await page.evaluate(() => {
    const win = window as ScrollSyncProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const probe = {
      lines: [] as number[],
      inverse: [] as { page: number; y: number }[],
    };
    win.__scrollSyncProbe = probe;
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_view") {
        probe.lines.push(Number(args?.line));
        return { page: 3, x: 100, y: 300 };
      }
      if (cmd === "synctex_edit") {
        probe.inverse.push({ page: Number(args?.page), y: Number(args?.y) });
        return { file: "sample.tex", line: 90, column: 1 };
      }
      return invoke(cmd, args);
    };
  });
  await setLocateSourceLine(page, 45);
  await editor.evaluate((el) => {
    el.scrollTop += 800;
  });
  await expect(editor.locator(".cm-activeLine")).not.toBeInViewport();
  const readingLine = await editor.evaluate((scroller) => {
    const center =
      scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    const line = Array.from(
      scroller.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
    ).find((element) => {
      const { top, bottom } = element.getBoundingClientRect();
      return top <= center && center < bottom;
    });
    return Number(line?.textContent);
  });
  expect(readingLine).toBeGreaterThan(45);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(pdfHighlight(page)).toBeInViewport();
  await expect
    .poll(() => pdf.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  const pdfScroll = await pdf.evaluate((el) => {
    const bounds = el.getBoundingClientRect();
    const page = el
      .querySelector('[data-page-number="3"]')!
      .getBoundingClientRect();
    el.scrollTop +=
      page.top + page.height / 5 - bounds.top - el.clientHeight / 2;
    return el.scrollTop;
  });
  await switchToEditorWithoutScroll(page);
  await expect
    .poll(() => editor.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(2500);
  const editorScroll = await editor.evaluate((el) => el.scrollTop);
  for (let count = 0; count < 3; count++) {
    await mode.getByRole("tab", { name: "PDF", exact: true }).click();
    await expect(pdfHighlight(page)).toBeInViewport();
    expect(await pdf.evaluate((el) => el.scrollTop)).toBe(pdfScroll);
    await switchToEditorWithoutScroll(page);
    expect(await editor.evaluate((el) => el.scrollTop)).toBe(editorScroll);
  }
  const { lines, inverse } = await page.evaluate(
    () => (window as ScrollSyncProbeWindow).__scrollSyncProbe,
  );
  expect(lines).toEqual([readingLine]);
  expect(inverse).toHaveLength(1);
  expect(inverse?.[0].page).toBe(3);
  // The demo is Letter size. The selected reading point is one fifth down the page.
  expect(Math.abs(inverse![0].y - 792 / 5)).toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("vibe-scroll-sync.png"),
  });
});

async function switchToEditorWithoutScroll(page: Page) {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollTop",
    )!;
    const editor = document.querySelector<HTMLElement>(".cm-scroller")!;
    const column = editor.closest<HTMLElement>("[data-panel]")!;
    editor.dataset.visibleScrollWrites = "";
    Object.defineProperty(editor, "scrollTop", {
      configurable: true,
      get: () => descriptor.get!.call(editor),
      set: (value: number) => {
        const previous = descriptor.get!.call(editor);
        descriptor.set!.call(editor, value);
        const current = descriptor.get!.call(editor);
        if (column.clientWidth > 1 && current !== previous)
          editor.dataset.visibleScrollWrites += `${current} `;
      },
    });
  });
  await page
    .getByRole("tablist", { name: "Chat workspace content" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  await expect(editorHighlight(page)).toBeInViewport();
  const writes = await page
    .locator(".cm-scroller[data-visible-scroll-writes]")
    .evaluate((editor: HTMLElement) => {
      Reflect.deleteProperty(editor, "scrollTop");
      const positions = editor.dataset.visibleScrollWrites;
      delete editor.dataset.visibleScrollWrites;
      return positions;
    });
  expect(writes).toBe("");
}

async function setLocateSourceLine(page: Page, line: number) {
  await page.evaluate(async (lineNumber) => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    const state = useDocumentStore.getState();
    const file = state.files.find(({ id }) => id === state.activeFileId);
    const start =
      file.content
        .split("\n")
        .slice(0, lineNumber - 1)
        .join("\n").length + 1;
    const { isNavigationScrolling } = await import(
      "/src/renderer/lib/navigation-scroll.ts"
    );
    state.requestJumpToPosition(start);
    const editor = document.querySelector<HTMLElement>(".cm-scroller")!;
    await new Promise<void>((resolve) => {
      const settled = () => {
        if (
          useDocumentStore.getState().jumpToPosition === null &&
          !isNavigationScrolling(editor)
        )
          resolve();
        else requestAnimationFrame(settled);
      };
      requestAnimationFrame(settled);
    });
  }, line);
}

test("Full chat ignores an old PDF Locate result after switching again", async ({
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
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  const pdf = page.getByTestId("pdf-scroll-container");
  const settle = async () => {
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    await page.waitForTimeout(600);
  };
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await page.evaluate(() => {
    const win = window as ScrollSyncProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    const probe: ScrollSyncProbeWindow["__scrollSyncProbe"] = { lines: [] };
    win.__scrollSyncProbe = probe;
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_view") {
        probe.lines.push(Number(args?.line));
        if (probe.lines.length === 1) {
          return new Promise((resolve) => {
            probe.release = () => resolve({ page: 1, x: 100, y: 0 });
          });
        }
        return { page: 3, x: 100, y: 300 };
      }
      // This test isolates forward mapping; reverse mapping is covered above.
      if (cmd === "synctex_edit") return null;
      return invoke(cmd, args);
    };
  });
  await setLocateSourceLine(page, 45);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ScrollSyncProbeWindow).__scrollSyncProbe.lines.length,
      ),
    )
    .toBe(1);

  // Leave while the first native lookup is still pending, then scroll elsewhere.
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await settle();
  await setLocateSourceLine(page, 85);
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await settle();
  await expect
    .poll(() => pdf.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(500);
  const lines = await page.evaluate(
    () => (window as ScrollSyncProbeWindow).__scrollSyncProbe.lines,
  );
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.at(-1)).toBeGreaterThan(lines[0]);
  const latestScroll = await pdf.evaluate((element) => element.scrollTop);
  await page.evaluate(() =>
    (window as ScrollSyncProbeWindow).__scrollSyncProbe.release?.(),
  );
  await page.waitForTimeout(500);
  expect(await pdf.evaluate((element) => element.scrollTop)).toBeCloseTo(
    latestScroll,
    0,
  );
  await page.screenshot({
    path: test.info().outputPath("vibe-scroll-sync-latest.png"),
  });

  await page.evaluate(() => {
    const win = window as ScrollSyncProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_edit") {
        return new Promise((resolve) => {
          win.__scrollSyncProbe.releaseInverse = () =>
            resolve({ file: "sample.tex", line: 90, column: 1 });
        });
      }
      return invoke(cmd, args);
    };
  });
  await pdf.evaluate((el) => {
    el.scrollTop += 200;
  });
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await page.waitForFunction(
    () => !!(window as ScrollSyncProbeWindow).__scrollSyncProbe.releaseInverse,
  );
  await page.locator('[data-sidebar-file-id="manuscript.md"]').click();
  await expect(
    mode.getByRole("tab", { name: "Preview", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.evaluate(() =>
    (window as ScrollSyncProbeWindow).__scrollSyncProbe.releaseInverse?.(),
  );
  await page.waitForTimeout(200);
  await expect(
    mode.getByRole("tab", { name: "Preview", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(editorHighlight(page)).toHaveCount(0);
});

test("Full chat highlights and restores exact Markdown positions with live sync off", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  const frame = page.frameLocator('[data-testid="markdown-preview"] iframe');
  await expect(frame.locator("#write")).toBeVisible();
  await page.evaluate(async () => {
    const documentPath = "/src/renderer/stores/document-store.ts";
    const settingsPath = "/src/renderer/stores/settings-store.ts";
    const { useDocumentStore } = await import(documentPath);
    const { useSettingsStore } = await import(settingsPath);
    const state = useDocumentStore.getState();
    state.updateFileContent(
      state.activeFileId,
      Array.from(
        { length: 85 },
        (_, i) => `# Section ${i}\n\nParagraph ${i}.\n`,
      ).join("\n"),
    );
    useSettingsStore
      .getState()
      .setFileScrollSync(state.projectRoot, state.activeFileId, false);
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await expect(editorHighlight(page)).toBeInViewport();
  await setLocateSourceLine(page, 161);
  await mode.getByRole("tab", { name: "Preview", exact: true }).click();
  const highlight = frame.locator('[data-navigation-highlight="markdown"]');
  await expect(highlight).toBeInViewport();
  await expect(
    frame.getByRole("heading", { name: "Section 40", exact: true }),
  ).toBeInViewport();

  const heading = frame.getByRole("heading", {
    name: "Section 65",
    exact: true,
  });
  await heading.evaluate((element) => {
    const { top, height } = element.getBoundingClientRect();
    const viewport = element.ownerDocument.documentElement;
    element.ownerDocument.scrollingElement!.scrollTop +=
      top + (height - viewport.clientHeight) / 2;
  });
  await expect
    .poll(() =>
      heading.evaluate((element) => {
        const { top, height } = element.getBoundingClientRect();
        return Math.abs(
          top +
            (height - element.ownerDocument.documentElement.clientHeight) / 2,
        );
      }),
    )
    .toBeLessThan(1);
  const markdownScroll = await frame
    .locator("html")
    .evaluate((el) => el.scrollTop);
  await switchToEditorWithoutScroll(page);
  await expect(
    page.locator(".cm-line").getByText("# Section 65", { exact: true }),
  ).toBeInViewport();
  const editor = page.locator(".cm-scroller");
  const editorScroll = await editor.evaluate((el) => el.scrollTop);
  for (let count = 0; count < 3; count++) {
    await mode.getByRole("tab", { name: "Preview", exact: true }).click();
    await expect(highlight).toBeInViewport();
    expect(await frame.locator("html").evaluate((el) => el.scrollTop)).toBe(
      markdownScroll,
    );
    await switchToEditorWithoutScroll(page);
    expect(await editor.evaluate((el) => el.scrollTop)).toBe(editorScroll);
  }
});

test("Full chat highlights the PDF reading point when there is no mapping", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.evaluate(() => {
    const win = window as ScrollSyncProbeWindow;
    const invoke = win.__TAURI_INTERNALS__.invoke;
    win.__scrollSyncProbe = { lines: [] };
    win.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "synctex_edit") return null;
      if (cmd === "synctex_view") {
        win.__scrollSyncProbe.lines.push(Number(args?.line));
        return null;
      }
      return invoke(cmd, args);
    };
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  await mode.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await setLocateSourceLine(page, 50);
  const pdf = mode.getByRole("tab", { name: "PDF", exact: true });
  await pdf.click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as ScrollSyncProbeWindow).__scrollSyncProbe.lines,
      ),
    )
    .toContain(50);
  await expect(pdf).toHaveAttribute("aria-selected", "true");
  await expect(pdfHighlight(page)).toBeInViewport();
});
