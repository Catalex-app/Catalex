import { expect, type Locator, test, type Page } from "@playwright/test";
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

test("Modern and Classic popups use their themed glass finish", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const root = page.locator("html");
  await expect(root).toHaveAttribute("data-ui-theme", "modern");
  await page
    .getByRole("button", { name: "Minimap layers", exact: true })
    .click();
  const popup = page.getByRole("menu");
  async function expectPopupSurface(background: string, filter: string) {
    const fill = await popup.evaluate((el, background) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = background;
      el.append(sample);
      const color = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return color;
    }, background);
    await expect(popup).toHaveCSS("background-color", fill);
    await expect(popup).toHaveCSS("backdrop-filter", filter);
  }

  const modernGlass = "color-mix(in srgb, var(--popover) 86%, transparent)";
  const modernBlur = "blur(18px) saturate(0.9)";
  for (const dark of [false, true]) {
    await root.evaluate((el, dark) => {
      el.classList.toggle("dark", dark);
      el.removeAttribute("data-workspace-vibrancy");
    }, dark);
    await expectPopupSurface(modernGlass, modernBlur);
    await root.evaluate((el) => el.setAttribute("data-workspace-vibrancy", ""));
    await expectPopupSurface(modernGlass, modernBlur);
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
  await expectPopupSurface("var(--background)", "none");
  await root.evaluate((el) => el.setAttribute("data-ui-theme", "modern"));
  await expectPopupSurface("var(--popover)", "none");
});

async function dialogFinish(dialog: Locator) {
  return dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    const overlay = getComputedStyle(
      document.querySelector(
        '[data-slot="dialog-overlay"][data-state="open"]',
      )!,
    );
    return {
      background: style.backgroundColor,
      texture: style.backgroundImage,
      textureSize: style.backgroundSize,
      filter: style.backdropFilter,
      foreground: style.color,
      border: style.border,
      shadow: style.boxShadow,
      radius: style.borderRadius,
      padding: style.padding,
      overlayBackground: overlay.backgroundColor,
      overlayFilter: overlay.backdropFilter,
    };
  });
}

for (const theme of ["modern", "classic"]) {
  for (const appearance of ["light", "dark"]) {
    test(`New File shares the Git setup dialog finish in ${theme} ${appearance}`, async ({
      page,
    }) => {
      async function setTheme() {
        await page.locator("html").evaluate(
          (root, { theme, appearance }) => {
            root.setAttribute("data-ui-theme", theme);
            root.classList.toggle("dark", appearance === "dark");
          },
          { theme, appearance },
        );
      }

      await page.goto("/?debug=git-actions&repo=none");
      const setup = page.getByRole("button", { name: "Set up Git" });
      await expect(setup).toBeVisible();
      await setTheme();
      await setup.click();
      const git = page.getByTestId("git-setup-dialog");
      await expect(git).toBeVisible();
      const reference = await dialogFinish(git);
      expect(reference).toMatchObject({
        radius: theme === "classic" ? "4px" : "20px",
        padding: "16px",
        filter:
          theme === "modern"
            ? "none"
            : appearance === "light"
              ? "blur(10px) saturate(1.1)"
              : "blur(18px) saturate(1.1)",
        overlayBackground: "oklab(0 0 0 / 0.1)",
        overlayFilter: "none",
      });
      if (theme === "modern") {
        expect(reference.background).toBe(
          appearance === "light" ? "oklch(0.97 0 0)" : "rgb(10, 10, 10)",
        );
      }
      await expect(git.getByRole("button", { name: "Close" })).toHaveCount(1);

      await page.goto("/?debug=sidebar-animation&trash-confirmation");
      const add = page
        .locator('[data-sidebar-section="files"]')
        .getByRole("button", { name: "Add", exact: true });
      await expect(add).toBeVisible();
      await setTheme();
      await add.click();
      await page
        .getByRole("menuitem", { name: "New File", exact: true })
        .click();
      const plain = page.getByRole("dialog", { name: "New File", exact: true });
      await expect(plain).toBeVisible();
      expect(await dialogFinish(plain)).toEqual(reference);
      await expect(plain.getByRole("button", { name: "Close" })).toHaveCount(0);
      await plain.getByRole("button", { name: "Cancel" }).click();
      await expect(plain).toBeHidden();
    });
  }
}

test("workspace panels share theme surfaces and Markdown preview keeps its own", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace");
  const markdown = page.getByTestId("markdown-preview");
  const editor = page.locator("[data-workspace-editor-shell]");
  const editorPanel = editor.locator("[data-workspace-panel-screen]");
  const editorHeader = editorPanel.locator("[data-workspace-panel-header]");
  const previewPanel = page
    .locator("[data-workspace-panel-screen]")
    .filter({ has: markdown });
  const previewHeader = markdown.getByTestId("markdown-preview-toolbar");
  await expect(editorHeader).toBeVisible();
  await expect(previewHeader).toBeVisible();
  const root = page.locator("html");
  await root.evaluate((root) => root.setAttribute("data-ui-theme", "modern"));

  const sidebar = page.locator("[data-project-sidebar] > .bg-background");
  const titlebar = page.locator("[data-workspace-titlebar]");
  const transparent = "rgba(0, 0, 0, 0)";
  const themeColor = (token: "--background" | "--sidebar") =>
    editorPanel.evaluate((element, token) => {
      const sample = document.createElement("span");
      sample.style.backgroundColor = `var(${token})`;
      element.append(sample);
      const color = getComputedStyle(sample).backgroundColor;
      sample.remove();
      return color;
    }, token);
  for (const [appearance, tint] of [
    ["dark", "rgba(0, 0, 0, 0.7)"],
    ["light", "rgba(255, 255, 255, 0.9)"],
  ]) {
    await root.evaluate((element, appearance) => {
      element.classList.remove("light", "dark");
      element.classList.add(appearance);
    }, appearance);
    const backing = await themeColor("--background");
    const solidChrome = await themeColor("--sidebar");
    for (const vibrancy of [false, true]) {
      await root.evaluate((element, vibrancy) => {
        element.toggleAttribute("data-workspace-vibrancy", vibrancy);
      }, vibrancy);

      await expect(editorPanel).toHaveCSS("background-color", backing);
      await expect(editorHeader).toHaveCSS("background-color", transparent);
      await expect(editorPanel.locator(".cm-editor")).toHaveCSS(
        "background-color",
        transparent,
      );
      await expect(editorPanel.locator(".cm-gutters")).toHaveCSS(
        "background-color",
        transparent,
      );
      await expect(root).toHaveCSS(
        "background-color",
        vibrancy ? tint : solidChrome,
      );
      for (const chrome of [sidebar, titlebar]) {
        await expect(chrome).toHaveCSS(
          "background-color",
          vibrancy ? transparent : solidChrome,
        );
      }
    }
  }

  await expect(editorHeader).toHaveAttribute(
    "data-workspace-separator",
    "header",
  );
  await expect(previewHeader).toHaveAttribute(
    "data-workspace-separator",
    "header",
  );
  await expect(editorHeader).toHaveCSS("border-image-source", /8px/);
  await expect(editorHeader).toHaveCSS("background-color", transparent);
  await expect(editorPanel.locator(".cm-editor")).toHaveCSS(
    "background-color",
    transparent,
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

  const previewBacking = await previewPanel.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const solidBacking = await themeColor("--background");
  async function expectSolidBackingDuringMotion(
    direction: "entering" | "exiting",
  ) {
    const frames = await editorPanel.evaluate((panel, direction) => {
      const frames: { progress: number; background: string }[] = [];

      return new Promise<typeof frames>((resolve) => {
        const observer = new MutationObserver(() => {
          if (panel.getAttribute("data-panel-expansion-motion") !== direction) {
            if (frames.length) {
              observer.disconnect();
              resolve(frames);
            }
            return;
          }
          frames.push({
            progress: Number(
              panel.style.getPropertyValue("--expanded-panel-elevation"),
            ),
            background: getComputedStyle(panel).backgroundColor,
          });
        });
        observer.observe(panel, {
          attributeFilter: ["style", "data-panel-expansion-motion"],
        });
        if (direction === "entering") {
          panel
            .querySelector("[data-panel-header-space]")!
            .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        } else {
          panel
            .querySelector<HTMLButtonElement>(
              '[data-panel-floating-controls] [aria-label="Restore Editor"]',
            )!
            .click();
        }
      });
    }, direction);
    expect(
      new Set(
        frames.map(({ progress }) => progress).filter((p) => p > 0 && p < 1),
      ).size,
    ).toBeGreaterThan(1);
    expect(new Set(frames.map(({ background }) => background))).toEqual(
      new Set([solidBacking]),
    );
  }
  await expectSolidBackingDuringMotion("entering");
  await expect(editorPanel).toHaveAttribute(
    "data-expanded-workspace-panel",
    "Editor",
  );
  await expect(editorPanel).toHaveCSS("background-color", solidBacking);
  await expect(editorHeader).toHaveCSS("background-color", transparent);
  await expect(editorPanel.locator(".cm-editor")).toHaveCSS(
    "background-color",
    transparent,
  );
  await expectSolidBackingDuringMotion("exiting");
  await expect(editorPanel).not.toHaveAttribute(
    "data-expanded-workspace-panel",
  );
  await expect(editorPanel).toHaveCSS("background-color", solidBacking);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await editorHeader.locator("[data-panel-header-space]").dblclick();
  await expect(editorPanel).toHaveAttribute(
    "data-expanded-workspace-panel",
    "Editor",
  );
  await expect(editorPanel).not.toHaveAttribute("data-panel-expansion-motion");
  await expect(editorPanel).toHaveCSS("background-color", solidBacking);
  await page
    .getByRole("button", { name: "Restore Editor", exact: true })
    .click();
  await expect(editorPanel).toHaveCSS("background-color", solidBacking);

  await previewHeader.locator("[data-panel-header-space]").dblclick();
  await expect(previewPanel).toHaveAttribute(
    "data-expanded-workspace-panel",
    "Preview",
  );
  await expect(previewPanel).toHaveCSS("background-color", previewBacking);
  await expect(markdown).toHaveCSS("background-color", previewBackground);
  await expect(previewHeader).toHaveCSS("background-color", previewBackground);
  await page
    .getByRole("button", { name: "Restore Preview", exact: true })
    .click();
  await expect(previewPanel).not.toHaveAttribute(
    "data-expanded-workspace-panel",
  );

  await root.evaluate((root) => {
    root.setAttribute("data-ui-theme", "classic");
    root.removeAttribute("data-workspace-vibrancy");
  });
  await expect(editorHeader).toHaveCSS("border-image-source", "none");
  await expect(editorPanel).toHaveCSS("border-radius", "4px");
  await expect(editorPanel).toHaveCSS("background-color", solidBacking);
  await expect(previewPanel).toHaveCSS("background-color", previewBacking);
  await expect(previewHeader).toHaveCSS("background-color", previewBackground);
  await expect(previewHeader).toHaveCSS("border-image-source", "none");
});

const editorThemeVariants = [
  { theme: "modern", dark: false },
  { theme: "modern", dark: true },
  { theme: "classic", dark: false },
  { theme: "classic", dark: true },
] as const;

async function editorPanelColors(panel: Locator) {
  return panel.evaluate((element, variants) => {
    const root = document.documentElement;
    const editor = element.querySelector(".cm-editor");
    const header = element.querySelector("[data-workspace-panel-header]")!;
    const surface =
      editor ??
      element.querySelector("[data-workspace-content-surface]") ??
      element.querySelector("[data-drawer-host]")!;
    const gutter = editor?.querySelector(".cm-gutters");
    const background = (node: Element) =>
      getComputedStyle(node).backgroundColor;
    const paintedBackground = (node: Element) => {
      while (node !== element && background(node) === "rgba(0, 0, 0, 0)") {
        node = node.parentElement!;
      }
      return background(node);
    };
    return variants.map(({ theme, dark }) => {
      root.dataset.uiTheme = theme;
      root.toggleAttribute("data-workspace-vibrancy", theme === "modern");
      root.classList.remove("light", "dark");
      root.classList.add(dark ? "dark" : "light");
      return {
        theme,
        dark,
        panel: background(element),
        header: background(header),
        surface: paintedBackground(surface),
        gutter: gutter ? background(gutter) : null,
      };
    });
  }, editorThemeVariants);
}

test("review, conflict and large-file panels share the normal editor surface", async ({
  page,
}) => {
  const panels = page.locator(
    "[data-workspace-editor-shell] [data-workspace-panel-screen]",
  );
  await page.goto("/?debug=editor-diff&deferDiff=1&gitHead=untracked");
  const normal = panels.filter({ has: page.locator(".cm-gitChangeGutter") });
  await expect(normal.locator(".cm-content")).toBeVisible();
  const reference = await editorPanelColors(normal);
  const withoutGutter = reference.map((colors) => ({
    ...colors,
    gutter: null,
  }));

  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = (await import(
      path
    )) as typeof import("@/stores/document-store");
    useDocumentStore.setState((state) => ({
      files: state.files.map((file) =>
        file.id === state.activeFileId
          ? { ...file, content: undefined, fileSize: 12 * 1024 * 1024 }
          : file,
      ),
    }));
  });
  const openAnyway = page.getByRole("button", { name: "Open Anyway" });
  await expect(openAnyway).toBeVisible();
  expect(await editorPanelColors(panels.filter({ has: openAnyway }))).toEqual(
    withoutGutter,
  );

  await page.goto("/?debug=agent-file-review");
  await page.getByText("results.png", { exact: true }).first().click();
  const original = page.getByRole("region", {
    name: "Current file",
    exact: true,
  });
  await expect(original.locator("img")).toBeVisible();
  expect(await editorPanelColors(panels.filter({ has: original }))).toEqual(
    withoutGutter,
  );

  await page.goto("/?debug=git-actions&recovery=binary&workspace=1");
  await page.getByText("figure.png", { exact: true }).first().click();
  const current = page.getByRole("region", {
    name: "Current version",
    exact: true,
  });
  await expect(current.locator("img")).toBeVisible();
  expect(await editorPanelColors(panels.filter({ has: current }))).toEqual(
    withoutGutter,
  );

  await page.goto("/?debug=editor-diff&gitConflict=1");
  const conflict = panels.filter({ has: page.locator(".cm-gitConflictMerge") });
  await expect(conflict.locator(".cm-changeGutter")).toBeVisible();
  expect(await editorPanelColors(conflict)).toEqual(reference);
});
