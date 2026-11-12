import { expect, test, type Page } from "@playwright/test";

async function prepare(page: Page, hold = false, middleTarget = false) {
  await page.goto(
    `/?debug=project-navigation${middleTarget ? "&returnTarget=middle" : ""}`,
  );
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
  await page.evaluate((hold) => {
    const start = document.startViewTransition.bind(document);
    const capture = { hold, directions: [] as string[], ready: false };
    Object.assign(window, { __navigationCapture: capture });
    document.startViewTransition = (update) => {
      capture.ready = false;
      capture.directions.push(
        document.documentElement.dataset.projectNavigation ?? "",
      );
      const transition = start(update);
      void transition.ready
        .then(async () => {
          await Promise.resolve();
          if (capture.hold) {
            for (const animation of document.getAnimations()) {
              if (
                animation.id === "project-navigation-row" ||
                (animation instanceof CSSAnimation &&
                  animation.animationName.startsWith("project-handoff-"))
              ) {
                animation.pause();
                animation.currentTime = 0;
              }
            }
          }
          capture.ready = true;
        })
        .catch(() => {});
      return transition;
    };
  }, hold);
}

async function captureFrame(page: Page, time: number) {
  await page.waitForFunction(() => (window as any).__navigationCapture.ready);
  return page.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      if (
        animation.id === "project-navigation-row" ||
        (animation instanceof CSSAnimation &&
          animation.animationName.startsWith("project-handoff-"))
      )
        animation.currentTime = time;
    }
    const old = getComputedStyle(
      document.documentElement,
      "::view-transition-old(project-screen)",
    );
    const next = getComputedStyle(
      document.documentElement,
      "::view-transition-new(project-screen)",
    );
    return {
      oldScale: new DOMMatrixReadOnly(old.transform).m11,
      newScale: new DOMMatrixReadOnly(next.transform).m11,
      oldY: new DOMMatrixReadOnly(old.transform).m42,
      newY: new DOMMatrixReadOnly(next.transform).m42,
      oldX: new DOMMatrixReadOnly(old.transform).m41,
      newX: new DOMMatrixReadOnly(next.transform).m41,
      oldOpacity: Number(old.opacity),
      newOpacity: Number(next.opacity),
    };
  }, time);
}

async function finishTransition(page: Page) {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (
        animation.id === "project-navigation-row" ||
        (animation instanceof CSSAnimation &&
          animation.animationName.startsWith("project-handoff-"))
      )
        animation.finish();
    }
  });
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-project-navigation",
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`hands off right on open and left toward the returning project (${theme})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.emulateMedia({
      colorScheme: theme,
      reducedMotion: "no-preference",
    });
    await page.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      theme,
    );
    const targetIndex = theme === "dark" ? 1 : 0;
    await prepare(page, true, targetIndex === 1);
    await page.getByRole("button", { name: /^Research notes/ }).click();
    await expect(page.locator(".cm-content").first()).toContainText(
      "Research notes",
    );
    const open = await captureFrame(page, 65);
    const outgoingRows = await page.evaluate(() =>
      [0, 1, 2].map((index) => {
        const style = getComputedStyle(
          document.documentElement,
          `::view-transition-old(project-row-${index})`,
        );
        return {
          x: new DOMMatrixReadOnly(style.transform).m41,
          y: new DOMMatrixReadOnly(style.transform).m42,
          opacity: Number(style.opacity),
        };
      }),
    );
    expect(outgoingRows[targetIndex].x).toBeGreaterThan(
      outgoingRows[1 - targetIndex].x,
    );
    expect(outgoingRows[1 - targetIndex].x).toBeGreaterThan(outgoingRows[2].x);
    expect(outgoingRows.every((row) => row.y === 0 && row.x > 0)).toBe(true);
    expect(new Set(outgoingRows.map((row) => row.opacity)).size).toBe(3);
    expect([open.oldScale, open.newScale]).toEqual([1, 1]);
    expect([open.oldY, open.newY]).toEqual([0, 0]);
    expect(open.oldX).toBe(0);
    expect(open.newX).toBeLessThan(0);
    expect(open.oldOpacity).toBeGreaterThan(0.5);
    expect(outgoingRows.every((row) => row.opacity > 0.5)).toBe(true);
    expect(open.newOpacity).toBe(0);
    expect(open.oldOpacity).toBeLessThan(1);
    await page.screenshot({
      path: `../../output/playwright/project-handoff-exit-${theme}.png`,
    });
    const entering = await captureFrame(page, 245);
    expect(entering.oldOpacity).toBe(0);
    expect(entering.newOpacity).toBeGreaterThan(0);
    expect(entering.newOpacity).toBeLessThan(1);
    expect(entering.newY).toBe(0);
    expect(entering.newX).toBeLessThan(0);
    expect(entering.newX).toBeGreaterThan(open.newX);
    const outgoingOpacity = await page.evaluate(() =>
      [0, 1, 2].map((index) =>
        Number(
          getComputedStyle(
            document.documentElement,
            `::view-transition-old(project-row-${index})`,
          ).opacity,
        ),
      ),
    );
    expect(outgoingOpacity).toEqual([0, 0, 0]);
    await page.screenshot({
      path: `../../output/playwright/project-handoff-open-${theme}.png`,
    });
    await finishTransition(page);
    await page
      .getByRole("button", { name: "Close project", exact: true })
      .click();
    await expect(page.getByTestId("welcome-layout")).toBeVisible();
    const close = await captureFrame(page, 65);
    expect([close.oldScale, close.newScale]).toEqual([1, 1]);
    expect([close.oldY, close.newY]).toEqual([0, 0]);
    expect(close.oldX).toBeLessThan(0);
    expect(close.newX).toBe(0);
    expect(close.oldOpacity).toBeGreaterThan(0);
    expect(close.newOpacity).toBe(0);
    expect(close.oldOpacity).toBeLessThan(1);
    expect(close.newOpacity).toBeLessThan(1);
    // The workspace clears sooner, leaving more time for Welcome to return.
    const departing = await captureFrame(page, 160);
    expect(departing.oldX).toBeLessThan(close.oldX);
    expect(departing.oldOpacity).toBeGreaterThan(0);
    expect(departing.oldOpacity).toBeLessThan(close.oldOpacity);
    expect(departing.newOpacity).toBe(0);
    const returning = await captureFrame(page, 280);
    expect(returning.oldOpacity).toBe(0);
    expect(returning.newOpacity).toBeGreaterThan(0.5);
    expect(returning.newOpacity).toBeLessThan(1);
    const rows = await page.evaluate(() =>
      [0, 1, 2].map((index) => {
        const style = getComputedStyle(
          document.documentElement,
          `::view-transition-new(project-row-${index})`,
        );
        return {
          x: new DOMMatrixReadOnly(style.transform).m41,
          y: new DOMMatrixReadOnly(style.transform).m42,
          opacity: Number(style.opacity),
          outline: style.outlineStyle,
        };
      }),
    );
    for (const [index, row] of rows.entries()) {
      expect(row.x).toBeGreaterThan(0);
      if (index === targetIndex) {
        expect(row.opacity).toBeGreaterThan(0.9);
        expect(row.x).toBeGreaterThan(5);
      } else expect(row.opacity).toBeLessThan(rows[targetIndex].opacity);
      expect(row.y).toBe(0);
      expect(row.outline).toBe("none");
    }
    await page.screenshot({
      path: `../../output/playwright/project-handoff-close-${theme}.png`,
    });
    const visible = await captureFrame(page, 350);
    expect(visible.newOpacity).toBe(1);
    const stillMoving = await page.evaluate(() =>
      [0, 1, 2].map((index) => {
        const style = getComputedStyle(
          document.documentElement,
          `::view-transition-new(project-row-${index})`,
        );
        return {
          x: new DOMMatrixReadOnly(style.transform).m41,
          opacity: Number(style.opacity),
        };
      }),
    );
    expect(stillMoving.every((row) => row.opacity > 0.9 && row.x > 0.2)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../output/playwright/project-handoff-visible-motion-${theme}.png`,
    });
    await captureFrame(page, 470);
    const landing = await page.evaluate((targetIndex) => {
      const read = (index: number) =>
        getComputedStyle(
          document.documentElement,
          `::view-transition-new(project-row-${index})`,
        );
      return {
        targetX: new DOMMatrixReadOnly(read(targetIndex).transform).m41,
        targetOpacity: Number(read(targetIndex).opacity),
        otherX: new DOMMatrixReadOnly(read(1 - targetIndex).transform).m41,
      };
    }, targetIndex);
    expect(landing.targetX).toBe(0);
    expect(landing.targetOpacity).toBe(1);
    expect(landing.otherX).toBeGreaterThan(0);
    await finishTransition(page);
    expect(
      await page.evaluate(() => (window as any).__navigationCapture.directions),
    ).toEqual(["open", "close"]);
  });
}

test("reduced motion and missing browser support keep navigation immediate", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepare(page);
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .click();
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__navigationCapture.directions),
  ).toEqual([]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() =>
    Object.defineProperty(document, "startViewTransition", {
      value: undefined,
    }),
  );
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .click();
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
});

test("failed loading or saving stays on the current screen without animating", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    window.__projectNavigationHarness!.failOpen = true;
  });
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(
    page.getByText("The project could not be read.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__navigationCapture.directions),
  ).toEqual([]);
  await page.evaluate(() => {
    window.__projectNavigationHarness!.failOpen = false;
  });
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-project-navigation",
  );
  await page.evaluate(() => {
    window.__projectNavigationHarness!.failSave = true;
  });
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Research notes");
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText("# Unsaved notes\n");
  await expect(editor).toContainText("Unsaved notes");
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .click();
  await expect(page.getByText(/Could not close the project:/)).toBeVisible();
  await expect(page.locator(".cm-content").first()).toContainText(
    "Unsaved notes",
  );
  expect(
    await page.evaluate(() => (window as any).__navigationCapture.directions),
  ).toEqual(["open"]);
});

test("a new navigation can interrupt a transition and leave one usable screen", async ({
  page,
}) => {
  await prepare(page, true);
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await captureFrame(page, 40);
  await page.evaluate(() => {
    (window as any).__navigationCapture.hold = false;
  });
  // Invoke the mounted screen's action while its snapshot still covers it.
  await page
    .getByRole("button", { name: "Close project", exact: true })
    .evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-project-navigation",
  );
  await expect(page.locator("[data-project-screen]")).toHaveCount(1);
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(page.locator(".cm-content").first()).toBeVisible();
});

test("rows stay still until loading finishes and remain usable after failure", async ({
  page,
}) => {
  await prepare(page);
  await page.evaluate(() => {
    window.__projectNavigationHarness!.holdOpen = true;
    window.__projectNavigationHarness!.failOpen = true;
  });
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await page.waitForFunction(
    () => !!window.__projectNavigationHarness!.releaseOpen,
  );
  const welcome = page.getByTestId("welcome-layout");
  await expect(welcome).toHaveAttribute("aria-busy", "true");
  await expect(
    page.locator("[data-project-opening-label]").first(),
  ).toBeVisible();
  expect(await welcome.evaluate((element) => element.inert)).toBe(true);
  const rows = await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (animation.id !== "project-navigation-row") continue;
      animation.pause();
      animation.currentTime = 110;
    }
    return [...document.querySelectorAll("[data-project-path]")].map(
      (element) => {
        const style = getComputedStyle(element);
        return {
          x: new DOMMatrixReadOnly(style.transform).m41,
          y: new DOMMatrixReadOnly(style.transform).m42,
          opacity: Number(style.opacity),
        };
      },
    );
  });
  expect(rows).toEqual(
    Array.from({ length: 3 }, () => ({ x: 0, y: 0, opacity: 1 })),
  );
  expect(
    await page.evaluate(() => (window as any).__navigationCapture.directions),
  ).toEqual([]);
  await page.screenshot({
    path: "../../output/playwright/project-handoff-loading.png",
  });
  // A second activation cannot start another open while the first is pending.
  await page
    .getByRole("button", { name: /^Research notes/ })
    .evaluate((button: HTMLButtonElement) => button.click());
  expect(
    await page.evaluate(() => window.__projectNavigationHarness!.openAttempts),
  ).toBe(1);
  await page.evaluate(() => window.__projectNavigationHarness!.releaseOpen!());
  await expect(
    page.getByText("The project could not be read.", { exact: true }),
  ).toBeVisible();
  await expect(welcome).not.toHaveAttribute("aria-busy");
  expect(await welcome.evaluate((element) => element.inert)).toBe(false);
  for (const row of await page.locator("[data-project-path]").all()) {
    await expect(row).toHaveCSS("transform", "none");
    await expect(row).toHaveCSS("opacity", "1");
  }
  await page.evaluate(() => {
    window.__projectNavigationHarness!.failOpen = false;
  });
  await page.getByRole("button", { name: /^Research notes/ }).click();
  await expect(page.locator(".cm-content").first()).toContainText(
    "Research notes",
  );
});
