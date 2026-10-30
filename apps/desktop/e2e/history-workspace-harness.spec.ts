import { expect, type Locator, type Page, test } from "@playwright/test";

async function openHistory(page: Page, query = "") {
  await page.goto(`/?debug=history-workspace${query}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(
    page.getByTestId("history-workspace-harness-shell"),
  ).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(
    page.getByTestId("history-workspace-harness-shell"),
  ).toHaveAttribute("data-media-ready", "true");
  await page.getByRole("button", { name: /^(History|Rewind)$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Project rewind",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("history-snapshot-newest")).toBeVisible();
  return dialog;
}

async function expectRenderedPdf(pane: Locator, text: string) {
  await expect(pane.locator(".mupdf-text-layer").first()).toContainText(text);
  const canvas = pane.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const target = element as HTMLCanvasElement;
        const context = target.getContext("2d");
        if (!context || target.width <= 0 || target.height <= 0) return false;
        const pixels = context.getImageData(
          0,
          0,
          target.width,
          target.height,
        ).data;
        for (let offset = 3; offset < pixels.length; offset += 4) {
          if (pixels[offset] > 0) return true;
        }
        return false;
      }),
    )
    .toBe(true);
}

async function waitForPdfCapture(pane: Locator) {
  const canvas = pane.locator("canvas").first();
  let previousRaster: string | null = null;
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const raster = await canvas.evaluate((element) => {
          const target = element as HTMLCanvasElement;
          const rect = target.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          if (
            Math.abs(target.width - rect.width * dpr) > 1 ||
            Math.abs(target.height - rect.height * dpr) > 1
          )
            return null;
          const context = target.getContext("2d");
          if (!context || !target.width || !target.height) return null;
          const pixels = context.getImageData(
            0,
            0,
            target.width,
            target.height,
          ).data;
          let fingerprint = 0;
          for (let offset = 0; offset < pixels.length; offset += 97) {
            fingerprint = (fingerprint * 31 + pixels[offset]) >>> 0;
          }
          return `${target.width}:${target.height}:${fingerprint}`;
        });
        stableSamples =
          raster && raster === previousRaster ? stableSamples + 1 : 0;
        previousRaster = raster;
        return stableSamples;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(3);
  await pane.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function expectSingleHistoryPanel(
  card: Locator,
  kind: "source" | "media",
) {
  await expect(card.locator("[data-history-panel]")).toHaveCount(1);
  await expect(card.locator("[data-history-panel]")).toHaveAttribute(
    "data-history-panel",
    kind,
  );
  await expect(card.locator(".history-content .rounded-panel")).toHaveCount(1);
  await expect(card.getByRole("tablist")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: /^(Source view|Split editor and PDF)$/ }),
  ).toHaveCount(0);
  const radius = await card
    .locator("[data-history-panel]")
    .evaluate((element) =>
      parseFloat(getComputedStyle(element).borderTopLeftRadius),
    );
  expect(radius).toBeGreaterThan(0);
}

async function expectRenderedImage(media: Locator, name = "overview.svg") {
  const image = media.getByRole("img", { name, exact: true });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
}

async function liveWorkspaceState(page: Page) {
  const state = await page.evaluate(() =>
    window.__historyWorkspaceHarness?.readLiveState(),
  );
  expect(state).toBeTruthy();
  return state;
}

test("history reviews the project files and preserves the live workspace on exit", async ({
  page,
}) => {
  await page.goto("/?debug=history-workspace");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(
    page.getByTestId("history-workspace-harness-shell"),
  ).toHaveAttribute("data-media-ready", "true");
  const draft = page.getByRole("textbox", { name: "Live chat draft" });
  await draft.fill("Keep this unsent draft while I inspect earlier versions.");
  const draftElement = await draft.elementHandle();
  const scroll = page.getByTestId("history-live-scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 427;
  });
  const scrollTop = await scroll.evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);

  await page.getByRole("button", { name: /^(History|Rewind)$/ }).click();
  const dialog = page.getByRole("dialog", {
    name: "Project rewind",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("history-snapshot-older").click();
  await expect(dialog.getByTestId("history-snapshot-older")).toHaveAttribute(
    "aria-current",
    "true",
  );
  const card = dialog.getByTestId("history-front-card");
  await expect(card.getByTestId("history-file-main.tex")).toBeVisible();
  await expect(card.getByTestId("history-file-methods.tex")).toBeVisible();
  await expect(card.getByTestId("history-file-obsolete.tex")).toBeVisible();
  await expect(card).toContainText(
    "Our model learns useful representations from observations.",
  );
  await expect(
    page.getByRole("textbox", { name: "Live chat draft" }),
  ).toHaveCount(0);

  await card.getByTestId("history-file-obsolete.tex").click();
  await expect(card.getByTestId("history-file-obsolete.tex")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(card).toContainText(
    "This earlier experiment was removed from the current project.",
  );
  await card
    .getByRole("button", { name: "Restore project version", exact: true })
    .click();
  const confirmation = page.getByRole("group", {
    name: "Confirm restore",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("Restore this version?");
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(confirmation).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.restoreRequests,
    ),
  ).toBe(0);

  await dialog
    .getByRole("button", { name: "Back to present", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(draft).toHaveValue(
    "Keep this unsent draft while I inspect earlier versions.",
  );
  expect(await draftElement?.evaluate((element) => element.isConnected)).toBe(
    true,
  );
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(page.getByTestId("history-live-chat")).toBeVisible();
});

test("rapid timeline navigation never replaces the selected snapshot with a stale response", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&delayDiff");
  await dialog.getByTestId("history-snapshot-older").click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__historyWorkspaceHarness;
        return !!state && state.diffRequests > state.settledDiffRequests;
      }),
    )
    .toBe(true);
  await dialog.getByTestId("history-snapshot-initial").click();
  await expect(dialog.getByTestId("history-snapshot-initial")).toHaveAttribute(
    "aria-current",
    "true",
  );
  const card = dialog.getByTestId("history-front-card");
  await expect(card).toContainText("Initial research outline");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__historyWorkspaceHarness;
        return !!state && state.diffRequests === state.settledDiffRequests;
      }),
    )
    .toBe(true);
  await expect(card).toContainText("Initial research outline");
  await expect(card).not.toContainText(
    "Our model learns useful representations from observations.",
  );
  await expect(dialog.getByTestId("history-snapshot-initial")).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("unreadable history reports the failure and prevents restoration", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&diffFailure");
  await dialog.getByTestId("history-snapshot-older").click();
  await expect(dialog.getByRole("alert")).toContainText(
    "This snapshot could not be read",
  );
  await expect(
    dialog.getByRole("button", {
      name: "Restore project version",
      exact: true,
    }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Live chat draft" }),
  ).toBeVisible();
});

test("Escape closes the label dialog while keeping project history open", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  const dialog = await openHistory(page);
  await dialog
    .getByRole("button", { name: "Snapshot details", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Label snapshot", exact: true })
    .click();
  const labelDialog = page.getByRole("dialog", {
    name: "Snapshot labels",
    exact: true,
  });
  await expect(labelDialog).toBeVisible();
  await labelDialog
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Unfinished label");
  await expect(labelDialog).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Snapshot label" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(labelDialog).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("history-snapshot-newest")).toHaveAttribute(
    "aria-current",
    "true",
  );
});

test("restoration stays blocked when a background agent starts during review", async ({
  page,
}) => {
  const dialog = await openHistory(page);
  await dialog.getByTestId("history-snapshot-older").click();
  const restore = dialog
    .getByTestId("history-front-card")
    .getByRole("button", { name: "Restore project version", exact: true });
  await expect(restore).toBeEnabled();
  const setAgentRunning = async (running: boolean) => {
    await page.evaluate((isStreaming) => {
      if (!window.__historyWorkspaceHarness)
        throw new Error("History harness is unavailable");
      window.__historyWorkspaceHarness.setAgentRunning(isStreaming);
    }, running);
  };

  await setAgentRunning(true);
  await expect(restore).toBeDisabled();
  await restore.hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Wait for the agent to finish before restoring this project.",
      exact: true,
    }),
  ).toBeVisible();
  await setAgentRunning(false);
  await expect(restore).toBeEnabled();
  await restore.click();
  const confirmation = page.getByRole("group", {
    name: "Confirm restore",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await setAgentRunning(true);
  await expect(page.getByRole("alert")).toContainText(
    "Wait for the agent to finish",
  );
  await expect(
    confirmation.getByRole("button", {
      name: "Confirm",
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.restoreRequests,
    ),
  ).toBe(0);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Back to present", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__historyWorkspaceHarness?.anyAgentRunning(),
    ),
  ).toBe(true);
});

for (const reducedMotion of [false, true]) {
  test(`history entry motion ${reducedMotion ? "honors reduced motion" : "shrinks the workspace without rotating cards"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.emulateMedia({
      reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    await page.goto("/?debug=history-workspace");
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    await expect(
      page.getByTestId("history-workspace-harness-shell"),
    ).toHaveAttribute("data-media-ready", "true");
    await expect(
      page.getByRole("button", { name: /^(History|Rewind)$/ }),
    ).toBeEnabled();
    const frames = await page.evaluate(async () => {
      const live = document.querySelector<HTMLElement>(
        ".history-live-workspace",
      );
      const trigger = document.querySelector<HTMLButtonElement>(
        ".workspace-history-control",
      );
      if (!live || !trigger) throw new Error("History harness is not ready");
      const samples: Array<{
        elapsed: number;
        liveScale: number;
        cardScale: number;
        maximumRotation: number;
        cardBounds: { x: number; y: number; right: number; bottom: number };
        runningAnimations: number;
        runningAnimationDetails: string[];
      }> = [];
      const start = performance.now();
      trigger.click();
      await new Promise<void>((resolve) => {
        const sample = () => {
          const card = document.querySelector<HTMLElement>(
            "[data-testid='history-front-card']",
          );
          const overlay = document.querySelector<HTMLElement>(
            ".history-workspace-overlay",
          );
          if (card && overlay) {
            const liveMatrix = new DOMMatrixReadOnly(
              getComputedStyle(live).transform,
            );
            const cardMatrix = new DOMMatrixReadOnly(
              getComputedStyle(card).transform,
            );
            const rect = card.getBoundingClientRect();
            const animations = [
              ...live.getAnimations({ subtree: true }),
              ...overlay.getAnimations({ subtree: true }),
              ...(document
                .querySelector(".history-stage-backdrop")
                ?.getAnimations() ?? []),
            ].filter((animation) => {
              const target = (animation.effect as KeyframeEffect | null)
                ?.target;
              return (
                target instanceof Element &&
                target.matches(
                  ".history-live-workspace, .history-stage-backdrop, .history-workspace-overlay, .history-stage-header, .history-front-card, .history-rear-card",
                )
              );
            });
            samples.push({
              elapsed: performance.now() - start,
              liveScale: liveMatrix.a,
              cardScale: cardMatrix.a,
              maximumRotation: Math.max(
                Math.abs(liveMatrix.b),
                Math.abs(liveMatrix.c),
                Math.abs(cardMatrix.b),
                Math.abs(cardMatrix.c),
              ),
              cardBounds: {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
              },
              runningAnimations: animations.filter(
                (animation) =>
                  animation.playState === "running" &&
                  animation.effect?.getTiming().iterations !== Infinity,
              ).length,
              runningAnimationDetails: animations
                .filter(
                  (animation) =>
                    animation.playState === "running" &&
                    animation.effect?.getTiming().iterations !== Infinity,
                )
                .map((animation) => {
                  const target = (animation.effect as KeyframeEffect | null)
                    ?.target as HTMLElement | null;
                  return `${animation instanceof CSSAnimation ? animation.animationName : animation instanceof CSSTransition ? animation.transitionProperty : "unknown"}: ${target?.className}`;
                }),
            });
          }
          if (performance.now() - start < 650) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    });

    expect(frames.length).toBeGreaterThan(5);
    expect(
      Math.max(...frames.map((frame) => frame.maximumRotation)),
    ).toBeLessThan(0.001);
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame.cardScale).toBeCloseTo(1, 3);
    expect(lastFrame.liveScale).toBeCloseTo(0.86, 3);
    expect(lastFrame.cardBounds.x).toBeGreaterThanOrEqual(0);
    expect(lastFrame.cardBounds.y).toBeGreaterThanOrEqual(0);
    expect(lastFrame.cardBounds.right).toBeLessThanOrEqual(1440);
    expect(lastFrame.cardBounds.bottom).toBeLessThanOrEqual(1024);
    expect(
      lastFrame.runningAnimations,
      JSON.stringify(lastFrame.runningAnimationDetails),
    ).toBe(0);
    if (reducedMotion) {
      expect([
        ...new Set(frames.flatMap((frame) => frame.runningAnimationDetails)),
      ]).toEqual([]);
      expect(
        frames.every((frame) => Math.abs(frame.cardScale - 1) < 0.001),
      ).toBe(true);
      expect(
        frames.every((frame) => Math.abs(frame.liveScale - 0.86) < 0.001),
      ).toBe(true);
    } else {
      expect(
        Math.max(...frames.map((frame) => frame.liveScale)),
      ).toBeGreaterThan(0.9);
      expect(
        Math.max(...frames.map((frame) => frame.cardScale)),
      ).toBeGreaterThan(1.01);
      expect(frames.some((frame) => frame.runningAnimations > 0)).toBe(true);
    }
    await test.info().attach("history-entry-motion", {
      body: JSON.stringify(frames, null, 2),
      contentType: "application/json",
    });
  });
}

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1440, height: 1024 },
    { width: 1000, height: 720 },
  ]) {
    test(`history cards stay upright with contained actions at ${viewport.width}px in ${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const dialog = await openHistory(page, `&theme=${theme}`);
      const card = dialog.getByTestId("history-front-card");
      await expect(card).toBeVisible();
      await expect(card).toContainText(
        "Our revised model learns a compact representation",
      );
      await expectSingleHistoryPanel(card, "source");
      const chrome = await card.evaluate((element) => {
        const header = element.querySelector<HTMLElement>(
          ".history-card-header",
        )!;
        const sidebar = element.querySelector<HTMLElement>(".history-files")!;
        const files = sidebar.firstElementChild!;
        const effectiveBackground = (target: Element): string => {
          let current: Element | null = target;
          while (current) {
            const color = getComputedStyle(current).backgroundColor;
            if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent")
              return color;
            current = current.parentElement;
          }
          return "transparent";
        };
        return {
          headerBorder: getComputedStyle(header).borderBottomWidth,
          sidebarBorder: getComputedStyle(sidebar).borderRightWidth,
          backgrounds: [element, header, sidebar, files].map(
            effectiveBackground,
          ),
          tokens: [element, header, sidebar, files].map((node) =>
            getComputedStyle(node).getPropertyValue("--background").trim(),
          ),
        };
      });
      expect(chrome.headerBorder).toBe("0px");
      expect(chrome.sidebarBorder).toBe("0px");
      expect(new Set(chrome.backgrounds).size).toBe(1);
      expect(new Set(chrome.tokens).size).toBe(1);
      expect(chrome.tokens[0]).not.toBe("");
      await page.screenshot({
        animations: "disabled",
        path: test
          .info()
          .outputPath(`history-${theme}-${viewport.width}-entry.png`),
      });
      await dialog.getByTestId("history-snapshot-older").click();
      await expect(card).toContainText(
        "Our model learns useful representations from observations.",
      );
      const restore = card.getByRole("button", {
        name: "Restore project version",
        exact: true,
      });
      await expect(restore).toBeEnabled();
      await expect(
        card.getByRole("button", {
          name: /^(Close window|Minimize window|Maximize window)$/,
        }),
      ).toHaveCount(0);
      await expect(
        card.locator(
          ".traffic-lights, .window-controls, [data-testid='window-controls']",
        ),
      ).toHaveCount(0);

      await expectSingleHistoryPanel(card, "source");
      await expect(card.locator('[data-history-panel="source"]')).toBeVisible();

      const geometry = await card.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(element).transform,
        );
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          rotationX: matrix.b,
          rotationY: matrix.c,
        };
      });
      expect(Math.abs(geometry.rotationX)).toBeLessThan(0.001);
      expect(Math.abs(geometry.rotationY)).toBeLessThan(0.001);
      expect(geometry.x).toBeGreaterThanOrEqual(0);
      expect(geometry.y).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(viewport.width);
      expect(geometry.bottom).toBeLessThanOrEqual(viewport.height);
      const actionBounds = await restore.boundingBox();
      expect(actionBounds).not.toBeNull();
      expect(actionBounds!.x).toBeGreaterThan(geometry.x);
      expect(actionBounds!.y + actionBounds!.height).toBeLessThanOrEqual(
        geometry.bottom,
      );
      const timelineBounds = await dialog
        .getByTestId("history-snapshot-older")
        .boundingBox();
      expect(timelineBounds).not.toBeNull();
      expect(timelineBounds!.x).toBeGreaterThanOrEqual(geometry.right);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expectSingleHistoryPanel(card, "source");
      await page.screenshot({
        animations: "disabled",
        path: test
          .info()
          .outputPath(`history-${theme}-${viewport.width}-older.png`),
      });
      await card.getByTestId("history-file-overview.svg").click();
      const media = card.getByTestId("history-media-content");
      await expectSingleHistoryPanel(card, "media");
      await expectRenderedImage(media);
      await expect(media).toContainText("Not a historical preview.");
      await page.screenshot({
        animations: "disabled",
        path: test
          .info()
          .outputPath(`history-${theme}-${viewport.width}-image.png`),
      });
      await card.getByTestId("history-file-letter.pdf").click();
      await expectRenderedPdf(media, "Quantum");
      await waitForPdfCapture(media);
      await expectSingleHistoryPanel(card, "media");
      await page.screenshot({
        animations: "disabled",
        path: test
          .info()
          .outputPath(`history-${theme}-${viewport.width}-pdf.png`),
      });
    });
  }
}

test("history opens one read-only source pane with a complete text tree and no automatic compilation", async ({
  page,
}) => {
  const dialog = await openHistory(page);
  const card = dialog.getByTestId("history-front-card");
  await expectSingleHistoryPanel(card, "source");
  await expect(card.locator(".cm-content")).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await expect(card.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await expect(card.getByTestId("history-media-content")).toHaveCount(0);
  await expect(card.locator("canvas")).toHaveCount(0);
  await card.getByRole("button", { name: "sections", exact: true }).click();
  const unchanged = card.getByTestId("history-file-sections/shared.tex");
  await unchanged.click();
  await expect(unchanged).toHaveAttribute("aria-current", "true");
  await expect(card).toContainText(
    "This unchanged nested section belongs to every reviewed manuscript version.",
  );
  await expect(unchanged.getByRole("img")).toHaveCount(0);
  await dialog.getByTestId("history-snapshot-older").click();
  await unchanged.click();
  await expect(card).toContainText(
    "This unchanged nested section belongs to every reviewed manuscript version.",
  );
  await expect(unchanged.getByRole("img")).toHaveCount(0);
  await expectSingleHistoryPanel(card, "source");
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.liveCommandRequests,
    ),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.mediaReadRequests,
    ),
  ).toEqual([]);
});

test("current image selection replaces source with a read-only image and preserves live state", async ({
  page,
}) => {
  const dialog = await openHistory(page);
  const card = dialog.getByTestId("history-front-card");
  const before = await liveWorkspaceState(page);
  const imageFile = card.getByTestId("history-file-overview.svg");
  await expect(imageFile).toContainText("Current");
  await imageFile.getByText("Current", { exact: true }).hover();
  await expect(
    page.getByRole("tooltip", {
      name: "Current project asset. Not a historical preview.",
      exact: true,
    }),
  ).toBeVisible();
  await imageFile.click();
  const media = card.getByTestId("history-media-content");
  await expectSingleHistoryPanel(card, "media");
  await expect(media).toHaveAttribute("data-media-type", "image");
  await expectRenderedImage(media);
  await expect(media).toContainText(
    "Current project asset · Not a historical preview.",
  );
  await expect(card.locator(".cm-editor")).toHaveCount(0);
  await expect(media.locator("canvas")).toHaveCount(0);
  await expect(media.getByRole("button", { name: /crop|save/i })).toHaveCount(
    0,
  );
  await expect(media).not.toContainText("Drag to select crop area");
  await dialog.getByTestId("history-snapshot-older").click();
  await card.getByTestId("history-file-overview.svg").click();
  await expectRenderedImage(media);
  await expect(media).toContainText("Not a historical preview.");
  expect(await liveWorkspaceState(page)).toEqual(before);
  await card.getByTestId("history-file-main.tex").click();
  await expectSingleHistoryPanel(card, "source");
  await expect(media).toHaveCount(0);
  expect(await liveWorkspaceState(page)).toEqual(before);
});

test("current PDF files render alone and PDF interaction preserves live editor, chat, and compile state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const dialog = await openHistory(page);
  const card = dialog.getByTestId("history-front-card");
  await page.evaluate(() => {
    if (!window.__historyWorkspaceHarness)
      throw new Error("History harness is unavailable");
    window.__historyWorkspaceHarness.seedLiveSelection();
  });
  const before = await liveWorkspaceState(page);
  const pdfFile = card.getByTestId("history-file-letter.pdf");
  await expect(pdfFile).toContainText("Current");
  await pdfFile.click();
  const media = card.getByTestId("history-media-content");
  await expectSingleHistoryPanel(card, "media");
  await expect(media).toHaveAttribute("data-media-type", "pdf");
  await expectRenderedPdf(media, "Quantum");
  await expect(media).toContainText(
    "Current project asset · Not a historical preview.",
  );
  await expect(card.locator(".cm-editor")).toHaveCount(0);
  const firstText = media.locator(".mupdf-text-layer text").first();
  await firstText.click();
  await firstText.dblclick();
  const selected = await firstText.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return selection?.toString();
  });
  expect(selected?.trim().length).toBeGreaterThan(0);
  await card.getByTestId("history-file-report.pdf").click();
  await expectRenderedPdf(media, "Computing");
  await expectSingleHistoryPanel(card, "media");
  await expect(
    media.getByRole("button", { name: "Proofread", exact: true }),
  ).toHaveCount(0);
  expect(await liveWorkspaceState(page)).toEqual(before);
  await dialog
    .getByRole("button", { name: "Back to present", exact: true })
    .click();
  expect(await liveWorkspaceState(page)).toEqual(before);
});

test("an unavailable current PDF explains the failure and retry recovers without compiling", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&mediaFailure");
  const card = dialog.getByTestId("history-front-card");
  await card.getByTestId("history-file-report.pdf").click();
  const media = card.getByTestId("history-media-content");
  await expect(media.getByRole("alert")).toContainText(
    "Could not load this PDF",
  );
  await expect(media.getByRole("alert")).toContainText(
    "Current PDF is temporarily unavailable.",
  );
  await expect(media).toContainText("Not a historical preview.");
  await page.evaluate(() =>
    window.__historyWorkspaceHarness?.allowMediaReads(),
  );
  await media.getByRole("button", { name: "Retry PDF", exact: true }).click();
  await expectRenderedPdf(media, "Computing");
  await expect(media.getByRole("alert")).toHaveCount(0);
  const requests = await page.evaluate(
    () => window.__historyWorkspaceHarness?.mediaReadRequests,
  );
  expect(requests?.some((request) => request.status === "failed")).toBe(true);
  expect(requests?.at(-1)?.status).toBe("succeeded");
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.liveCommandRequests,
    ),
  ).toEqual([]);
});

test("stale asynchronous media reads cannot replace a newly selected source or PDF", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&delayMedia");
  const card = dialog.getByTestId("history-front-card");
  const media = card.getByTestId("history-media-content");
  const before = await liveWorkspaceState(page);
  await card.getByTestId("history-file-report.pdf").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__historyWorkspaceHarness?.mediaReadRequests.some(
          (request) =>
            request.path.endsWith("/report.pdf") &&
            request.status === "pending",
        ),
      ),
    )
    .toBe(true);
  await card.getByTestId("history-file-main.tex").click();
  await expectSingleHistoryPanel(card, "source");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__historyWorkspaceHarness;
        return (
          state?.settledMediaReadRequests === state?.mediaReadRequests.length
        );
      }),
    )
    .toBe(true);
  await expect(media).toHaveCount(0);
  await expect(card).toContainText(
    "Our revised model learns a compact representation",
  );
  await card.getByTestId("history-file-report.pdf").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__historyWorkspaceHarness?.mediaReadRequests.some(
          (request) =>
            request.path.endsWith("/report.pdf") &&
            request.status === "pending",
        ),
      ),
    )
    .toBe(true);
  await card.getByTestId("history-file-letter.pdf").click();
  await expectRenderedPdf(media, "Quantum");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__historyWorkspaceHarness;
        return (
          state?.settledMediaReadRequests === state?.mediaReadRequests.length
        );
      }),
    )
    .toBe(true);
  await expect(media).not.toContainText("The Computing Chronicle");
  await expectSingleHistoryPanel(card, "media");
  expect(await liveWorkspaceState(page)).toEqual(before);
});

test("Now previews current unsaved files in place and Back to present exits", async ({
  page,
}) => {
  const dialog = await openHistory(page);
  const card = dialog.getByTestId("history-front-card");
  await page.evaluate(() =>
    window.__historyWorkspaceHarness!.setCurrentMainText(
      "Current unsaved manuscript.",
    ),
  );
  const before = await liveWorkspaceState(page);
  await dialog.getByTestId("history-snapshot-older").click();
  await expect(card.getByTestId("history-file-obsolete.tex")).toBeVisible();
  await card.getByTestId("history-file-obsolete.tex").click();
  await dialog.getByTestId("history-now").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("history-now")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    dialog.locator('.history-timeline-entry[aria-current="true"]'),
  ).toHaveCount(0);
  await expect(
    card.getByRole("toolbar", { name: "Current text", exact: true }),
  ).toBeVisible();
  await expect(card.locator(".cm-content")).toHaveText(
    "Current unsaved manuscript.",
  );
  await expect(card.locator(".cm-content")).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await expect(card.getByTestId("history-file-main.tex")).toContainText(
    "Unsaved",
  );
  await expect(card.getByTestId("history-file-obsolete.tex")).toHaveCount(0);
  await expect(card.getByTestId("history-file-methods.tex")).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Restore project version", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Label snapshot", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Copy snapshot ID", exact: true }),
  ).toHaveCount(0);
  await expect(card.locator(".history-file-legend")).toHaveCount(0);
  expect(await liveWorkspaceState(page)).toEqual(before);
  await page.evaluate(() =>
    window.__historyWorkspaceHarness!.setCurrentMainText(
      "Still unsaved, updated while Now is open.",
    ),
  );
  await expect(card.locator(".cm-content")).toHaveText(
    "Still unsaved, updated while Now is open.",
  );
  const updated = await liveWorkspaceState(page);
  await page.screenshot({
    path: test.info().outputPath("history-now.png"),
    animations: "disabled",
  });
  await card.getByTestId("history-file-overview.svg").click();
  await expectRenderedImage(card.getByTestId("history-media-content"));
  await expect(
    card.getByRole("button", { name: "Restore project version", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Older snapshot", exact: true })
    .click();
  await expect(dialog.getByTestId("history-snapshot-newest")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    card.getByRole("button", { name: "Restore project version", exact: true }),
  ).toBeVisible();
  await card.getByTestId("history-file-main.tex").click();
  await expect(card).toContainText(
    "Our revised model learns a compact representation",
  );
  await dialog
    .getByRole("button", { name: "Newer snapshot", exact: true })
    .click();
  await expect(dialog.getByTestId("history-now")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(card.locator(".cm-content")).toHaveText(
    "Still unsaved, updated while Now is open.",
  );
  expect(await liveWorkspaceState(page)).toEqual(updated);
  await dialog
    .getByRole("button", { name: "Back to present", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(await liveWorkspaceState(page)).toEqual(updated);
});

test("a late snapshot response cannot replace the Now preview", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&delayDiff");
  await page.evaluate(() =>
    window.__historyWorkspaceHarness!.setCurrentMainText(
      "Keep this unsaved current text.",
    ),
  );
  await dialog.getByTestId("history-snapshot-older").click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__historyWorkspaceHarness!.diffRequests),
    )
    .toBeGreaterThan(0);
  await dialog.getByTestId("history-now").click();
  const card = dialog.getByTestId("history-front-card");
  await expect(card.locator(".cm-content")).toHaveText(
    "Keep this unsaved current text.",
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__historyWorkspaceHarness!;
        return state.diffRequests === state.settledDiffRequests;
      }),
    )
    .toBe(true);
  await expect(dialog.getByTestId("history-now")).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(card.locator(".cm-content")).toHaveText(
    "Keep this unsaved current text.",
  );
  await expect(
    card.getByRole("button", { name: "Restore project version", exact: true }),
  ).toHaveCount(0);
  await dialog.getByTestId("history-snapshot-older").click();
  await expect(card).toContainText(
    "Our model learns useful representations from observations.",
  );
});

for (const reduced of [false, true]) {
  test(`timeline card transfers ${reduced ? "respect reduced motion" : "move down and fade out, then rise and fade in"}`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    const dialog = await openHistory(page);
    await expect(dialog.getByTestId("history-front-card")).toContainText(
      "Our revised model learns a compact representation",
    );
    await page.waitForFunction(
      () =>
        !document
          .querySelector('[data-testid="history-front-card"]')!
          .getAnimations()
          .some((a) => a.playState === "running"),
    );
    for (const target of ["older", "newest", "present"]) {
      const frames = await page.evaluate(async (target) => {
        const button = document.querySelector<HTMLButtonElement>(
          target === "present"
            ? '[data-testid="history-now"]'
            : `[data-testid="history-snapshot-${target}"]`,
        )!;
        button.click();
        const samples: {
          time: number;
          ghostY: number | null;
          ghostOpacity: number | null;
          liveY: number;
          liveOpacity: number;
          rotation: number;
          ghostCount: number;
          inert: boolean;
        }[] = [];
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const sample = () => {
            const live = document.querySelector<HTMLElement>(
              '[data-testid="history-front-card"]',
            )!;
            const ghost = document.querySelector<HTMLElement>(
              ".history-transition-card",
            );
            const liveStyle = getComputedStyle(live);
            const ghostStyle = ghost ? getComputedStyle(ghost) : null;
            const liveMatrix = new DOMMatrixReadOnly(liveStyle.transform);
            const ghostMatrix = ghostStyle
              ? new DOMMatrixReadOnly(ghostStyle.transform)
              : null;
            samples.push({
              time: performance.now() - start,
              ghostY: ghostMatrix?.f ?? null,
              ghostOpacity: ghostStyle ? Number(ghostStyle.opacity) : null,
              liveY: liveMatrix.f,
              liveOpacity: Number(liveStyle.opacity),
              rotation: Math.max(
                Math.abs(liveMatrix.b),
                Math.abs(liveMatrix.c),
                Math.abs(ghostMatrix?.b ?? 0),
                Math.abs(ghostMatrix?.c ?? 0),
              ),
              ghostCount: document.querySelectorAll(".history-transition-card")
                .length,
              inert: live.inert,
            });
            if (performance.now() - start < 500) requestAnimationFrame(sample);
            else resolve();
          };
          requestAnimationFrame(sample);
        });
        return samples;
      }, target);
      expect(frames.length).toBeGreaterThan(5);
      expect(Math.max(...frames.map((frame) => frame.rotation))).toBeLessThan(
        0.001,
      );
      const last = frames.at(-1)!;
      expect(last.ghostCount).toBe(0);
      expect(last.inert).toBe(false);
      expect(last.liveY).toBeCloseTo(0, 2);
      expect(last.liveOpacity).toBe(1);
      if (reduced) {
        expect(
          frames.every(
            (frame) =>
              frame.ghostCount === 0 &&
              frame.liveY === 0 &&
              frame.liveOpacity === 1,
          ),
        ).toBe(true);
      } else {
        expect(frames.some((frame) => frame.ghostCount === 1)).toBe(true);
        if (target === "older") {
          expect(
            frames.some(
              (frame) =>
                (frame.ghostY ?? 0) > 40 && (frame.ghostOpacity ?? 1) < 0.6,
            ),
          ).toBe(true);
        } else {
          expect(
            frames.some((frame) => frame.liveY > 20 && frame.liveOpacity < 0.7),
          ).toBe(true);
        }
      }
      await test.info().attach(`transfer-${target}`, {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });
    }
  });
}

test("rapid timeline transfers keep only one outgoing card and clean up on exit", async ({
  page,
}) => {
  const dialog = await openHistory(page);
  await dialog.getByTestId("history-snapshot-older").click();
  await dialog.getByTestId("history-snapshot-newest").click();
  await dialog.getByTestId("history-now").click();
  await expect(page.locator(".history-transition-card")).toHaveCount(1);
  const copy = page.locator(".history-transition-card");
  await expect(copy).toHaveAttribute("aria-hidden", "true");
  await expect(copy).toHaveAttribute("inert", "");
  await expect(copy.locator("[id], [data-testid]")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Back to present", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".history-transition-card")).toHaveCount(0);
  await expect(page.locator(".history-live-workspace")).not.toHaveAttribute(
    "inert",
    "",
  );
});

for (const width of [1000, 1440]) {
  test(`adding a history card moves the outgoing card into its rear slot at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1000 ? 720 : 1024 });
    const dialog = await openHistory(page);
    await dialog.getByTestId("history-snapshot-older").click();
    await expect(page.locator(".history-transition-card")).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const rear = document.querySelector<HTMLElement>(
        '.history-rear-card[data-history-snapshot="initial"]',
      )!;
      const initialY = new DOMMatrixReadOnly(getComputedStyle(rear).transform)
        .f;
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="history-snapshot-newest"]',
        )!
        .click();
      const frames: {
        time: number;
        ghostOpacity: number | null;
        ghostScale: number | null;
        destinationHidden: boolean;
        rearY: number;
        alignment: number | null;
      }[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const sample = () => {
          const ghost = document.querySelector<HTMLElement>(
            ".history-transition-card",
          );
          const destination = document.querySelector<HTMLElement>(
            '.history-rear-card[data-history-snapshot="older"]',
          );
          const ghostStyle = ghost ? getComputedStyle(ghost) : null;
          const g = ghost?.getBoundingClientRect();
          const d = destination?.getBoundingClientRect();
          frames.push({
            time: performance.now() - start,
            ghostOpacity: ghostStyle ? Number(ghostStyle.opacity) : null,
            ghostScale: ghostStyle
              ? new DOMMatrixReadOnly(ghostStyle.transform).a
              : null,
            destinationHidden:
              !!destination &&
              getComputedStyle(destination).visibility === "hidden",
            rearY: new DOMMatrixReadOnly(getComputedStyle(rear).transform).f,
            alignment:
              g && d
                ? Math.max(
                    Math.abs(g.x - d.x),
                    Math.abs(g.y - d.y),
                    Math.abs(g.width - d.width),
                    Math.abs(g.height - d.height),
                  )
                : null,
          });
          if (performance.now() - start < 550) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return { initialY, frames };
    });
    const moving = result.frames.filter(
      (frame) => frame.time < 270 && frame.ghostOpacity !== null,
    );
    expect(moving.length).toBeGreaterThan(3);
    expect(moving.every((frame) => frame.destinationHidden)).toBe(true);
    expect(moving.every((frame) => frame.ghostOpacity! >= 0.87)).toBe(true);
    expect(moving.some((frame) => frame.ghostScale! < 0.97)).toBe(true);
    expect(
      result.frames.some(
        (frame) =>
          !frame.destinationHidden &&
          frame.ghostOpacity !== null &&
          frame.alignment! < 1,
      ),
    ).toBe(true);
    const final = result.frames.at(-1)!;
    expect(final.ghostOpacity).toBeNull();
    expect(final.destinationHidden).toBe(false);
    expect(final.rearY).toBeLessThan(result.initialY - 10);
    expect(
      result.frames.some(
        (frame) =>
          frame.rearY < result.initialY - 4 && frame.rearY > final.rearY + 4,
      ),
    ).toBe(true);
    await test.info().attach("rear-card-handoff", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
  });
}

test("snapshot details dismiss without exiting history and restore stays in the title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 720 });
  const history = await openHistory(page);
  const card = page.getByTestId("history-front-card");
  await expect(card.locator("footer")).toHaveCount(0);
  await expect(
    card
      .locator(".history-card-header")
      .getByRole("button", { name: "Restore project version", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Snapshot details", exact: true })
    .click();
  const details = page.getByRole("dialog", {
    name: "Snapshot details",
    exact: true,
  });
  await expect(
    details.getByRole("group", { name: "Snapshot tags" }),
  ).toBeVisible();
  await expect(
    details.getByRole("button", { name: "Copy snapshot ID" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0);
  await expect(history).toBeVisible();
  await page.setViewportSize({ width: 800, height: 720 });
  await page.getByTestId("history-snapshot-initial").click();
  await expect(page.locator(".history-transition-card")).toHaveCount(0);
  await card
    .getByRole("button", { name: "Snapshot details", exact: true })
    .click();
  await expect(details).toContainText("No tags");
});

test("history title details adapt to available space and restore aligns with the panel", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHistory(page);
  const card = page.getByTestId("history-front-card");
  const inline = card.locator(".history-inline-details");
  await expect(inline).toHaveAttribute("data-collapsed", "false");
  await expect(
    inline.getByRole("button", { name: "Copy snapshot ID" }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Snapshot details", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 720 });
  await expect(inline).toHaveAttribute("data-collapsed", "true");
  await expect(
    card.getByRole("button", { name: "Snapshot details", exact: true }),
  ).toBeVisible();
  const geometry = await card.evaluate((element) => {
    const button = element
      .querySelector(".history-restore-button")
      .getBoundingClientRect();
    const content = element.querySelector(".history-content");
    const panel = content.firstElementChild.getBoundingClientRect();
    return {
      height: button.height,
      offset: Math.abs(button.right - panel.right),
    };
  });
  expect(geometry.height).toBe(28);
  expect(geometry.offset).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(inline).toHaveAttribute("data-collapsed", "false");
});

test("history uses the shared compact app header and leaves room for short windows", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1000, height: 600 });
  await openHistory(page);
  const header = page.locator(".history-stage-header");
  await expect(
    header.getByRole("heading", { name: "Project rewind" }),
  ).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Manage automatic history" }),
  ).toBeVisible();
  await expect(
    header.getByRole("button", { name: "Back to present" }),
  ).toBeVisible();
  const metrics = await page.evaluate(() => {
    const header = document.querySelector(".history-stage-header");
    const title = document.querySelector(".history-stage-title");
    const card = document.querySelector(".history-front-card");
    return {
      top: header.getBoundingClientRect().top,
      height: header.getBoundingClientRect().height,
      fontSize: getComputedStyle(title).fontSize,
      cardHeight: card.getBoundingClientRect().height,
      dragRegions: header.querySelectorAll("[data-window-drag-region]").length,
    };
  });
  expect(metrics.top).toBe(0);
  expect(metrics.height).toBe(40);
  expect(metrics.fontSize).toBe("13px");
  expect(metrics.cardHeight).toBeGreaterThan(470);
  expect(metrics.dragRegions).toBeGreaterThan(0);
});

for (const width of [1000, 1440]) {
  test(`backward navigation replenishes a full stack from behind at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await openHistory(page, "&fullStack=1");
    await expect(page.locator(".history-rear-card")).toHaveCount(3);
    await page.locator(".history-front-card").evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished));
    });
    await page.getByTestId("history-snapshot-older").click();
    const rear = page.locator(
      '.history-rear-card[data-history-snapshot="archive-2"]',
    );
    const frames = await rear.evaluate((el) => {
      const animation = el.getAnimations()[0];
      animation.pause();
      const duration = Number(animation.effect.getTiming().duration);
      return [0, duration / 2, duration].map((time) => {
        animation.currentTime = time;
        const style = getComputedStyle(el);
        const matrix = new DOMMatrix(style.transform);
        return {
          y: matrix.m42,
          scale: matrix.m11,
          opacity: Number(style.opacity),
        };
      });
    });
    expect(frames[0].y).toBeLessThan(frames[1].y);
    expect(frames[1].y).toBeLessThan(frames[2].y);
    expect(frames[0].scale).toBeLessThan(frames[1].scale);
    expect(frames[1].scale).toBeLessThan(frames[2].scale);
    expect(frames[0].opacity).toBe(0);
    expect(frames[2].opacity).toBe(1);
    await rear.evaluate((el) => el.getAnimations().forEach((a) => a.finish()));
    await expect(page.locator(".history-transition-card")).toHaveCount(0);
    await expect(page.locator(".history-rear-card")).toHaveCount(3);
  });
}

test("inline restore cancels with Escape and resets when selecting another snapshot", async ({
  page,
}) => {
  const rewind = await openHistory(page);
  const card = page.getByTestId("history-front-card");
  const restore = card.getByRole("button", {
    name: "Restore project version",
    exact: true,
  });
  const restoreWidth = await restore.evaluate((el) => el.offsetWidth);
  await restore.click();
  const confirmation = card.getByRole("group", { name: "Confirm restore" });
  await expect(confirmation).toBeVisible();
  for (const label of ["Confirm", "Cancel"]) {
    const width = await confirmation
      .getByRole("button", { name: label, exact: true })
      .evaluate((el) => el.offsetWidth);
    expect(width).toBe(restoreWidth);
  }
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(card.locator(".history-card-normal")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(
    confirmation.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(rewind).toBeVisible();
  await expect(restore).toBeFocused();
  await restore.click();
  await page.getByTestId("history-snapshot-older").click();
  await expect(confirmation).toHaveCount(0);
  await expect(restore).toBeVisible();
  expect(
    await page.evaluate(
      () => window.__historyWorkspaceHarness?.restoreRequests,
    ),
  ).toBe(0);
});

test("recorded assets show saved versions, including files deleted from the workspace", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&recordedAssets");
  const card = dialog.getByTestId("history-front-card");
  await card.getByTestId("history-file-archived.svg").click();
  const asset = card.getByTestId("history-recorded-asset");
  await expectRenderedImage(asset, "archived.svg");
  await expect(asset).toContainText("Saved project asset");
  const newestSource = await asset.locator("img").getAttribute("src");
  expect(atob(newestSource!.split(",")[1])).toContain("newest figure");
  await dialog.getByTestId("history-snapshot-older").click();
  await expectRenderedImage(asset, "archived.svg");
  await expect
    .poll(async () =>
      atob((await asset.locator("img").getAttribute("src"))!.split(",")[1]),
    )
    .toContain("older figure");
  await page.screenshot({
    path: test.info().outputPath("saved-asset-image.png"),
    animations: "disabled",
  });
  await card.getByTestId("history-file-report.pdf").click();
  await expectRenderedPdf(asset, "Quantum");
  await waitForPdfCapture(asset);
  await page.screenshot({
    path: test.info().outputPath("saved-asset-pdf.png"),
    animations: "disabled",
  });
  await card.getByTestId("history-file-dataset.zip").click();
  await expect(asset).toContainText("will be restored with the project");
  await expect(asset).not.toContainText("File absent");
});

test("agent checkpoint label is visual and does not replace the action name", async ({
  page,
}) => {
  const dialog = await openHistory(page, "&agentLabel");
  const entry = dialog.getByTestId("history-snapshot-newest");
  await expect(entry).toContainText("Applied reviewed changes");
  await expect(entry.getByText("Agent", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Label snapshot", exact: true }),
  ).toContainText("Agent");
  await dialog.screenshot({
    path: "/tmp/270-agent-label.png",
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Label snapshot", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog", { name: "Snapshot labels", exact: true })
      .getByText("Agent", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Snapshot labels", exact: true })
    .screenshot({
      path: "/tmp/270-agent-label-popup.png",
      animations: "disabled",
    });
  await expect(
    page.getByRole("button", { name: "Remove label Agent", exact: true }),
  ).toHaveCount(0);
});

test("automatic labels precede manual labels", async ({ page }) => {
  const dialog = await openHistory(page, "&agentLabel&manualLabels");
  const entry = dialog.getByTestId("history-snapshot-newest");
  await expect(entry.locator(".history-timeline-description")).toHaveText(
    "Applied reviewed changes",
  );
  await expect(entry.getByText("Draft", { exact: true })).toBeVisible();
  await expect(entry.getByText("Checked", { exact: true })).toBeVisible();
  await dialog.screenshot({
    path: "/tmp/270-timeline-labels.png",
    animations: "disabled",
  });

  const labels = dialog.getByRole("button", {
    name: "Label snapshot",
    exact: true,
  });
  await expect(labels).toHaveText("AgentDraftChecked");
  await labels.click();
  const popup = page.getByRole("dialog", {
    name: "Snapshot labels",
    exact: true,
  });
  await expect(
    popup.getByRole("button", { name: "Remove label Draft", exact: true }),
  ).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Remove label Checked", exact: true }),
  ).toBeVisible();
  await popup.screenshot({
    path: "/tmp/270-label-order.png",
    animations: "disabled",
  });
});

test("project labels can be reused, created with spaces, and removed per checkpoint", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const dialog = await openHistory(page, "&agentLabel&manualLabels");
  const openLabels = async () => {
    await dialog
      .getByRole("button", { name: "Label snapshot", exact: true })
      .click();
    return page.getByRole("dialog", { name: "Snapshot labels", exact: true });
  };
  let popup = await openLabels();
  let input = popup.getByRole("combobox", {
    name: "Snapshot label",
    exact: true,
  });
  await input.fill(" Agent ");
  await input.press("Enter");
  const save = popup.getByRole("button", { name: "Save label", exact: true });
  await expect(save).toBeDisabled();
  await save.locator("..").hover();
  await expect(page.getByRole("tooltip")).toContainText("Reserved label");
  await page.screenshot({
    path: "/tmp/270-invalid-label.png",
    animations: "disabled",
  });
  await input.fill("Draft");
  await expect(
    page.getByRole("listbox", { name: "Snapshot label" }),
  ).toHaveCount(0);
  await expect(save).toBeDisabled();
  await save.locator("..").hover();
  await expect(page.getByRole("tooltip")).toContainText("Already added");
  await input.fill("agent");
  await expect(save).toBeEnabled();
  await input.fill("初".repeat(86));
  await expect(save).toBeDisabled();
  await input.fill("First draft 初稿");
  await input.press("Enter");
  await expect(
    popup.getByRole("button", {
      name: "Remove label First draft 初稿",
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("Second label");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await popup.screenshot({
    path: "/tmp/270-label-no-matches.png",
    animations: "disabled",
  });
  await expect(
    page.getByRole("listbox", { name: "Snapshot label" }),
  ).toHaveCount(0);
  await save.click();
  await expect(
    popup.getByRole("button", {
      name: "Remove label Second label",
      exact: true,
    }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  await popup
    .getByRole("heading", { name: "Snapshot labels", exact: true })
    .click();
  await popup.screenshot({
    path: "/tmp/270-multiple-labels.png",
    animations: "disabled",
  });
  await popup.getByRole("button", { name: "Done", exact: true }).click();
  await expect(popup).not.toBeVisible();
  await dialog.getByTestId("history-snapshot-older").click();
  popup = await openLabels();
  input = popup.getByRole("combobox", { name: "Snapshot label", exact: true });
  await input.click();
  await expect(
    page.getByRole("option", { name: "Agent", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("option", { name: "First draft 初稿", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/270-label-picker.png",
    animations: "disabled",
  });
  await page
    .getByRole("option", { name: "First draft 初稿", exact: true })
    .click();
  await expect(popup).toBeVisible();
  await expect(input).toHaveValue("");
  await popup
    .getByRole("button", { name: "Remove label First draft 初稿", exact: true })
    .click();
  await expect(
    popup.getByRole("button", {
      name: "Remove label First draft 初稿",
      exact: true,
    }),
  ).toHaveCount(0);
  await popup.getByRole("button", { name: "Done", exact: true }).click();
  await dialog.getByTestId("history-snapshot-newest").click();
  popup = await openLabels();
  await expect(
    popup.getByRole("button", {
      name: "Remove label First draft 初稿",
      exact: true,
    }),
  ).toBeVisible();
});

test("automatic history keeps concise copy with details in a help tooltip", async ({
  page,
}) => {
  const rewind = await openHistory(page);
  await rewind
    .getByRole("button", { name: "Manage automatic history", exact: true })
    .click();
  const popup = page.getByRole("dialog", {
    name: "Manage automatic history",
    exact: true,
  });
  await expect(popup).toBeVisible();
  await expect(popup).not.toContainText(
    "Private version history for this project.",
  );
  await expect(popup.getByText(/protected snapshot/)).toHaveCount(0);
  await popup
    .getByRole("heading", { name: "Manage automatic history", exact: true })
    .click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await popup.screenshot({
    path: "/tmp/270-automatic-history.png",
    animations: "disabled",
  });
  await popup.getByRole("button", { name: "About automatic history" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("latest 50 snapshots");
  await page.screenshot({
    path: "/tmp/270-history-help.png",
    animations: "disabled",
  });
});

test("clearing mixed demo history replaces the timeline with a fresh baseline", async ({
  page,
}) => {
  const rewind = await openHistory(page, "&mixedOperations");
  await expect(rewind.getByTestId("history-snapshot-newest")).toBeVisible();
  await rewind
    .getByRole("button", { name: "Manage automatic history", exact: true })
    .click();
  const management = page.getByRole("dialog", {
    name: "Manage automatic history",
    exact: true,
  });
  await expect(management).toContainText("7 snapshots");
  await management
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Clear history?", exact: true })
    .getByRole("button", { name: "Clear history", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Clear history?", exact: true }),
  ).toHaveCount(0);
  await expect(management).toHaveCount(0);
  await expect(rewind.getByTestId("history-snapshot-newest")).toHaveCount(0);
  await expect(
    rewind.getByTestId(
      "history-snapshot-b94ef738a61024cbd5628f8390c2d57613bce4a9",
    ),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/270-rewind-cleared.png",
    animations: "disabled",
  });
});

test("over-budget limit changes confirm before cleanup and refresh the demo timeline", async ({
  page,
}) => {
  const rewind = await openHistory(page, "&mixedOperations&storagePressure");
  await rewind
    .getByRole("button", { name: "Manage automatic history", exact: true })
    .click();
  const management = page.getByRole("dialog", {
    name: "Manage automatic history",
    exact: true,
  });
  await expect(management).toContainText("200.0 MB of 250.0 MB");
  const choose = async (name: string) => {
    await management.getByRole("combobox").click();
    await page.getByRole("option", { name, exact: true }).click();
  };
  await choose("500 MB");
  await expect(management).toContainText("200.0 MB of 500.0 MB");
  await choose("250 MB");
  await expect(management).toContainText("200.0 MB of 250.0 MB");
  await choose("100 MB");
  const confirmation = page.getByRole("dialog", {
    name: "Lower history limit?",
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(management).toContainText("200.0 MB of 250.0 MB");
  await choose("100 MB");
  await confirmation.screenshot({
    path: "/tmp/270-limit-confirmation.png",
    animations: "disabled",
  });
  await confirmation
    .getByRole("button", { name: "Lower limit", exact: true })
    .click();
  await expect(management).toContainText("85.0 MB of 100.0 MB");
  await expect(management).toContainText("50 snapshots");
  await management.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    rewind.getByTestId("history-snapshot-storage-archive-57"),
  ).toHaveCount(0);
});

test("comment checkpoints share automatic label visuals and restrictions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 1000 });
  const dialog = await openHistory(
    page,
    "&agentLabel&commentLabel&manualLabels",
  );
  const entry = dialog.getByTestId("history-snapshot-newest");
  await expect(entry.getByText("Comments", { exact: true })).toBeVisible();
  const labels = dialog.getByRole("button", {
    name: "Label snapshot",
    exact: true,
  });
  await expect(labels).toHaveText("AgentCommentsDraftChecked");
  await dialog.screenshot({
    path: "/tmp/275-comment-label-timeline.png",
    animations: "disabled",
  });
  await labels.click();
  const popup = page.getByRole("dialog", {
    name: "Snapshot labels",
    exact: true,
  });
  await expect(popup.getByText("Comments", { exact: true })).toBeVisible();
  await expect(
    popup.getByRole("button", { name: "Remove label Comments", exact: true }),
  ).toHaveCount(0);
  await popup
    .getByRole("combobox", { name: "Snapshot label" })
    .fill("Comments");
  await expect(
    popup.getByRole("button", { name: "Save label", exact: true }),
  ).toBeDisabled();
  await popup.screenshot({
    path: "/tmp/275-comment-label-popup.png",
    animations: "disabled",
  });
});
