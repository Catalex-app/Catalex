import { expect, test } from "@playwright/test";

interface TransitionCheck {
  name: string;
  pass: boolean;
  maxOverlapPx: number;
  targetHeightDeltaPx: number;
  distinctTargetHeights: number;
  frameCount: number;
}

interface HarnessReport {
  pass: boolean;
  checks: TransitionCheck[];
  finishedAtIso: string;
}

declare global {
  interface Window {
    __runSidebarAnimationHarness?: () => Promise<HarnessReport>;
    __sidebarAnimationHarnessReport?: HarnessReport;
    __setSidebarPendingReview?: (pending: boolean) => void;
  }
}

test("files awaiting AI review use a green pending state", async ({ page }) => {
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });

  const pendingFile = page.locator('[data-sidebar-file-id="references.bib"]');
  const pendingFileName = pendingFile.getByText("references.bib", {
    exact: true,
  });
  await pendingFile.scrollIntoViewIfNeeded();
  await expect(pendingFile).toBeVisible();
  await expect(pendingFile).toHaveAttribute("data-pending-ai-review", "true");
  await pendingFile.hover();
  await expect(
    page.getByRole("tooltip", { name: "Awaiting AI review", exact: true }),
  ).toBeVisible();
  await expect(pendingFileName).toHaveClass(/text-emerald-700/);
  expect(
    await pendingFileName.evaluate(
      (element) => getComputedStyle(element).color,
    ),
  ).not.toBe(
    await page
      .locator('[data-sidebar-file-id="main.tex"]')
      .getByText("main.tex", { exact: true })
      .evaluate((element) => getComputedStyle(element).color),
  );
  await expect(
    page.locator('[data-sidebar-file-id="main.tex"]'),
  ).not.toHaveAttribute("data-pending-ai-review");

  await page.mouse.move(0, 0);
  await expect(pendingFile).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await pendingFile.click();
  await page.mouse.move(0, 0);
  await expect(pendingFile).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );

  await page.screenshot({
    path: "test-results/sidebar-pending-ai-review.png",
    fullPage: true,
  });

  await page.locator('[data-sidebar-file-id="main.tex"]').click();
  await page.mouse.move(0, 0);
  await expect(pendingFile).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

  await page.evaluate(() => window.__setSidebarPendingReview?.(false));
  await expect(pendingFile).not.toHaveAttribute("data-pending-ai-review");
  await expect(pendingFileName).not.toHaveClass(/text-emerald-700/);
});

test("sidebar file tree shows project-root comments.json", async ({ page }) => {
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByText("comments.json", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/sidebar-comments-file.png",
    fullPage: true,
  });
});

test("assistant modes retain their default themes and feature visibility", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });

  const sidebar = page.locator("[data-workspace-assistant-mode]");
  const modeSwitch = page.getByRole("tablist", {
    name: "Workspace assistant mode",
  });
  const cases = [
    { label: "Artisan", mode: "artisan", screenshot: "artisan" },
    { label: "Duet", mode: "duet", screenshot: "duet" },
  ] as const;
  const initialModeSwitchSize = await modeSwitch.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });

  for (const item of cases) {
    const tab = page.getByRole("tab", { name: item.label, exact: true });
    await tab.click();

    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(modeSwitch).toHaveAttribute("data-active-mode", item.mode);
    await expect(sidebar).toHaveAttribute(
      "data-workspace-assistant-mode",
      item.mode,
    );
    expect(
      await modeSwitch.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    ).toEqual(initialModeSwitchSize);
    await page.waitForTimeout(220);

    expect(
      await sidebar.evaluate(
        (element) => getComputedStyle(element, "::after").boxShadow,
      ),
    ).toBe("none");

    const systemPromptsSection = sidebar.locator(
      '[data-sidebar-section="system-prompts"]',
    );
    if (item.mode === "artisan") {
      await expect(systemPromptsSection).toHaveCount(0);
    } else {
      await expect(systemPromptsSection).toBeVisible();
    }

    const backgroundImage = await tab.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    );
    if (item.mode === "artisan") {
      expect(backgroundImage).toContain("linear-gradient");
    } else {
      expect(backgroundImage).toBe("none");
    }

    if (item.mode === "artisan") {
      expect(
        await tab
          .locator("span")
          .evaluate((element) => getComputedStyle(element, "::before").content),
      ).toBe('""');
    }

    await sidebar.screenshot({
      path: `test-results/assistant-mode-${item.screenshot}.png`,
    });
  }

  await page.getByRole("tab", { name: "Artisan", exact: true }).click();
  await page.waitForTimeout(220);
  expect(
    await modeSwitch.evaluate((element) => getComputedStyle(element).padding),
  ).toBe("4px");
  expect(
    await modeSwitch.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await modeSwitch.evaluate((element) => getComputedStyle(element).boxShadow),
  ).toBe("none");
  const artisanModeTab = page.getByRole("tab", {
    name: "Artisan",
    exact: true,
  });
  const duetModeTab = page.getByRole("tab", {
    name: "Duet",
    exact: true,
  });
  const buttonDepth = await modeSwitch.evaluate((element) => {
    const selected = element.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    const raised = element.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="false"]',
    );
    const switchRect = element.getBoundingClientRect();
    const selectedRect = selected?.getBoundingClientRect();
    const raisedRect = raised?.getBoundingClientRect();

    return {
      switchHeight: switchRect.height,
      selectedHeight: selectedRect?.height,
      raisedHeight: raisedRect?.height,
      selectedTop: selectedRect?.top,
      raisedTop: raisedRect?.top,
    };
  });
  expect(buttonDepth).toEqual({
    switchHeight: 36,
    selectedHeight: 28,
    raisedHeight: 28,
    selectedTop: buttonDepth.raisedTop,
    raisedTop: buttonDepth.raisedTop,
  });
  expect(
    await artisanModeTab.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(246, 246, 242)");
  expect(
    await artisanModeTab.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    ),
  ).toBe("9px 0px 0px 9px");
  expect(
    await artisanModeTab.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(32, 33, 30)");
  expect(
    await artisanModeTab.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).toContain("inset");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(248, 248, 245)");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    ),
  ).toContain("linear-gradient");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).not.toContain("inset");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element, "::before").opacity,
    ),
  ).toBe("0");
  await duetModeTab.hover();
  await page.waitForTimeout(180);
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).toContain("inset");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element, "::before").opacity,
    ),
  ).toBe("1");
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).borderColor,
    ),
  ).toBe("rgb(119, 120, 114)");
  expect(
    await duetModeTab.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderLeftWidth),
    ),
  ).toBe(1);
  expect(
    await duetModeTab.evaluate(
      (element) => getComputedStyle(element).borderRadius,
    ),
  ).toBe("0px 9px 9px 0px");
  const lightContrastRatio = await page
    .getByRole("tab", { name: "Artisan", exact: true })
    .evaluate((element) => {
      const parseColor = (value: string) =>
        (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (channels: number[]) => {
        const linear = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foreground = luminance(
        parseColor(getComputedStyle(element.querySelector("span")!).color),
      );
      const background = luminance(
        parseColor(getComputedStyle(element).backgroundColor),
      );
      return (
        (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      );
    });
  expect(lightContrastRatio).toBeGreaterThanOrEqual(4.5);

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(220);
  const artisanTab = page.getByRole("tab", {
    name: "Artisan",
    exact: true,
  });
  expect(
    await artisanTab.evaluate(
      (element) => getComputedStyle(element).borderColor,
    ),
  ).toBe("rgb(27, 28, 26)");
  expect(
    await artisanTab.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    ),
  ).toBe("rgb(34, 35, 33)");
  expect(
    await artisanTab.evaluate((element) => getComputedStyle(element).color),
  ).toBe("rgb(244, 244, 241)");
  expect(
    await artisanTab
      .locator("span")
      .evaluate(
        (element) => getComputedStyle(element, "::before").backgroundColor,
      ),
  ).toBe("rgb(251, 146, 60)");
  await sidebar.screenshot({
    path: "test-results/assistant-mode-artisan-dark.png",
  });
});

test("sidebar animation harness passes overlap and motion checks", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleMessages: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message);
  });
  page.on("console", (message) => {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
  });

  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });

  await page.waitForTimeout(1500);
  const hasHarnessFn = await page.evaluate(
    () => typeof window.__runSidebarAnimationHarness === "function",
  );
  if (!hasHarnessFn) {
    const debugInfo = await page.evaluate(() => ({
      readyState: document.readyState,
      bodyText: document.body?.innerText?.slice(0, 400) ?? "",
      location: window.location.href,
    }));
    throw new Error(
      `Harness bootstrap missing. pageErrors=${JSON.stringify(pageErrors)} console=${JSON.stringify(consoleMessages)} debug=${JSON.stringify(debugInfo)}`,
    );
  }

  const report = await page.evaluate(async () => {
    return await window.__runSidebarAnimationHarness?.();
  });

  expect(
    pageErrors,
    `page errors: ${JSON.stringify(pageErrors, null, 2)}`,
  ).toEqual([]);
  expect(report).toBeTruthy();
  expect(report?.checks.length ?? 0).toBeGreaterThan(0);

  const failedChecks = (report?.checks ?? []).filter((check) => !check.pass);
  expect(
    failedChecks,
    `failed checks: ${JSON.stringify(failedChecks, null, 2)}`,
  ).toEqual([]);
  expect(report?.pass).toBe(true);
});

test("sidebar sections align their rows and keep header actions separate", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 1100 });
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });
  const sidebar = page.locator("[data-workspace-assistant-mode]");
  await expect(sidebar).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(250); // Finish fixture effects before injecting section data.
  await page.evaluate(async () => {
    const zoteroModule = "/src/renderer/stores/zotero-store.ts";
    const { useZoteroStore } = await import(zoteroModule);
    useZoteroStore.setState({
      isAuthenticated: true,
      apiKey: null,
      collections: [
        { key: "sample", name: "References", parentKey: false, itemCount: 4 },
      ],
    });
    const documentModule = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(documentModule);
    const store = useDocumentStore.getState();
    useDocumentStore.setState({
      files: [
        ...store.files,
        {
          id: "chapters/intro.tex",
          name: "intro.tex",
          relativePath: "chapters/intro.tex",
          absolutePath: "/tmp/harness/chapters/intro.tex",
          type: "tex",
          content: "",
          isDirty: false,
        },
      ],
      folders: ["chapters"],
    });
  });
  for (const section of ["system-prompts", "comment-visibility", "zotero"]) {
    const toggle = sidebar.locator(`[data-sidebar-toggle="${section}"]`);
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
  }
  const filesToggle = sidebar.locator('[data-sidebar-toggle="files"]');
  await expect(filesToggle).toHaveAttribute("aria-expanded", "true");
  await sidebar
    .locator('[data-sidebar-section="files"]')
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "New Folder" }),
  ).toBeVisible();
  await expect(filesToggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await filesToggle.focus();
  await page.keyboard.press("Space");
  await expect(filesToggle).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(filesToggle).toHaveAttribute("aria-expanded", "true");

  const folder = sidebar.getByRole("button", { name: "chapters", exact: true });
  await folder.click();
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  const nestedFile = sidebar.locator(
    '[data-sidebar-file-id="chapters%2Fintro.tex"]',
  );
  await expect(nestedFile).toBeVisible();
  expect((await folder.boundingBox())!.height).toBe(
    (await nestedFile.boundingBox())!.height,
  );
  const folderIcon = await folder
    .locator("[data-sidebar-row-icon]")
    .boundingBox();
  const fileIcon = await nestedFile
    .locator("[data-sidebar-row-icon]")
    .boundingBox();
  expect(fileIcon!.x - folderIcon!.x).toBe(16);
  const folderGuide = sidebar.locator("[data-folder-guide]");
  await expect(folderGuide).toHaveCount(1);
  const guideBounds = (await folderGuide.boundingBox())!;
  expect(guideBounds.x + guideBounds.width / 2).toBe(
    folderIcon!.x + folderIcon!.width / 2,
  );
  await sidebar.screenshot({ path: "test-results/sidebar-folder-guides.png" });
  await folder.click();
  await expect(nestedFile).toHaveCount(0);
  await expect(folderGuide).toHaveCount(0);
  for (const width of [360, 240]) {
    await sidebar.evaluate((element, width) => {
      const panel = element.parentElement?.parentElement;
      if (panel) panel.style.width = `${width}px`;
    }, width);
    for (const theme of ["modern", "classic"]) {
      for (const dark of [false, true]) {
        await page.evaluate(
          ({ theme, dark }) => {
            document.documentElement.dataset.uiTheme = theme;
            document.documentElement.classList.toggle("dark", dark);
          },
          { theme, dark },
        );
        await page.waitForTimeout(230);
        const geometry = await sidebar.evaluate((root) => {
          const iconLeft = (selector: string) =>
            root
              .querySelector(`${selector} [data-sidebar-row-icon]`)
              ?.getBoundingClientRect().left;
          const lefts = [
            iconLeft('[data-sidebar-file-id="main.tex"]'),
            iconLeft(
              '[data-sidebar-section="system-prompts"] [data-sidebar-row]',
            ),
            iconLeft(
              '[data-sidebar-section="comment-visibility"] [role="switch"]',
            ),
            iconLeft('[aria-label="Settings"]'),
            iconLeft('[data-sidebar-section="zotero"] [data-sidebar-row]'),
          ];
          const collisions = Array.from(
            root.querySelectorAll("[data-sidebar-header]"),
          ).some((header) => {
            const title = header
              .querySelector(".truncate")
              ?.getBoundingClientRect();
            const actions = header
              .querySelector("[data-sidebar-header-actions]")
              ?.getBoundingClientRect();
            return title && actions && title.right > actions.left;
          });
          return {
            lefts,
            collisions,
            overflow: root.scrollWidth > root.clientWidth,
          };
        });
        expect(
          geometry.lefts.every((left) => typeof left === "number"),
          JSON.stringify({ width, theme, dark, geometry }),
        ).toBe(true);
        const lefts = geometry.lefts as number[];
        expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(
          0.5,
        );
        expect(geometry.collisions).toBe(false);
        expect(geometry.overflow).toBe(false);
        await sidebar.screenshot({
          path: `test-results/sidebar-layout-${width}-${theme}-${dark ? "dark" : "light"}.png`,
        });
      }
    }
  }
});

test("LaTeX outline uses fixed-width numbers with independent folding and navigation", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.locator('[data-sidebar-file-id="main.tex"]')).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.waitForTimeout(250); // Allow fixture effects to finish before replacing its content.
  await page.evaluate(async () => {
    const modulePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(modulePath);
    const state = useDocumentStore.getState();
    useDocumentStore.setState({
      files: state.files.map((file: { id: string }) =>
        file.id === "main.tex"
          ? {
              ...file,
              content:
                "\\section{Introduction}\n\\subsection{Method}\n\\subsubsection{Details}\n\\section{Results}",
            }
          : file,
      ),
      jumpToPosition: null,
    });
  });
  const outline = page.locator('[data-sidebar-section="outline"]');
  const rows = outline.locator("[data-sidebar-row]");
  await expect(rows).toHaveCount(4);
  const markers = outline.locator("[data-sidebar-row-icon]");
  const firstMarker = await markers.first().boundingBox();
  const fileMarker = await page
    .locator('[data-sidebar-file-id="main.tex"] [data-sidebar-row-icon]')
    .boundingBox();
  expect(firstMarker!.x + firstMarker!.width / 2).toBe(
    fileMarker!.x + fileMarker!.width / 2,
  );
  expect(firstMarker!.width).toBe(20);
  const numberToggle = outline.getByRole("button", {
    name: "Collapse Introduction",
    exact: true,
  });
  expect((await numberToggle.boundingBox())!.width).toBe(24);
  await expect(numberToggle).toHaveText("1");
  const numberBounds = (await numberToggle.boundingBox())!;
  const titleButton = outline.getByRole("button", {
    name: "Introduction",
    exact: true,
  });
  const titleBounds = (await titleButton.boundingBox())!;
  expect(titleBounds.x - numberBounds.x - numberBounds.width).toBe(2);
  const titleTextLeft = await titleButton.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return range.getBoundingClientRect().left;
  });
  expect(titleTextLeft - numberBounds.x - numberBounds.width).toBe(8);
  const shortNumber = markers.nth(1).locator("span");
  expect(
    await shortNumber.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const longNumber = markers.nth(2).locator("span");
  await expect(longNumber).toHaveText("1.1.1");
  const fittedNumber = await longNumber.evaluate((el) => ({
    width: el.getBoundingClientRect().width,
    available: el.parentElement!.getBoundingClientRect().width,
    overflow: getComputedStyle(el).textOverflow,
    transform: getComputedStyle(el).transform,
  }));
  expect(fittedNumber.width).toBeLessThanOrEqual(fittedNumber.available + 0.1);
  expect(fittedNumber.overflow).not.toBe("ellipsis");
  expect(fittedNumber.transform).not.toBe("none");
  await longNumber.hover();
  await expect(
    page.getByRole("tooltip", { name: "1.1.1", exact: true }),
  ).toBeVisible();
  await numberToggle.click();
  await expect(rows).toHaveCount(2);
  expect(
    await page.evaluate(async () => {
      const modulePath = "/src/renderer/stores/document-store.ts";
      return (await import(modulePath)).useDocumentStore.getState()
        .jumpToPosition;
    }),
  ).toBeNull();
  await outline
    .getByRole("button", { name: "Introduction", exact: true })
    .click();
  await expect(rows).toHaveCount(2);
  await outline
    .getByRole("button", { name: "Expand Introduction", exact: true })
    .click();
  await expect(rows).toHaveCount(4);
  await outline.getByRole("button", { name: "Details", exact: true }).click();
  expect(
    await page.evaluate(async () => {
      const modulePath = "/src/renderer/stores/document-store.ts";
      return (await import(modulePath)).useDocumentStore.getState()
        .jumpToPosition;
    }),
  ).toBe("\\section{Introduction}\n\\subsection{Method}\n".length);
  await page.evaluate(async () => {
    const modulePath = "/src/renderer/stores/document-store.ts";
    const store = (await import(modulePath)).useDocumentStore;
    store.getState().setCursorPosition(store.getState().jumpToPosition);
  });
  await expect(
    outline.getByRole("button", { name: "Details", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await outline
    .getByRole("button", { name: "Collapse Method", exact: true })
    .click();
  await expect(
    outline.getByRole("button", { name: "Method", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await outline
    .getByRole("button", { name: "Expand Method", exact: true })
    .click();
  await expect(
    outline.getByRole("button", { name: "Details", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  await outline.screenshot({ path: "test-results/latex-outline.png" });
});
