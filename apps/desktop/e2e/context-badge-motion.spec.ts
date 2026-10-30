import { expect, test } from "@playwright/test";

for (const reduced of [false, true]) {
  test(`context badges animate layout without moving the drawer bottom (${reduced ? "reduced" : "normal"} motion)`, async ({
    page,
  }) => {
    await page.emulateMedia({
      reducedMotion: reduced ? "reduce" : "no-preference",
    });
    await page.goto("/?debug=input-transfer");
    await expect(page.locator(".cm-editor")).toBeVisible();
    await page
      .locator("[data-input-transfer-harness-overlay]")
      .evaluate((element) => element.remove());
    const sample = async (remove = false) =>
      page.evaluate(async (remove) => {
        const shell = document.querySelector<HTMLElement>(
          '[data-chat-drawer-panel="true"] [data-context-row-shell]',
        )!;
        const panel = shell.closest<HTMLElement>(
          '[data-chat-drawer-panel="true"]',
        )!;
        const samples: {
          height: number;
          bottom: number;
          opacity: number;
          transform: string;
        }[] = [];
        const read = () => {
          const entry = shell.querySelector<HTMLElement>(
            "[data-context-entry]",
          );
          samples.push({
            height: shell.getBoundingClientRect().height,
            bottom: panel.getBoundingClientRect().bottom,
            opacity: entry ? Number(getComputedStyle(entry).opacity) : 0,
            transform: entry ? getComputedStyle(entry).transform : "none",
          });
        };
        read();
        if (remove)
          shell
            .querySelector<HTMLButtonElement>('[aria-label="Remove context"]')!
            .click();
        else window.__selectInputTransferHarnessText?.("Hello harness");
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            read();
            if (performance.now() - start > 550) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return samples;
      }, remove);
    const entering = await sample();
    const finalHeight = entering.at(-1)!.height;
    expect(entering[0].height).toBe(0);
    expect(finalHeight).toBeGreaterThan(20);
    expect(
      Math.max(...entering.map((x) => x.bottom)) -
        Math.min(...entering.map((x) => x.bottom)),
    ).toBeLessThan(2);
    const intermediate = entering.filter(
      (x) => x.height > 1 && x.height < finalHeight - 1,
    );
    if (reduced) {
      expect(intermediate).toHaveLength(0);
      expect(entering.every((x) => x.transform === "none")).toBe(true);
    } else {
      expect(intermediate.length).toBeGreaterThan(2);
      expect(entering.some((x) => x.opacity > 0 && x.opacity < 1)).toBe(true);
    }
    const badge = page.locator(
      '[data-chat-drawer-panel="true"] [data-context-entry]',
    );
    const identity = await badge.getAttribute("data-context-entry");
    await page.evaluate(() =>
      window.__selectInputTransferHarnessText?.("document"),
    );
    await expect(badge).toHaveAttribute("data-context-entry", identity!);
    expect(
      await badge.evaluate(
        (element) =>
          element.getAnimations().filter((a) => a.playState === "running")
            .length,
      ),
    ).toBe(0);
    await page.screenshot({ path: test.info().outputPath("live-badge.png") });
    const leaving = await sample(true);
    expect(leaving.at(-1)!.height).toBe(0);
    expect(
      Math.max(...leaving.map((x) => x.bottom)) -
        Math.min(...leaving.map((x) => x.bottom)),
    ).toBeLessThan(2);
    if (!reduced)
      expect(
        leaving.filter((x) => x.height > 1 && x.height < finalHeight - 1)
          .length,
      ).toBeGreaterThan(2);
    await test.info().attach("motion-frames", {
      body: JSON.stringify({ entering, leaving }, null, 2),
      contentType: "application/json",
    });
  });
}

test("badge motion stays aligned when wrapping and has inspectable entrance frames", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  const panel = page.locator('[data-chat-drawer-panel="true"]:visible');
  const row = panel.locator("[data-context-row-shell]");
  await expect(row.locator("[data-context-entry]")).toHaveCount(1);
  for (const time of [0, 80, 160, 240]) {
    await row.evaluate((element, time) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = time;
      }
    }, time);
    await panel.screenshot({
      path: test.info().outputPath(`entrance-${time}.png`),
    });
  }
  await row.evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .forEach((animation) => animation.finish()),
  );
  const chips = panel.locator('[data-selection-chip="true"]');
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("document"),
  );
  await expect(chips).toHaveCount(2);
  await chips
    .getByRole("button", { name: "Pin selection", exact: true })
    .click();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Introduction"),
  );
  await expect(chips).toHaveCount(3);
  await expect
    .poll(() =>
      row.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((a) => a.playState === "running").length,
      ),
    )
    .toBe(0);
  const bounds = await row.evaluate((element) => {
    const row = element.getBoundingClientRect();
    return [...element.querySelectorAll("[data-context-entry]")].map(
      (entry) => {
        const rect = entry.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          within: rect.top >= row.top && rect.bottom <= row.bottom + 1,
        };
      },
    );
  });
  expect(bounds.every((bound) => bound.within)).toBe(true);
  expect(new Set(bounds.map((bound) => bound.top)).size).toBeGreaterThan(1);
  await panel.screenshot({
    path: test.info().outputPath("wrapped-badges.png"),
  });
  await chips.first().getByRole("button", { name: "Remove context" }).click();
  await expect(chips).toHaveCount(2);
  await expect
    .poll(() =>
      row.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((a) => a.playState === "running").length,
      ),
    )
    .toBe(0);
  await panel.screenshot({ path: test.info().outputPath("after-removal.png") });
});

test("a replacement selection reuses the fading live badge without sliding sideways", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor")).toBeVisible();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  const row = page.locator(
    '[data-chat-drawer-panel="true"] [data-context-row-shell]',
  );
  await expect(row.locator("[data-context-entry]")).toHaveCount(1);
  await expect
    .poll(() =>
      row.evaluate(
        (element) =>
          element
            .getAnimations({ subtree: true })
            .filter((a) => a.playState === "running").length,
      ),
    )
    .toBe(0);
  const result = await page.evaluate(async () => {
    const modulePath = "/node_modules/.vite/deps/@codemirror_view.js";
    const { EditorView } = await import(modulePath);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")!);
    const row = document.querySelector<HTMLElement>(
      '[data-chat-drawer-panel="true"] [data-context-row-shell]',
    )!;
    const original = row.querySelector<HTMLElement>("[data-context-entry]")!;
    const id = original.dataset.contextEntry;
    const left = original.getBoundingClientRect().left;
    view.focus();
    view.dispatch({ selection: { anchor: view.state.selection.main.head } });
    // Starting a mouse drag briefly collapses the old range before the new one exists.
    await new Promise((resolve) => setTimeout(resolve, 40));
    window.__selectInputTransferHarnessText?.("document");
    const frames: {
      count: number;
      id: string | undefined;
      left: number;
      entering: boolean;
    }[] = [];
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = () => {
        const entries = [
          ...row.querySelectorAll<HTMLElement>("[data-context-entry]"),
        ];
        const active = entries.find(
          (entry) => entry.dataset.contextPresence !== "exiting",
        );
        frames.push({
          count: entries.length,
          id: active?.dataset.contextEntry,
          left: active?.getBoundingClientRect().left ?? left,
          entering:
            active
              ?.getAnimations()
              .some(
                (animation) =>
                  animation instanceof CSSAnimation &&
                  animation.animationName === "context-badge-enter" &&
                  animation.playState === "running",
              ) ?? false,
        });
        if (performance.now() - start > 400) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { id, left, frames };
  });
  expect(result.frames.every((frame) => frame.count === 1)).toBe(true);
  expect(result.frames.every((frame) => frame.id === result.id)).toBe(true);
  expect(
    result.frames.every((frame) => Math.abs(frame.left - result.left) < 1),
  ).toBe(true);
  expect(result.frames.every((frame) => !frame.entering)).toBe(true);
});

for (const theme of ["light", "dark"]) {
  test(`only the first badge gets a single slow text glow wave (${theme})`, async ({
    page,
  }) => {
    await page.goto("/?debug=input-transfer");
    await expect(page.locator(".cm-editor")).toBeVisible();
    await page.evaluate(
      (theme) =>
        document.documentElement.classList.toggle("dark", theme === "dark"),
      theme,
    );
    await page
      .locator("[data-input-transfer-harness-overlay]")
      .evaluate((element) => element.remove());
    await page.evaluate(() =>
      window.__selectInputTransferHarnessText?.("Hello harness"),
    );
    const row = page.locator(
      '[data-chat-drawer-panel="true"] [data-context-row-shell]',
    );
    const label = row.locator("[data-context-glow]").first();
    await expect(label).toBeAttached();
    const pulse = await label.evaluate((element) => {
      const animation = element
        .getAnimations()
        .find(
          (a) =>
            a instanceof CSSAnimation &&
            a.animationName === "context-badge-attention",
        )!;
      const timing = animation.effect!.getTiming();
      animation.pause();
      const positions = [220, 1220, 2219].map((time) => {
        animation.currentTime = time;
        return parseFloat(getComputedStyle(element).maskPosition);
      });
      animation.currentTime = 1220;
      return {
        iterations: timing.iterations,
        duration: timing.duration,
        positions,
        image: getComputedStyle(element).maskImage,
        shadow: getComputedStyle(element).textShadow,
      };
    });
    expect(pulse.iterations).toBe(1);
    expect(pulse.duration).toBe(2000);
    expect(pulse.positions[0]).toBe(100);
    expect(pulse.positions[1]).toBe(50);
    expect(pulse.positions[2]).toBeLessThan(1);
    expect(pulse.image).toContain("linear-gradient");
    expect(pulse.shadow).not.toBe("none");
    await page.mouse.move(900, 300);
    await page
      .locator('[data-chat-drawer-panel="true"]:visible')
      .screenshot({ path: test.info().outputPath("text-glow-wave.png") });
    await label.evaluate((element) =>
      element.getAnimations().forEach((animation) => animation.finish()),
    );
    expect(
      await label.evaluate((element) => getComputedStyle(element).maskPosition),
    ).toBe("100% 0px");
    await page.evaluate(() =>
      window.__selectInputTransferHarnessText?.("document"),
    );
    expect(
      await label.evaluate(
        (element) =>
          element.getAnimations().filter((a) => a.playState === "running")
            .length,
      ),
    ).toBe(0);
    await row
      .getByRole("button", { name: "Pin selection", exact: true })
      .click();
    await page.evaluate(() =>
      window.__selectInputTransferHarnessText?.("Introduction"),
    );
    await expect(row.locator("[data-context-entry]")).toHaveCount(2);
    expect(
      await row
        .locator("[data-context-glow]")
        .last()
        .evaluate((element) => element.getAnimations().length),
    ).toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await label.evaluate(
        (element) => getComputedStyle(element).animationName,
      ),
    ).toBe("none");
  });
}
