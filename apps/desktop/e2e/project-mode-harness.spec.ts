import { expect, test } from "@playwright/test";

for (const [mode, layout, label] of [
  ["artisan", "drawer", "Artisan"],
  ["duet", "drawer", "Duet"],
  ["duet", "workspace", "Duet"],
] as const) {
  test(`remembers ${label} ${layout} when reopening the project`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.addEventListener("app-visibility-restored", () => {
        document.documentElement.dataset.testStartupRecovered = "true";
      });
    });
    await page.goto("/?debug=input-transfer");
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute(
      "data-test-startup-recovered",
      "true",
    );
    const modes = page.getByRole("tablist", {
      name: "Workspace assistant mode",
    });
    await expect(
      modes.getByRole("tab", { name: "Duet", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-editor").first()).toBeAttached();
    await modes.getByRole("tab", { name: label, exact: true }).click();
    await expect(
      modes.getByRole("tab", { name: label, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    if (layout === "workspace") {
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
      await page.getByRole("button", { name: "Full", exact: true }).click();
    }
    if (mode !== "duet" || layout !== "drawer") {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
                ?.workspacePreferencesByProject?.["/tmp/harness"],
          ),
        )
        .toEqual({ mode, chatLayout: layout });
    }
    await page.reload();
    await expect(
      modes.getByRole("tab", { name: label, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    if (layout === "workspace") {
      await expect
        .poll(
          async () =>
            (
              await page
                .locator('[data-workspace-chat-pane="true"]')
                .boundingBox()
            )?.width ?? 0,
        )
        .toBeGreaterThan(400);
    } else if (mode === "artisan") {
      await expect(
        page.locator('[data-chat-drawer-panel="true"]:visible'),
      ).toHaveCount(0);
    } else {
      await expect(
        page.locator('[data-chat-drawer-panel="true"]:visible'),
      ).toHaveCount(1);
    }
    await page.screenshot({
      path: `test-results/project-mode-${mode}-${layout}.png`,
    });
  });
}

test("Settings has no default app mode control", async ({ page }) => {
  await page.goto("/?debug=markdown-settings");
  await expect(
    page.getByRole("combobox", { name: "Appearance", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Default App Mode", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({ path: "test-results/project-mode-settings.png" });
});
