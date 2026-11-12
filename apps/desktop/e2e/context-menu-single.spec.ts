import { expect, test, type Page, type Locator } from "@playwright/test";

async function rightClick(page: Page, target: Locator) {
  const bounds = (await target.boundingBox())!;
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
    { button: "right" },
  );
}

for (const dark of [false, true]) {
  test(`half-mode keeps one menu and releases it on dismissal, action, and unmount (${dark ? "dark" : "light"})`, async ({
    page,
  }) => {
    await page.goto("/?onboarding-demo&project");
    const panel = page.locator('[data-chat-drawer-panel="true"]');
    await expect(panel.locator("[data-chat-tab-strip]")).toBeVisible();
    if (dark)
      await page
        .locator("html")
        .evaluate((element) => element.classList.add("dark"));
    await page.evaluate(async () => {
      const { useAgentChatStore: store } = await import(
        /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
      );
      const base = store.getState().tabs[0];
      const tabs = ["First", "Second", "Third"].map((title) => ({
        ...base,
        id: title,
        title,
        archived: false,
        messages: [
          {
            type: "user",
            message: { content: [{ type: "text", text: "Earlier request" }] },
          },
        ],
        agentWorkspace: null,
        isStreaming: false,
        isSettling: false,
        turnPhase: null,
        pauseState: null,
        pendingQuestion: null,
        queuedPrompts: [],
      }));
      store.setState({
        tabs,
        activeTabId: "First",
        messages: tabs[0].messages,
        isStreaming: false,
        archiveTab: async (id: string) =>
          store.setState((state: any) => ({
            tabs: state.tabs.filter((tab: any) => tab.id !== id),
          })),
      });
    });
    const first = panel.locator('[data-chat-tab="First"]');
    const second = panel.locator('[data-chat-tab="Second"]');
    const third = panel.locator('[data-chat-tab="Third"]');
    const menus = page.locator(
      '[data-slot="context-menu-content"][data-state="open"]',
    );
    await rightClick(page, first);
    await expect(menus).toHaveCount(1);
    const originalPosition = await menus.boundingBox();
    for (const other of [second, third, first]) {
      await rightClick(page, other);
      await expect(menus).toHaveCount(1);
      await expect(first).toHaveAttribute("data-context-menu-open", "true");
      await expect(second).not.toHaveAttribute(
        "data-context-menu-open",
        "true",
      );
      await expect(third).not.toHaveAttribute("data-context-menu-open", "true");
      expect(await menus.boundingBox()).toEqual(originalPosition);
    }
    await page.screenshot({
      path: test.info().outputPath("single-menu.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-slot="context-menu-content"]'),
    ).toHaveCount(0);
    await rightClick(page, second);
    await expect(second).toHaveAttribute("data-context-menu-open", "true");
    await page.mouse.click(1200, 100);
    await expect(
      page.locator('[data-slot="context-menu-content"]'),
    ).toHaveCount(0);
    await rightClick(page, third);
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Confirm", exact: true }).click();
    await expect(third).toHaveCount(0);
    await expect(
      page.locator('[data-slot="context-menu-content"]'),
    ).toHaveCount(0);
    await rightClick(page, second);
    await expect(second).toHaveAttribute("data-context-menu-open", "true");
    await page.evaluate(async () => {
      const { useAgentChatStore: store } = await import(
        /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
      );
      store.setState((state: any) => ({
        tabs: state.tabs.filter((tab: any) => tab.id !== "Second"),
      }));
    });
    await expect(
      page.locator('[data-slot="context-menu-content"]'),
    ).toHaveCount(0);
    await rightClick(page, first);
    await expect(first).toHaveAttribute("data-context-menu-open", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
    await first.getByRole("button").click();
  });
}

test("context menu guards are independent between windows", async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  for (const target of [page, other]) {
    await target.goto("/?debug=context-menu");
    await target
      .getByRole("link", { name: "Reference link" })
      .click({ button: "right" });
    await expect(
      target.getByRole("menuitem", { name: "Open Link", exact: true }),
    ).toBeVisible();
  }
  await other.close();
  await expect(
    page.getByRole("menuitem", { name: "Open Link", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
});
