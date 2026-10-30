import { expect, test, type Page } from "@playwright/test";

async function resolution(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/renderer/lib/desktop/bridge.ts";
    const { browserHarness } = await import(path);
    return browserHarness().invoke("demo_git_three_way_resolution");
  });
}

test("external Git resolves inline regions with native undo and preserves manual edits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.goto("/?debug=editor-diff&gitConflict=three-way");
  const editor = page.locator(".cm-editor");
  const starting = editor.locator(".cm-threeWayAncestor").getByRole("button", {
    name: "Use Ancestor",
    exact: true,
  });
  await expect(starting).toHaveCount(2);
  await expect(
    page.locator(".cm-changeGutter .cm-threeWayAncestorGutter"),
  ).toHaveCount(2);
  const stack = page
    .locator(
      '.editor-minimap-stroke[data-review-versions="ancestor current proposed"]',
    )
    .first();
  await expect(stack).toHaveCSS("height", "11px");
  await expect(stack).toHaveCSS(
    "background-image",
    /rgb\(148, 163, 184\).*rgb\(59, 130, 246\).*rgb\(168, 85, 247\)/,
  );
  await expect(
    editor.locator("[data-three-way-ancestor]").first(),
  ).toContainText("Samples: 10");
  await expect(editor).toContainText("Samples: 20");
  await expect(editor).toContainText("Samples: 15");
  await starting.first().click();
  await expect(starting).toHaveCount(1);
  expect(await resolution(page)).toBeNull();
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(starting).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(starting).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n% Manual resolution retained\n");
  await page.waitForTimeout(2200);
  expect(await resolution(page)).toBeNull();
  await page.screenshot({
    path: "../../output/playwright/git-three-way-demo.png",
    fullPage: true,
  });
  await editor
    .locator(".cm-threeWayAncestor")
    .getByRole("button", { name: "Accept", exact: true })
    .last()
    .click();
  // A manually inserted ordinary hunk still needs the existing final acceptance.
  if (!(await resolution(page))) {
    await page
      .locator("[data-git-conflict-panel]")
      .getByRole("button", { name: "Accept All", exact: true })
      .click();
  }
  await expect
    .poll(async () => (await resolution(page))?.content)
    .toContain("Samples: 10");
  const result = await resolution(page);
  expect(result.expectedVersion).toBe("git-three-way-v1");
  expect(result.content).toContain("Method: automated");
  expect(result.content).toContain("Manual resolution retained");
  expect(result.content).toContain("Independent context stays intact.");
  await expect(page.locator("[data-git-conflict-panel]")).toHaveCount(0);
});

test("external Git bulk current choice uses the existing toolbar", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitConflict=three-way");
  const panel = page.locator("[data-git-conflict-panel]");
  await expect(
    page.locator(".cm-editor [data-three-way-ancestor]").first(),
  ).toBeVisible();
  expect(await resolution(page)).toBeNull();
  await panel.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect
    .poll(async () => (await resolution(page))?.content)
    .toContain("Samples: 20");
  expect((await resolution(page)).content).toContain(
    "Independent context stays intact.",
  );
});
