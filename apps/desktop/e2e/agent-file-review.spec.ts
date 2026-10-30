import { expect, test } from "@playwright/test";

for (const anotherFile of [false, true]) {
  test(`inline acceptance and rejection remain settled after feedback refinement${anotherFile ? " following another file decision" : ""}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/?debug=agent-file-review&textReview");
    const chunks = page.locator(".cm-deletedChunk");
    const panel = page.locator("[data-proposed-changes-panel]");
    await expect(panel.locator("span.font-mono")).toHaveText(/\/6$/);
    await page.waitForTimeout(900);
    await chunks.first().locator('button[name="accept"]').click();
    await expect(panel.locator("span.font-mono")).toHaveText(/\/5$/);
    await chunks.first().locator('button[name="reject"]').click();
    await expect(panel.locator("span.font-mono")).toHaveText(/\/4$/);
    if (anotherFile) {
      await page.getByText("new-figure.png", { exact: true }).first().click();
      await page
        .locator("[data-agent-file-review]")
        .getByRole("button", { name: "Accept", exact: true })
        .click();
      await expect(
        page.getByRole("group", { name: "Review files", exact: true }),
      ).toContainText("/2");
      await page.getByText("manuscript.md", { exact: true }).first().click();
    }
    const input = page
      .locator('[data-chat-drawer-panel="true"] textarea:visible')
      .last();
    await input.fill("Refine the remaining changes and preserve my decisions");
    await input.press("Enter");
    const state = () =>
      page.evaluate(async () => {
        const path = "/src/renderer/lib/desktop/bridge.ts";
        return (await import(path)).browserHarness().invoke("demo_state");
      });
    await expect.poll(async () => (await state()).phase).toBe("revising");
    await expect.poll(async () => (await state()).phase).toBe("review");
    const source = await page.evaluate(async () => {
      const path = "/src/renderer/lib/desktop/bridge.ts";
      return (await import(path))
        .browserHarness()
        .invoke("plugin:fs|read_text_file", {
          path: "/browser-demo/Figure Review/manuscript.md",
        });
    });
    expect(source).toContain("Our revised experiment compares three methods");
    expect(source).toContain("We evaluate a single random seed");
    expect(source).not.toContain("Refinement");
    const remaining = (await chunks.allInnerTexts()).join("\n");
    expect(remaining).not.toContain("Our initial experiment");
    expect(remaining).not.toContain("We evaluate a single random seed");
    await expect(page.locator(".cm-editor")).toContainText("Refinement 1");
    await page.screenshot({
      path: test.info().outputPath("inline-decisions-after-refinement.png"),
    });
  });
}

test("review new and replaced figures alongside text; preserve unsent feedback", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?debug=agent-file-review");
  const review = page.locator("[data-agent-file-review]");
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("region", { name: "Proposed file" }),
  ).toBeVisible();
  await expect(review.locator("img")).toHaveCount(1);
  await expect
    .poll(() =>
      review
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  const readSource = () =>
    page.evaluate(async () => {
      const modulePath = "/src/renderer/lib/desktop/bridge.ts";
      const { browserHarness } = await import(modulePath);
      const bridge = browserHarness();
      return {
        original: Array.from(
          await bridge.invoke("plugin:fs|read_file", {
            path: "/browser-demo/Figure Review/results.png",
          }),
        ),
        added: await bridge.invoke("plugin:fs|exists", {
          path: "/browser-demo/Figure Review/new-figure.png",
        }),
        text: await bridge.invoke("plugin:fs|read_text_file", {
          path: "/browser-demo/Figure Review/manuscript.md",
        }),
      };
    });
  const before = await readSource();
  expect(before.added).toBe(false);
  await page.screenshot({ path: test.info().outputPath("new-figure.png") });
  const input = page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .last();
  await expect(input).toBeVisible();
  await input.fill("Keep this message while I review the figures");
  await page.getByText("results.png", { exact: true }).first().click();
  await expect(
    review.getByRole("region", { name: "Current file" }),
  ).toBeVisible();
  await expect(review.locator("img")).toHaveCount(2);
  await expect(review).toHaveAttribute(
    "data-workspace-layout-animating",
    "false",
  );
  await expect(page.locator('[data-chat-drawer-overlay="true"]')).toHaveCount(
    0,
  );
  await expect(review.locator(":scope > [data-panel-id]")).toHaveCount(4);
  await expect(
    review
      .getByRole("region", { name: "Current file" })
      .getByRole("button", { name: "Reject", exact: true }),
  ).toBeVisible();
  await expect(
    review
      .getByRole("region", { name: "Proposed file" })
      .getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      review
        .locator("img")
        .evaluateAll((images) =>
          images.every((img) => (img as HTMLImageElement).naturalWidth > 0),
        ),
    )
    .toBe(true);
  const divider = review.getByRole("separator", {
    name: "Resize conflict panes",
  });
  const bounds = (await divider.boundingBox())!;
  const currentPane = review.getByRole("region", { name: "Current file" });
  const originalWidth = (await currentPane.boundingBox())!.width;
  const dragY = bounds.y + bounds.height / 5;
  await page.mouse.move(bounds.x + bounds.width / 2, dragY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 80, dragY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await currentPane.boundingBox())!.width)
    .toBeGreaterThan(originalWidth + 40);
  await divider.dblclick({ position: { x: 2, y: bounds.height / 5 } });
  await expect(review).toHaveAttribute(
    "data-workspace-layout-animating",
    "false",
  );
  await page.screenshot({ path: test.info().outputPath("replacement.png") });
  await review.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByText("new-figure.png", { exact: true }).first().click();
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByText("manuscript.md", { exact: true }).first().click();
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("text-change.png") });
  expect(await readSource()).toEqual({ ...before, added: true });
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
  const after = await readSource();
  expect(after.original).toEqual(before.original);
  expect(after.added).toBe(true);
  expect(after.text).toContain("revised experiment");
  await expect(input).toHaveValue(
    "Keep this message while I review the figures",
  );
});

test("deleted and unpreviewable files remain reviewable after refresh", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&extras");
  const review = page.locator("[data-agent-file-review]");
  await expect(review).toBeVisible();
  await page.getByText("removed.png", { exact: true }).first().click();
  await expect(
    review.getByRole("region", { name: "To be deleted file" }),
  ).toBeVisible();
  await expect(review.locator("img")).toHaveCount(1);
  await expect(
    review.getByRole("button", { name: "Accept deletion", exact: true }),
  ).toBeVisible();
  await page
    .locator('[data-sidebar-section="files"]')
    .getByRole("button", { name: "Refresh", exact: true })
    .last()
    .click();
  await expect(
    review.getByRole("button", { name: "Keep file", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("deleted-file.png") });
  await review.getByRole("button", { name: "Keep file", exact: true }).click();
  await page.getByText("archive.zip", { exact: true }).first().click();
  await expect(review).toContainText("No preview available");
  await expect(review).toContainText("6 bytes");
  await page.screenshot({ path: test.info().outputPath("binary-file.png") });
  await review.getByRole("button", { name: "Reject", exact: true }).click();
});

test("refine the same draft twice, preserving approvals and manual edits", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?debug=agent-file-review");
  const review = page.locator("[data-agent-file-review]");
  await expect(
    review.getByRole("button", { name: "Accept", exact: true }),
  ).toBeVisible();
  await review.getByRole("button", { name: "Accept", exact: true }).click();
  await page.getByText("manuscript.md", { exact: true }).first().click();
  await expect(page.locator("[data-proposed-changes-panel]")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/renderer/lib/desktop/bridge.ts";
    const { browserHarness } = await import(path);
    await browserHarness().invoke("demo_edit");
  });
  const input = page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .last();
  const state = () =>
    page.evaluate(async () => {
      const path = "/src/renderer/lib/desktop/bridge.ts";
      const { browserHarness } = await import(path);
      return browserHarness().invoke("demo_state");
    });
  for (let round = 1; round <= 2; round++) {
    await input.fill("Please clarify the evaluation and preserve my sentence");
    await input.press("Enter");
    await expect.poll(async () => (await state()).phase).toBe("revising");
    expect((await state()).readonly).toBe(false);
    await page.getByText("manuscript.md", { exact: true }).first().click();
    await expect(page.locator(".cm-content")).toContainText(
      "Our initial experiment compares two methods.",
    );
    await expect(page.locator(".cm-content")).not.toContainText(
      "User-authored sentence to preserve.",
    );
    await expect(page.locator(".cm-content")).not.toContainText("Refinement");
    await expect(page.locator("[data-proposed-changes-panel]")).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect.poll(async () => (await state()).phase).toBe("review");
    const after = await state();
    expect(after.id).toBe("figure-review");
    expect(after.count).toBe(1);
    expect(after.readonly).toBe(false);
    expect(after.decisions["figure-change-0"]).toBeUndefined();
    expect(after.text).toContain("User-authored sentence to preserve.");
    expect(after.text).toContain(`Refinement ${round}`);
    const source = await page.evaluate(async () => {
      const path = "/src/renderer/lib/desktop/bridge.ts";
      const { browserHarness } = await import(path);
      return browserHarness().invoke("plugin:fs|read_text_file", {
        path: "/browser-demo/Figure Review/manuscript.md",
      });
    });
    expect(source).toContain("Our initial experiment compares two methods.");
    expect(source).not.toContain("User-authored sentence");
    expect(source).not.toContain("Refinement");
  }
  await page
    .locator(".cm-line")
    .filter({ hasText: "User-authored sentence" })
    .first()
    .dblclick({ position: { x: 25, y: 8 } });
  await expect(
    page
      .getByText("Agent proposed", { exact: false })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const chip = page
        .locator('[data-proposed-draft-context="true"]')
        .filter({ visible: true })
        .first();
      const shell = chip.locator(
        'xpath=ancestor::*[@data-context-row-shell="true"]',
      );
      return (await shell.boundingBox())?.height ?? 0;
    })
    .toBeGreaterThan(20);
  await page.screenshot({ path: test.info().outputPath("refined-review.png") });
});
