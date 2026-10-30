import { expect, test } from "@playwright/test";

test("Codex Fast mode sits between models and effort and stays separate from Claude", async ({
  page,
}, testInfo) => {
  await page.goto("/?debug=claude-models");
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  const toggle = page.getByRole("switch", { name: "Fast mode" });
  await expect(toggle).toHaveCount(0);
  const providers = page.getByRole("group", { name: "Provider", exact: true });
  await providers.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("[data-fast-mode-icon]")).toHaveAttribute(
    "fill",
    "none",
  );
  await page.getByText("Fast mode", { exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle.locator("..")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("[data-fast-mode-icon]")).toHaveAttribute(
    "fill",
    "currentColor",
  );
  await expect(
    toggle.locator('[data-slot="settings-switch-track"] > span'),
  ).toHaveCSS("left", "2px");
  await expect(page.locator('[aria-label="Fast mode enabled"]')).toBeVisible();
  await expect
    .poll(async () =>
      toggle.evaluate((button) => {
        const track = button
          .querySelector('[data-slot="settings-switch-track"]')!
          .getBoundingClientRect();
        const thumb = button
          .querySelector("[data-sidebar-switch-thumb]")!
          .getBoundingClientRect();
        return Math.abs(
          thumb.top + thumb.height / 2 - (track.top + track.height / 2),
        );
      }),
    )
    .toBeLessThan(0.5);
  const models = await page
    .locator('[data-model-provider="codex"]')
    .boundingBox();
  const fast = await toggle.boundingBox();
  const effort = await page.getByText("Effort", { exact: true }).boundingBox();
  expect(fast!.y).toBeGreaterThanOrEqual(models!.y + models!.height);
  expect(fast!.y + fast!.height).toBeLessThanOrEqual(effort!.y);
  await page.screenshot({ path: testInfo.outputPath("codex-fast-mode.png") });
  await providers.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(toggle).toHaveCount(0);
  await expect(page.locator('[aria-label="Fast mode enabled"]')).toHaveCount(0);
  await providers.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(page.locator('[aria-label="Fast mode enabled"]')).toHaveCount(0);
});
