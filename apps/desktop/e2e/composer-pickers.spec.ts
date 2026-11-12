import { expect, test, type Locator, type Page } from "@playwright/test";

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

test("Mini fits a draft beside separate model and permission controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace(page);
  const drawer = page.locator("[data-chat-drawer-panel]");
  const input = drawer.locator("[data-chat-composer-input]");
  const model = drawer.getByRole("button", {
    name: "Model settings",
    exact: true,
  });
  const permission = drawer.getByRole("button", {
    name: "Writing permission",
    exact: true,
  });
  await expect(permission.locator("svg.lucide-thumbs-up")).toBeVisible();
  const send = drawer.getByRole("button", { name: "Send", exact: true });
  const sendGaps = () =>
    send.evaluate((button) => {
      const surface = button.closest("[data-chat-composer-surface]")!;
      const inputBounds = surface.getBoundingClientRect();
      const sendBounds = button.getBoundingClientRect();
      const border = getComputedStyle(surface);
      return {
        top:
          sendBounds.top - inputBounds.top - parseFloat(border.borderTopWidth),
        bottom:
          inputBounds.bottom -
          sendBounds.bottom -
          parseFloat(border.borderBottomWidth),
        right:
          inputBounds.right -
          sendBounds.right -
          parseFloat(border.borderRightWidth),
      };
    });
  const inputHeight = () => input.evaluate((element) => element.clientHeight);
  await input.fill("Keep this draft while resizing");
  const effort = model.getByText("M", { exact: true });
  await expect(effort).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("mini-wide-effort.png"),
  });
  const wideHeight = await inputHeight();
  await page.setViewportSize({ width: 800, height: 600 });
  await expect
    .poll(async () => {
      const inputBounds = (await input.boundingBox())!;
      const sendBounds = (await send.boundingBox())!;
      return sendBounds.y >= inputBounds.y + inputBounds.height;
    })
    .toBe(true);
  await expect.poll(inputHeight).toBe(wideHeight);
  await expect(effort).toBeHidden();
  await expect.poll(sendGaps).toMatchObject({ bottom: 8, right: 8 });
  await input.clear();
  await expect.poll(sendGaps).toEqual({ top: 8, bottom: 8, right: 8 });
  await page.screenshot({
    path: test.info().outputPath("mini-empty-800px.png"),
  });
  await input.fill("Keep this draft");
  await expect.poll(sendGaps).toEqual({ top: 8, bottom: 8, right: 8 });
  const inputBox = (await input.boundingBox())!;
  const permissionTriggerBox = (await permission.boundingBox())!;
  const modelBox = (await model.boundingBox())!;
  const sendBox = (await send.boundingBox())!;
  const surfaceBox = (await drawer
    .locator("[data-chat-composer-surface]")
    .boundingBox())!;
  for (const box of [inputBox, permissionTriggerBox, modelBox]) {
    expect(box.y + box.height / 2).toBe(sendBox.y + sendBox.height / 2);
  }
  expect(
    await input.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth &&
        element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(
    permissionTriggerBox.x,
  );
  expect(
    permissionTriggerBox.x + permissionTriggerBox.width,
  ).toBeLessThanOrEqual(modelBox.x);
  expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(
    surfaceBox.x + surfaceBox.width,
  );
  const center = async (locator: Locator) => {
    const { x, width } = (await locator.boundingBox())!;
    return x + width / 2;
  };
  await page.screenshot({ path: test.info().outputPath("mini-800px.png") });

  await model.press("Enter");
  const models = page.getByRole("dialog", {
    name: "Model settings",
    exact: true,
  });
  await expect(models).toBeFocused();
  await expect(
    models.locator("[data-model-provider] button").first(),
  ).toBeVisible();
  await expect
    .poll(async () => Math.abs((await center(models)) - (await center(model))))
    .toBeLessThan(1);
  await expect(
    models.getByRole("button", { name: "Need approval", exact: true }),
  ).toHaveCount(0);
  await permission.click();
  await expect(models).toHaveCount(0);
  const popup = page.getByRole("dialog", {
    name: "Writing permission",
    exact: true,
  });
  await expect(
    popup.getByRole("heading", { name: "Permission", exact: true }),
  ).toBeVisible();
  await expect(popup.locator("[data-model-provider]")).toHaveCount(0);
  await expect
    .poll(async () =>
      Math.abs((await center(popup)) - (await center(permission))),
    )
    .toBeLessThan(1);
  const permissions = popup.getByRole("group", {
    name: "Writing permission",
  });
  await expect(popup.getByRole("separator")).toBeVisible();
  await expect(
    permissions.getByRole("button", { name: "Need approval", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(popup).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: test.info().outputPath("mini-permission.png"),
  });
  const auto = permissions.getByRole("button", {
    name: "Auto-apply",
    exact: true,
  });
  await expect(auto).not.toHaveClass(/\btext-purple-700\b/);
  await auto.click();
  await expect(auto).toHaveAttribute("aria-pressed", "true");
  await expect(auto).toHaveClass(/\btext-purple-700\b/);
  await popup.screenshot({
    path: test.info().outputPath("permission-popup-auto-apply.png"),
    animations: "disabled",
  });
  await auto.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(permission).toBeFocused();
  await expect(permission).toHaveAttribute("aria-description", "Auto-apply");
  await expect(permission.locator("svg.lucide-check-check")).toBeVisible();
  await expect(permission).toHaveClass(/\btext-purple-700\b/);
  await page.screenshot({
    path: test.info().outputPath("mini-permission-auto-apply.png"),
  });
  await expect(input).toHaveValue("Keep this draft");
});

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
    const send = panel.getByRole("button", { name: "Send", exact: true });
    await expect
      .poll(() =>
        send.evaluate((button) => {
          const model = button
            .closest("[data-chat-composer-surface]")!
            .querySelector('[aria-label$="Model settings"]')!;
          return (
            button.getBoundingClientRect().left -
            model.getBoundingClientRect().right
          );
        }),
      )
      .toBeCloseTo(4, 1);
    if (mode !== "Collapsed") {
      const permission = panel.getByRole("button", {
        name: "Writing permission",
        exact: true,
      });
      await permission.press("Enter");
      const popup = page.getByRole("dialog", {
        name: "Writing permission",
        exact: true,
      });
      const auto = popup.getByRole("button", {
        name: "Auto-apply",
        exact: true,
      });
      await auto.click();
      await expect(auto).toHaveAttribute("aria-pressed", "true");
      await auto.press("Escape");
      await expect(popup).toHaveCount(0);
      await expect(permission).toBeFocused();
    }
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
        .getByRole("button", { name: "/ commands", exact: true })
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
        (el as HTMLElement).style.width = "280px";
      });
      await expect(shortcuts).toHaveCSS("opacity", "0");
      const controls = surface.locator("[data-composer-controls]");
      const agentControls = controls.locator("[data-composer-agent-controls]");
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
      const more = surface.getByRole("button", {
        name: "Show composer shortcuts",
      });
      const less = surface.getByRole("button", {
        name: "Hide composer shortcuts",
      });
      const commands = shortcuts.getByRole("button", { name: "/ commands" });
      const mention = shortcuts.getByRole("button", { name: "@ mention" });
      const sendBox = await send.boundingBox();
      const toggleBox = await more.boundingBox();
      await more.click();
      await expect(less).toHaveAttribute("aria-expanded", "true");
      expect(await less.boundingBox()).toEqual(toggleBox);
      await expect(agentControls).toHaveCSS("opacity", "0");
      await send.click({ trial: true });
      expect(await send.boundingBox()).toEqual(sendBox);
      await surface.screenshot({
        path: test.info().outputPath(`expanded-shortcuts-${mode}.png`),
        animations: "disabled",
      });
      await less.click();
      await expect(more).toBeFocused();
      await expect(agentControls).toHaveCSS("opacity", "1");
      await more.press("Enter");
      await expect(less).toBeFocused();
      await commands.press("Escape");
      await expect(more).toBeFocused();

      await input.fill("");
      await more.click();
      await commands.click();
      await expect(more).toBeVisible();
      await expect(agentControls).toHaveCSS("opacity", "1");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("/");
      await input.pressSequentially("com");
      await expect(command).toBeVisible();
      await input.press("Escape");

      await input.fill("");
      await more.click();
      const mentionBox = (await mention.boundingBox())!;
      await mention.click({
        position: { x: mentionBox.width - 2, y: mentionBox.height / 2 },
      });
      await expect(more).toBeVisible();
      await expect(agentControls).toHaveCSS("opacity", "1");
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("@");
      await input.press("Escape");

      await surface.evaluate((el) => {
        (el as HTMLElement).style.removeProperty("width");
      });
      await expect(shortcuts).toHaveCSS("opacity", "1");
      await expect(more).toBeHidden();
    }
  });
}
