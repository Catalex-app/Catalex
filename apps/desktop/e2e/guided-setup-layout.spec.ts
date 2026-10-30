import { expect, test, type Page } from "@playwright/test";

// These tests cover returning-user creation flows, not first-run onboarding.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    );
  });
});

async function openGuidedSetup(page: Page) {
  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("menuitem", { name: "Choose Template" }).click();
  await expect(page.getByTestId("template-gallery")).toBeVisible();
}

async function enableProjectActions(page: Page) {
  await page.evaluate(async () => {
    const [{ useClaudeSetupStore }, { useCodexSetupStore }] = await Promise.all(
      [
        import("/src/renderer/stores/claude-setup-store.ts"),
        import("/src/renderer/stores/codex-setup-store.ts"),
      ],
    );
    useClaudeSetupStore.setState({
      status: "ready",
      version: "test",
      accountEmail: "test@example.com",
    });
    useCodexSetupStore.setState({
      status: "ready",
      version: "test",
      accountLabel: "test",
    });
  });
}

async function elementWidth(page: Page, testId: string) {
  const bounds = await page.getByTestId(testId).boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!.width;
}

test.describe("guided setup layout", () => {
  test("uses traffic-light-safe chrome and a responsive workspace surface", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto("/?debug=new-project", {
      waitUntil: "domcontentloaded",
    });
    await openGuidedSetup(page);

    await page.evaluate(() => {
      document.documentElement.style.setProperty(
        "--traffic-light-width",
        "72px",
      );
    });

    const sidebarBounds = await page
      .getByTestId("template-sidebar")
      .boundingBox();
    const backBounds = await page
      .getByRole("button", { name: "Back to welcome" })
      .boundingBox();
    const titleBounds = await page.getByText("Choose a Template").boundingBox();
    expect(sidebarBounds).not.toBeNull();
    expect(backBounds).not.toBeNull();
    expect(titleBounds).not.toBeNull();
    expect(backBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x + 72);
    expect(titleBounds!.x).toBeGreaterThanOrEqual(
      sidebarBounds!.x + sidebarBounds!.width,
    );

    const hasHorizontalOverflow = await page
      .getByTestId("template-gallery")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(hasHorizontalOverflow).toBe(false);

    await page.screenshot({
      path: "test-results/guided-setup-template-gallery.png",
      fullPage: true,
    });

    await page.setViewportSize({ width: 700, height: 640 });
    await expect(page.getByRole("button", { name: "Sources" })).toBeVisible();
    const compactHasHorizontalOverflow = await page
      .getByTestId("template-gallery")
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(compactHasHorizontalOverflow).toBe(false);

    await page.screenshot({
      path: "test-results/guided-setup-template-gallery-compact.png",
      fullPage: true,
    });
  });

  test("keeps the real welcome sidebar at a fixed width", async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("#loading-screen").waitFor({ state: "detached" });
    await expect(page.getByTestId("welcome-layout")).toBeVisible();
    await enableProjectActions(page);

    const newProjectButton = page.getByRole("button", { name: "New Project" });
    await expect(newProjectButton).toBeEnabled();

    const initialWidth = await elementWidth(page, "welcome-sidebar-panel");
    expect(initialWidth).toBe(240);
    await expect(page.getByTestId("welcome-sidebar-resize-handle")).toHaveCount(
      0,
    );

    await openGuidedSetup(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.getByRole("button", { name: "Back to welcome" }).click();
    await expect(page.getByTestId("welcome-layout")).toBeVisible();

    await expect
      .poll(async () => {
        const width = await elementWidth(page, "welcome-sidebar-panel");
        return Math.abs(width - 240);
      })
      .toBeLessThanOrEqual(2);

    await page.setViewportSize({ width: 1400, height: 820 });
    await expect
      .poll(async () => {
        const width = await elementWidth(page, "welcome-sidebar-panel");
        return Math.abs(width - 240);
      })
      .toBeLessThanOrEqual(2);

    await page.screenshot({
      path: "test-results/guided-setup-returned-welcome.png",
      fullPage: true,
    });
  });
});
