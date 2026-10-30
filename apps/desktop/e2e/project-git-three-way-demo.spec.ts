import { expect, test, type Page } from "@playwright/test";
import fixtures from "../src/renderer/dev/harnesses/agent-three-way-fixtures.json" with {
  type: "json",
};

async function state(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/renderer/lib/desktop/bridge.ts";
    const { browserHarness } = await import(path);
    return browserHarness().invoke("demo_project_git_state");
  });
}

for (const fixture of fixtures) {
  test(`project Git ${fixture.id} stays separate from private agent review`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?debug=git-three-way&scenario=${fixture.id}`);
    const panel = page.locator("[data-git-conflict-panel]");
    await expect(panel).toContainText("Resolve Git Conflict");
    await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
    const regions = page.locator("[data-three-way-ancestor]");
    const count = fixture.segments.filter(
      (segment) => segment.kind === "conflict",
    ).length;
    await expect(regions).toHaveCount(count);
    await expect(regions.first()).toHaveAttribute(
      "data-three-way-palette",
      "git",
    );
    await expect(page.locator(".cm-threeWayAncestorLine").first()).toHaveCSS(
      "background-color",
      "rgb(241, 245, 249)",
    );
    expect(await state(page)).toMatchObject({
      agentWorkspaceRoot: null,
      agentReviewCount: 0,
      agentQueueCount: 0,
      privateCommands: [],
      conflicted: true,
    });
    await page.waitForTimeout(900);
    await page.screenshot({
      path: `../../output/playwright/project-git-${fixture.id}.png`,
      fullPage: true,
    });
    await regions
      .first()
      .getByRole("button", { name: "Reject", exact: true })
      .click();
    await expect(regions).toHaveCount(count - 1);
    await page.locator('.cm-content[contenteditable="true"]').click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(regions).toHaveCount(count);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(regions).toHaveCount(count - 1);
    await panel
      .getByRole("button", { name: "Accept All", exact: true })
      .click();
    await expect(
      page.locator('[data-editor-file-tab][data-active="true"]'),
    ).toContainText("methods.md");
    let index = 0;
    const expected = fixture.segments
      .map((segment) =>
        segment.kind === "resolved"
          ? segment.content
          : index++ === 0
            ? segment.current
            : segment.agent,
      )
      .join("");
    await expect.poll(async () => (await state(page)).content).toBe(expected);
    expect(await state(page)).toMatchObject({
      conflicted: false,
      staged: true,
      mergeActive: true,
      agentWorkspaceRoot: null,
      agentReviewCount: 0,
      agentQueueCount: 0,
      privateCommands: [],
    });
    expect(errors).toEqual([]);
  });
}

test("project Git demo resolves multiple files independently through review navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?debug=git-three-way&scenario=partial-overlap");
  const navigation = page.getByRole("group", {
    name: "Git conflict files",
    exact: true,
  });
  const panel = page.locator("[data-git-conflict-panel]");
  const activeTab = page.locator('[data-editor-file-tab][data-active="true"]');
  await expect(navigation).toContainText("1/3");
  await expect(panel).not.toContainText("manuscript.md");
  await expect(panel.locator(".lucide-shield-check")).toHaveCount(0);
  for (const label of ["Use Ancestors", "Reject All", "Accept All"]) {
    await expect(
      panel.getByRole("button", { name: label, exact: true }),
    ).toHaveCSS("color", "rgb(255, 255, 255)");
  }
  await page.mouse.move(0, 0);
  await page.screenshot({
    path: test.info().outputPath("git-merge-light.png"),
  });
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(page.locator(".cm-threeWayAncestorLine").first()).toHaveCSS(
    "background-color",
    "rgba(148, 163, 184, 0.12)",
  );
  await page.screenshot({ path: test.info().outputPath("git-merge-dark.png") });
  await page.evaluate(() => localStorage.setItem("theme", "light"));
  await page.reload();
  await expect(navigation).toContainText("1/3");
  await navigation
    .getByRole("button", { name: "Next conflicted file" })
    .click();
  await expect(navigation).toContainText("2/3");
  await expect(activeTab).toContainText("methods.md");
  await panel
    .getByRole("button", { name: "Use Ancestors", exact: true })
    .click();
  await expect(navigation).toContainText("1/2");
  const methods = fixtures[0].segments
    .map((segment) =>
      segment.kind === "resolved" ? segment.content : segment.ancestor,
    )
    .join("");
  await expect
    .poll(async () => (await state(page)).pendingFiles)
    .toEqual(["manuscript.md", "appendix.md"]);
  expect((await state(page)).files).toContainEqual({
    path: "methods.md",
    content: methods,
    conflicted: false,
    staged: true,
  });
  await expect(activeTab).toContainText("manuscript.md");
  await panel.getByRole("button", { name: "Reject All", exact: true }).click();
  await expect(activeTab).toContainText("appendix.md");
  await expect(navigation).toContainText("1/1");
  await panel.getByRole("button", { name: "Accept All", exact: true }).click();
  await expect(navigation).toHaveCount(0);
  await expect(activeTab).toContainText("appendix.md");
  expect(await state(page)).toMatchObject({
    pendingFiles: [],
    mergeActive: true,
    agentReviewCount: 0,
    agentQueueCount: 0,
    privateCommands: [],
  });
  expect(
    (await state(page)).files.every((file: { staged: boolean }) => file.staged),
  ).toBe(true);
});
