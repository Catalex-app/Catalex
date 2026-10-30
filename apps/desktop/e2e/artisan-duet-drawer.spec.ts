import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1024, height: 640 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`Artisan to Duet keeps chrome anchored at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?debug=input-transfer");
    await expect(page.locator(".cm-editor")).toBeVisible();
    await page.waitForTimeout(1000);
    await page.getByRole("tab", { name: "Artisan", exact: true }).click();
    await expect(page.locator("[data-chat-drawer-overlay]")).toHaveCount(0);
    // Include slower frame delivery, where provisional layout is more visible.
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    const frames = await page.evaluate(async () => {
      const samples: {
        top: number;
        bottom: number;
        opacity: number;
        clipPath: string;
        translateY: number;
        phase: string | undefined;
      }[] = [];
      const duet = Array.from(
        document.querySelectorAll<HTMLElement>('[role="tab"]'),
      ).find((tab) => tab.textContent === "Duet");
      duet?.click();
      const start = performance.now();
      while (performance.now() - start < 1400) {
        await new Promise(requestAnimationFrame);
        const panel = document.querySelector<HTMLElement>(
          "[data-chat-drawer-panel]",
        );
        const composer = panel?.querySelector<HTMLElement>(
          "[data-chat-composer-shell]",
        );
        if (!panel || !composer) continue;
        const style = getComputedStyle(panel);
        if (style.visibility === "hidden") continue;
        const rect = panel.getBoundingClientRect();
        samples.push({
          top: rect.top,
          bottom: rect.bottom,
          opacity: Number(style.opacity),
          clipPath: style.clipPath,
          translateY: new DOMMatrixReadOnly(
            getComputedStyle(composer).transform,
          ).m42,
          phase: composer.dataset.composerTransferPhase,
        });
      }
      return samples;
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    expect(frames.length).toBeGreaterThan(5);
    const last = frames[frames.length - 1];
    // The panel fades in at its final position; only the composer travels.
    expect(
      frames.some((frame) => frame.opacity > 0 && frame.opacity < 0.95),
    ).toBe(true);
    expect(frames.every((frame) => frame.clipPath === "none")).toBe(true);
    expect(
      Math.max(...frames.map((frame) => Math.abs(frame.top - last.top))),
    ).toBeLessThan(2);
    expect(
      Math.max(...frames.map((frame) => Math.abs(frame.bottom - last.bottom))),
    ).toBeLessThan(2);
    expect(
      frames.some(
        (frame) => frame.phase === "drawer_enter" && frame.translateY > 10,
      ),
    ).toBe(true);
    expect(Math.abs(last.translateY)).toBeLessThan(1);
    expect(last.phase).toBe("idle");
    expect(last.opacity).toBe(1);
    await page
      .locator("[data-input-transfer-harness-overlay]")
      .evaluate((element) => element.remove());
    await page.screenshot({
      path: `test-results/artisan-duet-${viewport.width}.png`,
    });
  });
}
