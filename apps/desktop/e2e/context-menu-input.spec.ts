import { expect, test, type Locator, type Page } from "@playwright/test";

async function clickPosition(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
}

for (const surface of ["sidebar", "popup", "half"] as const) {
  test(`${surface}: outside click only dismisses, next click works`, async ({
    page,
  }) => {
    await page.goto(
      surface === "half"
        ? "/?onboarding-demo&project"
        : "/?debug=session-navigation",
    );
    let source: Locator;
    let target: Locator;
    if (surface === "half") {
      await expect(page.locator("[data-chat-tab-strip]")).toBeVisible();
      await page.evaluate(async () => {
        const { useAgentChatStore: store } = await import(
          /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
        );
        const base = store.getState().tabs[0];
        store.setState({
          tabs: ["First", "Second"].map((id) => ({ ...base, id, title: id })),
          activeTabId: "First",
        });
      });
      source = page.locator('[data-chat-tab="First"]');
      target = page.locator('[data-chat-tab="Second"]');
    } else {
      if (surface === "popup")
        await page.getByRole("button", { name: "Session history" }).click();
      const region =
        surface === "sidebar"
          ? page.getByTestId("vibe-sessions")
          : page.locator('[data-slot="dropdown-menu-content"]');
      source = region.getByRole(surface === "sidebar" ? "button" : "menuitem", {
        name: /Background review/,
      });
      target = region.getByRole(surface === "sidebar" ? "button" : "menuitem", {
        name: /Saved conversation/,
        includeHidden: true,
      });
    }
    await source.click({ button: "right" });
    const menu = page.locator(
      '[data-slot="context-menu-content"][data-state="open"]',
    );
    await expect(menu).toHaveCount(1);
    await clickPosition(page, target);
    await expect(menu).toHaveCount(0);
    if (surface === "half")
      await expect(target).toHaveAttribute("data-active", "false");
    else
      await expect(page.getByTestId("active-title")).toHaveText(
        "Background review",
      );
    await expect(
      page.locator('[data-slot="context-menu-content"]'),
    ).toHaveCount(0);
    await target.click();
    if (surface === "half")
      await expect(target).toHaveAttribute("data-active", "true");
    else
      await expect(page.getByTestId("active-title")).toHaveText(
        "Saved conversation",
      );
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  });
}

test("menu owns keys and releases shortcuts after Escape", async ({ page }) => {
  await page.goto("/?debug=context-menu");
  await page.evaluate(() => {
    (window as any).backgroundKeys = [];
    window.addEventListener("keydown", (event) =>
      (window as any).backgroundKeys.push(event.key),
    );
    // Capture shortcuts are guarded before application handlers as well.
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey)
          (window as any).backgroundKeys.push("capture-shortcut");
      },
      true,
    );
  });
  await page.getByText("Existing file menu").click({ button: "right" });
  const menu = page.locator(
    '[data-slot="context-menu-content"][data-state="open"]',
  );
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await page.keyboard.press("m");
  await expect(
    menu.getByRole("menuitem", { name: "Move to Trash" }),
  ).toBeFocused();
  await page.keyboard.press("Control+n");
  await expect(menu).toHaveCount(1);
  await expect
    .poll(() => page.evaluate(() => (window as any).backgroundKeys))
    .toEqual([]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("textbox", { name: "Text input", exact: true }).click();
  await page.keyboard.press("x");
  await expect
    .poll(() => page.evaluate(() => (window as any).backgroundKeys))
    .toContain("x");
});
