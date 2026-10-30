import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const modes = [
  { id: "artisan", label: "Artisan" },
  { id: "duet", label: "Duet" },
] as const;

async function assignTheme(page: Page, mode: string, theme: string) {
  await page.evaluate(
    async ({ mode, theme }) => {
      const { useSettingsStore } = await import(
        /* @vite-ignore */ "/src/renderer/stores/settings-store.ts"
      );
      useSettingsStore.getState().setModeTheme(mode, theme);
    },
    { mode, theme },
  );
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", theme);
}

async function workspaceGeometry(page: Page) {
  return page.locator("[data-workspace-mode-area]").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
}

for (const appearance of ["light", "dark"] as const) {
  for (const mode of modes) {
    test(`${mode.label} supports both themes in ${appearance} without changing its workspace`, async ({
      page,
    }) => {
      await page.goto("/?debug=input-transfer");
      await expect(
        page.getByRole("tab", { name: "Duet", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".cm-editor")).toBeVisible();
      // Allow the initial Duet drawer entrance to settle before switching modes.
      await page.waitForTimeout(900);
      await page.getByRole("tab", { name: mode.label, exact: true }).click();
      await expect(
        page.getByRole("tab", { name: mode.label, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      // This harness has no next-themes provider; exercise the same root dark class.
      await page.evaluate(
        (dark) => document.documentElement.classList.toggle("dark", dark),
        appearance === "dark",
      );
      await page.waitForTimeout(900);
      await assignTheme(page, mode.id, "modern");
      await page.waitForTimeout(200);
      const geometry = await workspaceGeometry(page);
      const systemPrompts = await page
        .getByText("System Prompts", { exact: true })
        .count();
      const controls = page.getByRole("tablist", {
        name: "Workspace assistant mode",
      });
      const controlsBox = await controls.boundingBox();
      const button = controls.getByRole("tab", {
        name: mode.label,
        exact: true,
      });
      const modernGradient = await button.evaluate(
        (el) => getComputedStyle(el).backgroundImage,
      );
      await page
        .locator("[data-input-transfer-harness-overlay]")
        .evaluate((element) => element.remove());
      await page.screenshot({
        path: path.resolve(
          "../../output/playwright/ui-themes",
          `${mode.label}-${appearance}-modern.png`,
        ),
      });

      await assignTheme(page, mode.id, "classic");
      await expect
        .poll(() =>
          button.evaluate((el) => getComputedStyle(el).backgroundImage),
        )
        .not.toBe(modernGradient);
      await page.waitForTimeout(200);
      expect(await workspaceGeometry(page)).toEqual(geometry);
      expect(await controls.boundingBox()).toEqual(controlsBox);
      await expect(button).toHaveAttribute("aria-selected", "true");
      // Segments share one divider, and Classic toolbar buttons align at 24px.
      const seams = await controls.getByRole("tab").evaluateAll((tabs) =>
        tabs.slice(1).map((tab, index) => {
          const previous = tabs[index];
          return {
            gap:
              tab.getBoundingClientRect().left -
              previous.getBoundingClientRect().right,
            stroke:
              parseFloat(getComputedStyle(previous).borderRightWidth) +
              parseFloat(getComputedStyle(tab).borderLeftWidth),
          };
        }),
      );
      for (const seam of seams) {
        expect(seam.gap).toBeCloseTo(0, 2);
        expect(seam.stroke).toBe(1);
      }
      const toolbar = page
        .locator(".git-actions-control[data-git-actions-standard]:visible")
        .first();
      const alignedControls = [
        toolbar,
        toolbar.locator(".git-actions-primary"),
        toolbar.locator(".git-actions-menu"),
        page.locator(".workspace-history-control:visible").first(),
        page.getByRole("tablist", { name: "Workspace view mode" }),
      ];
      const boxes = await Promise.all(
        alignedControls.map((control) => control.boundingBox()),
      );
      for (const box of boxes) {
        expect(box?.height).toBe(24);
        expect(box?.y).toBeCloseTo(boxes[0]!.y, 1);
      }
      const gitSeam = await toolbar.evaluate((group) => {
        const primary = group.querySelector(".git-actions-primary")!;
        const menu = group.querySelector(".git-actions-menu")!;
        return {
          gap:
            menu.getBoundingClientRect().left -
            primary.getBoundingClientRect().right,
          stroke:
            parseFloat(getComputedStyle(primary).borderRightWidth) +
            parseFloat(getComputedStyle(menu).borderLeftWidth),
        };
      });
      expect(gitSeam).toEqual({ gap: 0, stroke: 1 });

      expect(
        await page.getByText("System Prompts", { exact: true }).count(),
      ).toBe(systemPrompts);

      // The minimap menu renders in a portal outside the workspace subtree.
      await page
        .getByRole("button", { name: "Minimap layers", exact: true })
        .click();
      const popup = page.getByRole("menu");
      await expect(popup).toBeVisible();
      await expect(popup).toHaveCSS("opacity", "1");
      expect(
        await popup.evaluate((el) =>
          getComputedStyle(el).getPropertyValue("--popover").trim(),
        ),
      ).toBe(
        await page
          .locator("html")
          .evaluate((el) =>
            getComputedStyle(el).getPropertyValue("--popover").trim(),
          ),
      );
      await page.screenshot({
        path: path.resolve(
          "../../output/playwright/ui-themes",
          `${mode.label}-${appearance}-classic.png`,
        ),
      });
      await page.keyboard.press("Escape");
      await expect(popup).toBeHidden();
      await assignTheme(page, mode.id, "modern");
      expect(await workspaceGeometry(page)).toEqual(geometry);
    });
  }
}

test("theme assignments survive reload and follow changes from another window", async ({
  page,
  context,
}) => {
  await page.goto("/?debug=input-transfer");
  await assignTheme(page, "duet", "classic");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-theme",
    "classic",
  );
  const settings = await context.newPage();
  await settings.goto("/?settings");
  await expect(
    settings.getByText("Appearance", { exact: true }).first(),
  ).toBeVisible();
  await expect(settings.locator("html")).toHaveAttribute(
    "data-ui-theme",
    "modern",
  );
  await settings
    .getByRole("combobox", { name: "Duet theme", exact: true })
    .click();
  await settings.getByRole("option", { name: "Modern", exact: true }).click();
  await expect(
    settings.getByRole("combobox", { name: "Duet theme", exact: true }),
  ).toContainText("Modern");
  await settings.screenshot({
    path: path.resolve("../../output/playwright/ui-themes/settings.png"),
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "modern");
  await page.getByRole("tab", { name: "Artisan", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-theme",
    "classic",
  );
  await page.getByRole("tab", { name: "Duet", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "modern");
});
