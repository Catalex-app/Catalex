import { expect, test, type Page } from "@playwright/test";

async function ready(
  page: Page,
  mode: "drawer" | "workspace",
  singleBlock = false,
) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(
    `/?debug=agent-file-review&textReview${singleBlock ? "&singleBlock" : ""}`,
  );
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.getByRole("tab", { name: "Duet", exact: true }).click();
  if (mode === "workspace") {
    await page
      .getByRole("button", { name: "Toggle drawer", exact: true })
      .locator("..")
      .hover();
    await page.getByRole("button", { name: "Full", exact: true }).click();
  }
  await page.waitForTimeout(800);
  for (const file of ["new-figure.png", "results.png"]) {
    await page.getByText(file, { exact: true }).first().click();
    await page
      .locator("[data-agent-file-review]")
      .getByRole("button", { name: "Accept", exact: true })
      .click();
  }
  await page.getByText("manuscript.md", { exact: true }).first().click();
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.waitForTimeout(800);
}
const marker = "- Store raw predictions before computing aggregate metrics.";
async function position(page: Page) {
  return page.locator(".cm-scroller").evaluate((el, text) => {
    const line = [...el.querySelectorAll(".cm-line")].find(
      (line) => line.textContent === text,
    );
    return line ? line.getBoundingClientRect().top : null;
  }, marker);
}
for (const mode of ["drawer", "workspace"] as const) {
  for (const action of ["Accept All", "Reject All"]) {
    test(`${mode} ${action} preserves reading position across source restoration`, async ({
      page,
    }) => {
      await ready(page, mode);
      await page.locator(".cm-scroller").evaluate((el) => {
        el.scrollTop = 520;
      });
      await page.waitForTimeout(300);
      if (action === "Accept All") {
        await page
          .locator(".cm-line")
          .filter({ hasText: marker })
          .click({ position: { x: 5, y: 5 } });
      }
      const before = await position(page);
      expect(before).not.toBeNull();
      await page.getByRole("button", { name: action, exact: false }).click();
      await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(
        0,
      );
      await expect
        .poll(async () => {
          const after = await position(page);
          return after == null ? 9999 : Math.abs(after - before!);
        })
        .toBeLessThan(30);
      await page.waitForTimeout(800);
      expect(Math.abs((await position(page))! - before!)).toBeLessThan(30);
      await page.screenshot({ path: test.info().outputPath("settled.png") });
      const scroller = page.locator(".cm-scroller");
      const restoredTop = await scroller.evaluate((el) => el.scrollTop);
      await scroller.hover();
      await page.mouse.wheel(0, 250);
      await expect
        .poll(() => scroller.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(restoredTop + 100);
      const userTop = await scroller.evaluate((el) => el.scrollTop);
      await page.setViewportSize({ width: 1440, height: 850 });
      await page.waitForTimeout(300);
      expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(
        userTop - 30,
      );
    });
  }
}

for (const mode of ["drawer", "workspace"] as const) {
  for (const action of ["Accept", "Reject"]) {
    test(`${mode} individual ${action} anchors the final block and cursor`, async ({
      page,
    }) => {
      await ready(page, mode, true);
      const button = page.locator(
        `.cm-chunkButtons button[name="${action.toLowerCase()}"]`,
      );
      await button.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await button.click();
      await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(
        0,
      );
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const path = "/src/renderer/stores/document-store.ts";
            const { useDocumentStore } = await import(path);
            const state = useDocumentStore.getState();
            const content =
              state.files.find(
                (file: { id: string }) => file.id === state.activeFileId,
              )?.content ?? "";
            return content
              .slice(state.cursorPosition)
              .startsWith("We evaluate");
          }),
        )
        .toBe(true);
      const cursor = page.locator(".cm-cursor").first();
      await expect(cursor).toBeVisible();
      const bounds = await cursor.boundingBox();
      const viewport = await page.locator(".cm-scroller").boundingBox();
      expect(bounds!.y).toBeGreaterThanOrEqual(viewport!.y - 2);
      expect(bounds!.y).toBeLessThan(viewport!.y + viewport!.height);
    });
  }
}
