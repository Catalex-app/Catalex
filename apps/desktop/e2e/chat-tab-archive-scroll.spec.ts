import { expect, test } from "@playwright/test";

for (const active of [true, false]) {
  test(`reveals archive confirmation on a short rightmost ${active ? "active" : "inactive"} chat`, async ({
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
      const resource = performance
        .getEntriesByType("resource")
        .find(
          (entry) =>
            new URL(entry.name).pathname ===
            "/src/renderer/stores/agent-chat-store.ts",
        );
      const { useAgentChatStore: store } = await import(resource!.name);
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
    await tab
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    const confirm = tab.getByRole("button", {
      name: "Confirm archive",
      exact: true,
    });
    const cancel = tab.getByRole("button", {
      name: "Cancel archive",
      exact: true,
    });
    await expect
      .poll(async () => {
        const visible = (await viewport.boundingBox())!;
        const bounds = (await cancel.boundingBox())!;
        return bounds.x + bounds.width <= visible.x + visible.width + 1;
      })
      .toBe(true);
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(cancel).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() =>
        tab.evaluate((element) => {
          const stroke = getComputedStyle(element, "::after");
          return {
            style: stroke.outlineStyle,
            width: stroke.outlineWidth,
            offset: stroke.outlineOffset,
            pointerEvents: stroke.pointerEvents,
          };
        }),
      )
      .toEqual({
        style: "solid",
        width: "1px",
        offset: "-1px",
        pointerEvents: "none",
      });
    expect(
      await viewport.evaluate((element) => element.scrollLeft),
    ).toBeGreaterThan(initialLeft);
    await panel.screenshot({
      path: testInfo.outputPath("archive-revealed.png"),
    });
    await tab.screenshot({
      path: testInfo.outputPath("archive-tab-outline.png"),
    });
    await cancel.click();
    await expect
      .poll(async () => (await tab.boundingBox())!.width)
      .toBe(initialWidth);
    expect(
      await page.evaluate(() => (window as any).archiveScrollCalls),
    ).toEqual([]);
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        tab.evaluate(
          (element) => getComputedStyle(element, "::after").outlineStyle,
        ),
      )
      .toBe(active ? "solid" : "none");
    await tab.hover();
    await tab
      .getByRole("button", { name: "Archive chat", exact: true })
      .click();
    await expect
      .poll(async () => {
        const visible = (await viewport.boundingBox())!;
        const bounds = (await cancel.boundingBox())!;
        return bounds.x + bounds.width <= visible.x + visible.width + 1;
      })
      .toBe(true);
    await confirm.click();
    expect(
      await page.evaluate(() => (window as any).archiveScrollCalls),
    ).toEqual(["archive-scroll-6"]);
  });
}
