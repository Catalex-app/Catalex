import { expect, test } from "@playwright/test";

for (const kind of ["file", "folder"] as const) {
  test(`${kind} Trash requires confirmation and resets after dismissal`, async ({
    page,
  }) => {
    await page.goto("/?debug=sidebar-animation&trash-confirmation");
    await expect(
      page.locator('[data-sidebar-file-id="main.tex"]'),
    ).toBeVisible();
    const target =
      kind === "file"
        ? page.locator('[data-sidebar-file-id="main.tex"]')
        : page.getByRole("button", { name: "chapters", exact: true });
    const requests = () =>
      page.evaluate(() => window.__sidebarTrashRequests ?? []);
    await target.click({ button: "right" });
    await page.screenshot({
      animations: "disabled",
      path: `test-results/trash-initial-${kind}.png`,
    });
    await page
      .getByRole("menuitem", { name: "Move to Trash", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", {
        name: "Confirm",
        exact: true,
      }),
    ).toBeVisible();
    expect(await requests()).toEqual([]);
    await page.keyboard.press("Escape");
    await target.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Move to Trash", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: "Confirm",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("menuitem", { name: "Move to Trash", exact: true })
      .click();
    await page.screenshot({
      animations: "disabled",
      path: `test-results/trash-confirmation-${kind}.png`,
    });
    await page.getByRole("menuitem", { name: "Confirm", exact: true }).click();
    await expect
      .poll(requests)
      .toEqual([kind === "file" ? "file:main.tex" : "folder:chapters"]);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
}

test("Trash confirmation swaps horizontally without resizing the menu", async ({
  page,
}) => {
  await page.goto("/?debug=sidebar-animation&trash-confirmation");
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .click({ button: "right" });
  const item = page.getByRole("menuitem", {
    name: "Move to Trash",
    exact: true,
  });
  const before = await item.evaluate(
    (element) => (element as HTMLElement).offsetWidth,
  );
  const motion = await item.evaluate(async (element) => {
    const entering = element.querySelector<HTMLElement>(
      ".trash-menu-confirmation",
    )!;
    const leaving = element.querySelector<HTMLElement>(".trash-menu-label")!;
    void getComputedStyle(entering).transform;
    (element as HTMLElement).click();
    await new Promise(requestAnimationFrame);
    const animations = element.getAnimations({ subtree: true });
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 60;
    }
    return {
      count: animations.length,
      enteringX: new DOMMatrix(getComputedStyle(entering).transform).m41,
      leavingX: new DOMMatrix(getComputedStyle(leaving).transform).m41,
    };
  });
  expect(motion.count).toBeGreaterThan(0);
  expect(motion.enteringX).toBeLessThan(0);
  expect(motion.leavingX).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/trash-confirmation-mid-swap.png",
  });
  const confirmed = page.getByRole("menuitem", {
    name: "Confirm",
    exact: true,
  });
  await confirmed.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true }))
      animation.finish();
  });
  await expect(confirmed.locator(".trash-menu-confirmation")).toHaveCSS(
    "background-color",
    "rgb(220, 38, 38)",
  );
  await expect(confirmed.locator(".trash-menu-confirmation")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  expect(
    await confirmed.evaluate((element) => (element as HTMLElement).offsetWidth),
  ).toBe(before);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    animations: "disabled",
    path: "test-results/trash-confirmation-dark.png",
  });
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Move to Trash", exact: true })
    .click();
  await expect(confirmed.locator(".trash-menu-confirmation")).toHaveCSS(
    "transition-duration",
    "0s",
  );
});
