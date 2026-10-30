import { expect, test } from "@playwright/test";

for (const width of [1440, 1024]) {
  test(`Half drawer smoothly follows all workspace view changes at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/?onboarding-demo&project");
    await page
      .locator('[data-sidebar-section="files"]')
      .getByText("demo-paper.tex", { exact: true })
      .click();
    const compiled = page.waitForResponse(
      (response) =>
        response.url().endsWith("/__demo/compile") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Recompile", exact: true }).click();
    await compiled;
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    const panel = page.locator('[data-chat-drawer-panel="true"]');
    const input = panel.locator('textarea[data-chat-composer-input="true"]');
    await input.fill("Keep this draft while switching views.");
    await page.waitForTimeout(400);
    const modes = page.getByRole("tablist", { name: "Workspace view mode" });
    for (const name of ["PDF", "Split", "Editor", "Split"]) {
      const recording = panel.evaluate(
        (element) =>
          new Promise<{ width: number; left: number; height: number }[]>(
            (resolve) => {
              const frames: { width: number; left: number; height: number }[] =
                [];
              const start = performance.now();
              const sample = () => {
                const rect = element.getBoundingClientRect();
                frames.push({
                  width: rect.width,
                  left: rect.left,
                  height: rect.height,
                });
                if (performance.now() - start < 1100)
                  requestAnimationFrame(() => setTimeout(sample, 0));
                else resolve(frames);
              };
              sample();
            },
          ),
      );
      await modes.getByRole("tab", { name, exact: true }).click();
      const frames = await recording;
      const widths = frames.map((frame) => frame.width);
      const range = Math.max(...widths) - Math.min(...widths);
      const steps = widths
        .slice(1)
        .map((value, index) => Math.abs(value - widths[index]));
      expect(range, name).toBeGreaterThan(100);
      expect(new Set(widths.map(Math.round)).size, name).toBeGreaterThan(4);
      expect(Math.max(...steps), name).toBeLessThan(range * 0.72);
      expect(
        Math.max(...frames.map((frame) => frame.height)) -
          Math.min(...frames.map((frame) => frame.height)),
        name,
      ).toBeLessThan(2);
      await expect(input).toHaveValue("Keep this draft while switching views.");
      await expect(
        modes.getByRole("tab", { name, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await page.screenshot({
        path: test.info().outputPath(`${name.toLowerCase()}-${width}.png`),
      });
    }
  });
}
