import { expect, test } from "@playwright/test";

test("Duet workspace outline starts collapsed and navigates the visible PDF", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const section = page.locator('[data-sidebar-section="outline"]');
  const header = section.getByRole("button", { name: "Outline", exact: true });
  await expect(header).toBeVisible();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  await mode.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  const pdf = page.getByTestId("pdf-scroll-container");
  await section.getByRole("button", { name: "Results", exact: true }).click();
  await expect
    .poll(() => pdf.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(500);
  await expect(
    mode.getByRole("tab", { name: "PDF", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(700);
  await pdf.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(
    section.locator('[data-outline-line][aria-current="location"]'),
  ).toContainText("Introduction");
  await page.screenshot({ path: test.info().outputPath("vibe-outline.png") });
  await page.getByRole("tab", { name: "Duet", exact: true }).click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
});

test("Duet workspace outline navigates and follows a Markdown preview", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto("/?debug=comment-workspace");
  await expect(
    page.locator('iframe[title="manuscript.md preview"]'),
  ).toBeVisible();
  await page.waitForTimeout(800);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const section = page.locator('[data-sidebar-section="outline"]');
  const toggle = section.getByRole("button", { name: "Outline", exact: true });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const mode = page.getByRole("tablist", { name: "Chat workspace content" });
  await mode.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(
    page.locator("[data-workspace-layout-animating]"),
  ).toHaveAttribute("data-workspace-layout-animating", "false");
  await section
    .getByRole("button", { name: "Discussion", exact: true })
    .click();
  const frame = page.locator('iframe[title="manuscript.md preview"]');
  const scrollTop = () =>
    frame.evaluate(
      (el) =>
        (el as HTMLIFrameElement).contentDocument?.scrollingElement
          ?.scrollTop ?? 0,
    );
  await expect.poll(scrollTop).toBeGreaterThan(100);
  await page.waitForTimeout(300);
  await frame.evaluate((el) => {
    const scroller = (el as HTMLIFrameElement).contentDocument
      ?.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
  });
  await expect(
    section.locator('[data-outline-line][aria-current="location"]'),
  ).toContainText("Introduction");
  await page.screenshot({
    path: test.info().outputPath("vibe-outline-markdown.png"),
  });
});

test("outline changes ownership on view switches with scrolling unlocked", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", {
      name: "Disable synchronized scrolling",
      exact: true,
    })
    .click();
  const section = page.locator('[data-sidebar-section="outline"]');
  const current = section.locator('[aria-current="location"]');
  await section
    .getByRole("button", { name: "Introduction", exact: true })
    .click();
  await expect(current).toHaveText("Introduction");
  const seam = page.locator('[data-workspace-resize-seam="true"]');
  const control = page.getByTestId("sync-navigation-control");
  const seamBox = (await seam.boundingBox())!;
  const controlBox = (await control.boundingBox())!;
  expect(seamBox.height).toBeGreaterThan(500);
  expect(
    Math.abs(
      controlBox.y + controlBox.height / 2 - seamBox.y - seamBox.height / 2,
    ),
  ).toBeLessThan(2);
  const initial = await current.textContent();
  const pdf = page.getByTestId("pdf-scroll-container");
  await pdf.evaluate((el) => {
    el.scrollTop = el.scrollHeight * 0.65;
  });
  await page.waitForTimeout(700);
  await expect(current).toHaveText(initial!);
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  await modes.getByRole("tab", { name: "PDF", exact: true }).click();
  await expect(current).not.toHaveText(initial!);
  await modes.getByRole("tab", { name: "Split", exact: true }).click();
  await expect(current).toHaveText(initial!);
});

test("Markdown preview refreshes outline ownership without another scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await page.goto("/?debug=comment-workspace");
  const frame = page.locator('iframe[title="manuscript.md preview"]');
  await expect(frame).toBeVisible();
  await page.waitForTimeout(800);
  await page
    .getByRole("button", {
      name: "Disable synchronized scrolling",
      exact: true,
    })
    .click();
  const section = page.locator('[data-sidebar-section="outline"]');
  await section
    .getByRole("button", { name: "Introduction", exact: true })
    .click();
  const current = section.locator('[aria-current="location"]');
  await expect(current).toHaveText("Introduction");
  await frame.evaluate((el) => {
    const scroller = (el as HTMLIFrameElement).contentDocument!
      .scrollingElement!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(300);
  await expect(current).toHaveText("Introduction");
  const modes = page.getByRole("tablist", { name: "Workspace view mode" });
  await modes.getByRole("tab", { name: "Preview", exact: true }).click();
  await expect(current).not.toHaveText("Introduction");
  await page.screenshot({
    path: test.info().outputPath("outline-view-switch.png"),
  });
});
