import { expect, test } from "@playwright/test";

test("sidebar width stays fixed while resizing and persists only for its project", async ({
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
  await page.evaluate(() => {
    const widths: number[] = [];
    (window as unknown as { sidebarWidths: number[] }).sidebarWidths = widths;
    new ResizeObserver(([entry]) =>
      widths.push(entry.contentRect.width),
    ).observe(document.querySelector("[data-project-sidebar]")!);
  });
  for (const width of [1400, 1000, 800, 1200, 1800]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(sidebar).toHaveCSS("width", "330px");
  }
  expect(
    await page.evaluate(() =>
      (window as unknown as { sidebarWidths: number[] }).sidebarWidths.every(
        (width) => width === 330,
      ),
    ),
  ).toBe(true);
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
  await handle.dblclick();
  await expect(sidebar).toHaveCSS("width", "240px");
  await page.reload();
  await expect(sidebar).toHaveCSS("width", "240px");
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((el) => el.remove());
  await page.screenshot({ path: "test-results/project-sidebar-width.png" });
});
