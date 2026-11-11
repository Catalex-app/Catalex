import { expect, test } from "@playwright/test";

for (const active of [true, false]) {
  test(`confirms archive in the menu without resizing a short rightmost ${active ? "active" : "inactive"} chat`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (!active) await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/?onboarding-demo&project");
    const panel = page.locator('[data-chat-drawer-panel="true"]');
    await expect(panel.locator("[data-chat-tab-strip]")).toBeVisible();
    if (!active)
      await page
        .locator("html")
        .evaluate((element) => element.classList.add("dark"));
    await page.evaluate(async (active) => {
      const { useAgentChatStore: store } = await import(
        /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
      );
      const base = store.getState().tabs[0];
      const tabs = Array.from({ length: 7 }, (_, index) => ({
        ...base,
        id: `archive-scroll-${index}`,
        title: index === 6 ? "Hi" : `Earlier conversation ${index + 1}`,
        messages: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "Earlier request" }] },
          },
        ],
        history: undefined,
        agentWorkspace: null,
        isStreaming: false,
        isSettling: false,
        turnPhase: null,
        pauseState: null,
        pendingQuestion: null,
        queuedPrompts: [],
        archived: false,
      }));
      (window as any).archiveScrollCalls = [];
      store.setState({
        tabs,
        activeTabId: active ? tabs[6].id : tabs[0].id,
        messages: tabs[0].messages,
        isStreaming: false,
        archiveTab: async (id: string) => {
          (window as any).archiveScrollCalls.push(id);
        },
      });
    }, active);
    const tab = panel.locator('[data-chat-tab="archive-scroll-6"]');
    const strip = panel.locator("[data-chat-tab-strip]");
    const viewport = strip.locator("..");
    // Settle automatic selection scrolling, then expose the short final tab.
    await expect
      .poll(() =>
        tab.evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThan(132);
    await viewport.evaluate((element) =>
      element.scrollTo({ left: element.scrollWidth, behavior: "instant" }),
    );
    await tab.hover();
    const initialWidth = (await tab.boundingBox())!.width;
    const initialLeft = await viewport.evaluate(
      (element) => element.scrollLeft,
    );
    await tab.click({ button: "right" });
    const menu = page.locator(
      '[data-slot="context-menu-content"][data-state="open"]',
    );
    await menu.getByRole("menuitem").first().hover();
    await expect
      .poll(() =>
        tab.evaluate(
          (element) => getComputedStyle(element, "::after").outlineStyle,
        ),
      )
      .toBe("solid");

    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    const confirm = page.getByRole("menuitem", {
      name: "Confirm",
      exact: true,
    });
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(confirm.locator(".trash-menu-confirmation")).toHaveCSS(
      "background-color",
      active ? "rgb(23, 23, 23)" : "rgb(255, 255, 255)",
    );
    await expect(confirm.locator(".trash-menu-confirmation")).toHaveCSS(
      "color",
      active ? "rgb(255, 255, 255)" : "rgb(23, 23, 23)",
    );
    expect((await tab.boundingBox())!.width).toBe(initialWidth);
    expect(await viewport.evaluate((element) => element.scrollLeft)).toBe(
      initialLeft,
    );
    await page.screenshot({
      path: testInfo.outputPath("archive-menu-confirmation.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() => (window as any).archiveScrollCalls),
    ).toEqual([]);
    await tab.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Archive chat", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .press("Enter");
    await expect(confirm).toBeVisible();
    await confirm.press("Enter");
    expect(
      await page.evaluate(() => (window as any).archiveScrollCalls),
    ).toEqual(["archive-scroll-6"]);
  });
}
