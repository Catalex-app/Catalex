import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener(
      "app-visibility-restored",
      () => {
        document.documentElement.dataset.startupRecovered = "true";
      },
      { once: true },
    );
  });
  await page.goto("/?debug=input-transfer");
  await expect(
    page.locator("[data-chat-drawer-panel] [data-chat-composer-input]:visible"),
  ).toHaveCount(1);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-startup-recovered",
    "true",
  );
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
}

for (const mode of ["Collapsed", "Expanded", "Workspace"]) {
  test(`command insertion and picker placement in ${mode}`, async ({
    page,
  }) => {
    await workspace(page);
    if (mode !== "Collapsed") {
      await page
        .locator(`[data-chat-display="${mode}"]`)
        .evaluate((el) => (el as HTMLElement).click());
      await expect(
        page.locator("[data-workspace-layout-animating]"),
      ).toHaveAttribute("data-workspace-layout-animating", "false");
    }
    const panel = page.locator(
      mode === "Workspace"
        ? "[data-workspace-chat-pane]"
        : "[data-chat-drawer-panel]",
    );
    const input = panel.locator("[data-chat-composer-input]:visible");
    const surface = panel.locator("[data-chat-composer-surface]:visible");
    if (mode !== "Collapsed") {
      await expect(
        panel.locator('[data-prompt-suggestions="cards"]'),
      ).toBeVisible();
      await expect(page.locator(`[data-chat-display="${mode}"]`)).toBeEnabled();
    }
    await expect(
      panel.locator("[data-composer-transfer-phase]"),
    ).toHaveAttribute("data-composer-transfer-phase", "idle");
    const popup = page
      .locator('[data-ui-surface="popover"]')
      .filter({ has: page.getByRole("button", { name: /\/compact/ }) });
    await input.fill("Please keep this draft");
    await expect(input).toHaveValue("Please keep this draft");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(0, 0),
    );
    await input.pressSequentially("/com");
    await expect(input).toHaveValue("/comPlease keep this draft");
    const command = popup.getByRole("button", { name: /\/compact/ });
    await expect(command).toBeVisible();
    const gap = async () => {
      const box = (await popup.boundingBox())!;
      return (await surface.boundingBox())!.y - box.y - box.height;
    };
    await expect.poll(gap).toBeCloseTo(8, 0);
    await expect(popup).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: test.info().outputPath(`commands-${mode}-expanded.png`),
    });
    if (mode === "Collapsed") await input.press("Enter");
    else await command.click();
    await expect(input).toHaveValue("/compact Please keep this draft");
    await expect(input).toBeFocused();
    await expect
      .poll(() =>
        input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
      )
      .toBe(9);
    await input.pressSequentially("extra ");
    await expect(input).toHaveValue("/compact extra Please keep this draft");

    // Complete a command in the middle without deleting the suffix.
    await input.fill("Before /com after");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(11, 11),
    );
    await input.pressSequentially("p");
    await expect(command).toBeVisible();
    await input.press("Tab");
    await expect(input).toHaveValue("Before /compact after");

    if (mode !== "Collapsed") {
      await input.fill("Keep this");
      await input.press("End");
      await panel
        .getByRole("button", { name: "/ for commands", exact: true })
        .click();
      await input.pressSequentially("com");
      await expect(command).toBeVisible();
      await command.click();
      await expect(input).toHaveValue("Keep this /compact ");
      await panel
        .getByRole("button", { name: "Hide prompt cards", exact: true })
        .click();
      await input.fill("/com");
      await expect(command).toBeVisible();
      await expect.poll(gap).toBeCloseTo(8, 0);
      await expect(popup).toHaveCSS("opacity", "1");
      await page.screenshot({
        path: test.info().outputPath(`commands-${mode}-folded.png`),
      });
      await input.press("Escape");
    }

    await input.fill("Keep @mai");
    const mentions = page.locator('[data-ui-surface="popover"]').filter({
      has: page.getByRole("button").filter({ hasText: "main.tex" }),
    });
    await expect(mentions).toBeVisible();
    await expect
      .poll(async () => {
        const box = (await mentions.boundingBox())!;
        return (await surface.boundingBox())!.y - box.y - box.height;
      })
      .toBeCloseTo(8, 0);
    await mentions.getByRole("button").filter({ hasText: "main.tex" }).click();
    await expect(input).toHaveValue("Keep ");
    await expect(
      panel.getByRole("button", {
        name: "Show file @main.tex",
        exact: true,
      }),
    ).toBeVisible();
    if (mode !== "Collapsed") {
      const shortcuts = surface.locator("[data-composer-shortcuts]");
      await expect(shortcuts).toBeVisible();
      await surface.evaluate((el) => {
        (el as HTMLElement).style.width = "300px";
      });
      await expect(shortcuts).toBeHidden();
      const controls = surface.locator("[data-composer-controls]");
      const controlsBox = (await controls.boundingBox())!;
      const surfaceBox = (await surface.boundingBox())!;
      expect(controlsBox.x).toBeGreaterThanOrEqual(surfaceBox.x);
      expect(controlsBox.x + controlsBox.width).toBeLessThanOrEqual(
        surfaceBox.x + surfaceBox.width,
      );
      await surface.screenshot({
        path: test.info().outputPath(`narrow-toolbar-${mode}.png`),
        animations: "disabled",
      });
      await input.fill("/com");
      await expect(command).toBeVisible();
      await input.press("Escape");
      await surface.evaluate((el) => {
        (el as HTMLElement).style.removeProperty("width");
      });
      await expect(shortcuts).toBeVisible();
    }
  });
}
