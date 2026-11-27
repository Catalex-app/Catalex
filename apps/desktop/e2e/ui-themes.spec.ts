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

test("theme assignments survive reload and follow changes from another window @core", async ({
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

test("Modern popups are solid and Classic popups keep their glass finish", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-ui-theme", "modern");
  await page
    .getByRole("button", { name: "Minimap layers", exact: true })
    .click();
  const popup = page.getByRole("menu");
  async function expectSolidBackground() {
    const fill = await popup.evaluate((el) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = "var(--background)";
      el.append(sample);
      const color = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return color;
    });
    await expect(popup).toHaveCSS("background-color", fill);
    await expect(popup).toHaveCSS("backdrop-filter", "none");
  }

  for (const dark of [false, true]) {
    await root.evaluate((el, dark) => {
      el.classList.toggle("dark", dark);
      el.removeAttribute("data-workspace-vibrancy");
    }, dark);
    await expectSolidBackground();
    await root.evaluate((el) => el.setAttribute("data-workspace-vibrancy", ""));
    await expectSolidBackground();
  }

  await root.evaluate((el) => {
    el.setAttribute("data-ui-theme", "classic");
    el.removeAttribute("data-workspace-vibrancy");
    el.classList.remove("dark");
  });
  await expect(popup).toHaveCSS("background-color", /\/ 0\.8\)$/);
  await expect(popup).toHaveCSS("backdrop-filter", "blur(10px) saturate(1.1)");
  await root.evaluate((el) => el.classList.add("dark"));
  await expect(popup).toHaveCSS("background-color", /\/ 0\.95\)$/);
  await expect(popup).toHaveCSS("backdrop-filter", "blur(18px) saturate(1.1)");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await expectSolidBackground();
  await root.evaluate((el) => el.setAttribute("data-ui-theme", "modern"));
  await expectSolidBackground();
});

test("workspace panels share theme surfaces and Markdown preview keeps its own", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace");
  const markdown = page.getByTestId("markdown-preview");
  const editor = page.locator("[data-workspace-editor-shell]");
  const editorPanel = editor.locator("[data-workspace-panel-screen]");
  const editorHeader = editorPanel.locator("[data-workspace-panel-header]");
  const previewHeader = markdown.getByTestId("markdown-preview-toolbar");
  await expect(editorHeader).toBeVisible();
  await expect(previewHeader).toBeVisible();
  await page.locator("html").evaluate((root) => {
    root.setAttribute("data-ui-theme", "modern");
    root.setAttribute("data-workspace-vibrancy", "");
  });

  await expect(editorHeader).toHaveAttribute(
    "data-workspace-separator",
    "header",
  );
  await expect(previewHeader).toHaveAttribute(
    "data-workspace-separator",
    "header",
  );
  await expect(editorPanel).toHaveCSS("background-color", /\/ 0\.25\)/);
  await expect(editorHeader).toHaveCSS("border-image-source", /8px/);
  await expect(editorHeader).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(editorPanel.locator(".cm-editor")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator("[data-workspace-panel-own-surface]")).toHaveCount(
    1,
  );
  await expect(markdown).toHaveAttribute(
    "data-workspace-panel-own-surface",
    "",
  );
  const previewBackground = await markdown.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(previewHeader).toHaveCSS("background-color", previewBackground);
  await expect(previewHeader).toHaveCSS("border-image-source", /8px/);

  await page.locator("html").evaluate((root) => {
    root.setAttribute("data-ui-theme", "classic");
    root.removeAttribute("data-workspace-vibrancy");
  });
  await expect(editorHeader).toHaveCSS("border-image-source", "none");
  await expect(editorPanel).toHaveCSS("border-radius", "4px");
  await expect(previewHeader).toHaveCSS("background-color", previewBackground);
  await expect(previewHeader).toHaveCSS("border-image-source", "none");
});
