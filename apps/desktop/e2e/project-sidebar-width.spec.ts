import { expect, test } from "@playwright/test";

test("sidebar width is capped by the workspace and preserves its project preference", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await page.goto("/?debug=input-transfer");
  const sidebar = page.locator("[data-project-sidebar]");
  const handle = page.getByRole("separator", {
    name: "Resize sidebar",
    exact: true,
  });
  await expect(sidebar).toHaveCSS("width", "240px");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((el) => el.remove());
  await page.waitForTimeout(900);
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, 180);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, 180, { steps: 8 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "330px");
  for (const width of [1400, 1000, 1200, 1800]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toHaveCSS("width", "330px");
  }
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(sidebar).toHaveCSS("width", "200px");
  await expect(handle).toHaveAttribute("aria-valuemin", "200");
  await expect(handle).toHaveAttribute("aria-valuemax", "200");
  await handle.press("ArrowRight");
  await page.setViewportSize({ width: 810, height: 600 });
  await expect(sidebar).toHaveCSS("width", "210px");
  await page.setViewportSize({ width: 840, height: 600 });
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.setViewportSize({ width: 1800, height: 900 });
  await expect(sidebar).toHaveCSS("width", "330px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "330px");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState({ projectRoot: "/tmp/new-sidebar-project" });
  });
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState({ projectRoot: "/tmp/harness" });
  });
  await expect(sidebar).toHaveCSS("width", "330px");
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(sidebar).toHaveCSS("width", "0px");
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await expect(sidebar).toHaveCSS("width", "330px");
  await handle.press("End");
  await expect(sidebar).toHaveCSS("width", "420px");
  await handle.press("Home");
  await expect(sidebar).toHaveCSS("width", "200px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "200px");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((el) => el.remove());
  await handle.dblclick();
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "240px");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((el) => el.remove());
  await page.screenshot({
    path: test.info().outputPath("project-sidebar-width.png"),
  });
});

test("Half and Full share the same pane minimum with a wide saved sidebar", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/?onboarding-demo&project");
  await page
    .locator('[data-sidebar-section="files"]')
    .getByText("demo-paper.tex", { exact: true })
    .click();
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("complementary", { name: "Browser demo controls" })
    .evaluate((element) => {
      element.style.display = "none";
    });
  const drawer = page.locator("[data-chat-drawer-panel]");
  const group = page.locator("[data-workspace-layout-animating]");
  const sidebar = page.locator("[data-project-sidebar]");
  const sidebarHandle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(
    drawer.getByRole("button", { name: "Half", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await sidebarHandle.press("End");
  await expect(sidebar).toHaveCSS("width", "420px");
  await page.setViewportSize({ width: 800, height: 600 });
  await expect(sidebar).toHaveCSS("width", "200px");

  const panelWidths = () =>
    group
      .locator(":scope > [data-panel]:visible")
      .evaluateAll((panels) =>
        panels.map((panel) => Math.round(panel.getBoundingClientRect().width)),
      );
  await expect.poll(panelWidths).toEqual([280, 280]);
  const toolbar = drawer.locator("[data-chat-composer-toolbar]");
  await expect
    .poll(() =>
      toolbar.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const controls = element
          .querySelector("[data-composer-controls]")!
          .getBoundingClientRect();
        return controls.left >= bounds.left && controls.right <= bounds.right;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath("half-800px.png") });

  const views = page.getByRole("tablist", { name: "Workspace view mode" });
  await views.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect.poll(panelWidths).toEqual([568]);
  await expect(sidebar).toHaveCSS("width", "200px");
  await page.screenshot({ path: test.info().outputPath("single-800px.png") });
  await views.getByRole("tab", { name: "Split", exact: true }).click();
  await expect.poll(panelWidths).toEqual([280, 280]);
  await expect(sidebar).toHaveCSS("width", "200px");

  await drawer.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator("[data-workspace-mode-area]")).toHaveAttribute(
    "data-chat-layout",
    "workspace",
  );
  await expect(group).toHaveAttribute(
    "data-workspace-layout-animating",
    "false",
  );
  await expect(
    group.locator("[data-workspace-chat-pane] [data-composer-transfer-phase]"),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  await expect(sidebar).toHaveCSS("width", "200px");
  await expect.poll(panelWidths).toEqual([280, 280]);
  await page.screenshot({ path: test.info().outputPath("full-800px.png") });

  await page.setViewportSize({ width: 1040, height: 700 });
  await expect(sidebar).toHaveCSS("width", "420px");
  const divider = group
    .getByRole("separator", { name: "Resize workspace panes" })
    .filter({ visible: true });
  const dragDivider = async (delta: number) => {
    const bounds = (await divider.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + 100;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + delta, y, { steps: 8 });
    await page.mouse.up();
  };
  await dragDivider(-100);
  await expect.poll(panelWidths).toEqual([280, 300]);
  await dragDivider(100);
  await expect.poll(panelWidths).toEqual([300, 280]);
  expect(pageErrors).toEqual([]);
});
