import { expect, test } from "@playwright/test";

const root = "/browser-demo/Comment Review";
async function openManager(page: import("@playwright/test").Page) {
  await page.goto("/?debug=comment-workspace&disconnected=1");
  const sidebar = page.locator('[data-sidebar-section="comment-visibility"]');
  await sidebar.locator("button").first().click();
  await sidebar.getByRole("button", { name: "Manage", exact: true }).click();
  return page.getByRole("dialog");
}

test("file rows start collapsed and expose read-only comments separately from selection", async ({
  page,
}) => {
  const dialog = await openManager(page);
  await expect(dialog.locator("[data-comment-link-group]")).toHaveCount(4);
  await expect(
    dialog.getByRole("button", { name: /Mark selected|Delete selected/ }),
  ).toHaveCount(0);
  const group = dialog.locator('[data-comment-link-group="old-manuscript.md"]');
  await expect(group.getByText("Disconnected", { exact: true })).toBeVisible();
  const expand = group.getByRole("button", {
    name: "Expand disconnected comments in old-manuscript.md",
  });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(group.getByText("Please clarify the baseline.")).toBeHidden();
  await expand.click();
  await expect(group.getByText("Please clarify the baseline.")).toBeVisible();
  await expect(group.getByRole("checkbox")).toHaveCount(1);
  await expect(group.getByRole("checkbox")).not.toBeChecked();
  await group.getByRole("checkbox").check();
  await expect(group.getByRole("button")).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(
    dialog.getByRole("button", {
      name: "Reconnect comments to file",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "test-results/unified-comment-manager.png",
    animations: "disabled",
  });
});

test("author-specific clear applies to mixed connected and disconnected selections", async ({
  page,
}) => {
  const dialog = await openManager(page);
  await dialog
    .getByLabel("Select file review-notes.md", { exact: true })
    .check();
  await dialog
    .getByLabel("Select disconnected file old-manuscript.md", { exact: true })
    .check();
  await expect(
    dialog.getByRole("button", {
      name: "Reconnect comments to file",
      exact: true,
    }),
  ).toBeDisabled();
  const author = dialog.getByRole("tablist", { name: "Comments to clear" });
  await author.getByRole("tab", { name: /^Agent \(\d+\)$/ }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText(
    "agent comments cleared",
  );
  const state = await page.evaluate(
    (root) => ({
      connected: JSON.parse(
        localStorage.getItem(`catalex-harness-comments:${root}`)!,
      ),
      disconnected: JSON.parse(
        localStorage.getItem(`catalex-harness-disconnected:${root}`)!,
      ),
    }),
    root,
  );
  expect(state.connected["review-notes.md"].length).toBeGreaterThan(0);
  expect(
    state.connected["review-notes.md"].every(
      (comment: { origin?: unknown }) => !comment.origin,
    ),
  ).toBe(true);
  expect(state.disconnected["old-manuscript.md"].length).toBe(4);
  expect(
    state.disconnected["old-manuscript.md"].every(
      (comment: { origin?: unknown }) => !comment.origin,
    ),
  ).toBe(true);
  expect(state.connected["sample.tex"].length).toBe(2);
  await dialog
    .getByLabel("Select disconnected file old-manuscript.md", { exact: true })
    .check();
  await expect(
    dialog.getByRole("button", { name: "Continue", exact: true }),
  ).toBeDisabled();
  await author.getByRole("tab", { name: /^Human \(\d+\)$/ }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.locator('[data-comment-link-group="old-manuscript.md"]'),
  ).toHaveCount(0);
  await expect(
    dialog.locator('[data-comment-link-group="review-notes.md"]'),
  ).toBeVisible();
});

test("filter changes reset selection and select-all is limited to visible file groups", async ({
  page,
}) => {
  const dialog = await openManager(page);
  const filters = dialog.getByRole("tablist", {
    name: "File connection status",
  });
  await filters.getByRole("tab", { name: /^Connected \(\d+\)$/ }).click();
  await dialog.getByLabel("Select all files", { exact: true }).check();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(4);
  await filters.getByRole("tab", { name: /^Disconnected \(\d+\)$/ }).click();
  await expect(dialog.getByRole("checkbox", { checked: true })).toHaveCount(0);
  await dialog.getByLabel("Select all files", { exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    dialog.getByText("No disconnected comments.", { exact: true }),
  ).toBeVisible();
  await filters.getByRole("tab", { name: /^All \(\d+\)$/ }).click();
  await expect(dialog.locator("[data-comment-link-group]")).toHaveCount(3);
});

test("nested filter and expansion changes morph dialog height and respect reduced motion", async ({
  page,
}) => {
  const dialog = await openManager(page);
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.waitForTimeout(250);
  const sampleChange = (button: string) =>
    dialog.evaluate(async (element, button) => {
      const before = element.getBoundingClientRect().height;
      const trigger = element.querySelector(button) as HTMLButtonElement;
      trigger.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
      trigger.click();
      await new Promise(requestAnimationFrame);
      const animations = element
        .getAnimations()
        .filter((animation) =>
          animation.effect?.getKeyframes().some((frame) => frame.height),
        );
      return {
        before,
        frames: animations.map((animation) => animation.effect!.getKeyframes()),
      };
    }, button);
  expect(
    (await sampleChange('[role="tab"][data-state="inactive"]:last-child'))
      .frames.length,
  ).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  expect(
    (await sampleChange('button[aria-expanded="false"]')).frames.length,
  ).toBeGreaterThan(0);
  await page.waitForTimeout(250);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    (await sampleChange('button[aria-expanded="true"]')).frames,
  ).toHaveLength(0);
});
