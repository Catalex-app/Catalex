import { expect, test, type Page } from "@playwright/test";
import fixtures from "../src/renderer/dev/harnesses/agent-three-way-fixtures.json" with {
  type: "json",
};

async function state(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/renderer/lib/desktop/bridge.ts";
    const { browserHarness } = await import(path);
    return browserHarness().invoke("demo_three_way_state");
  });
}

async function open(page: Page, scenario = "simple") {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/?debug=agent-three-way&scenario=${scenario}`);
  await expect(page.getByTestId("agent-three-way-demo")).toBeVisible();
  await expect(
    page.locator(".cm-editor [data-three-way-ancestor]").first(),
  ).toBeVisible();
  // Workspace modes animate into their saved layout before review interaction.
  await page.waitForTimeout(900);
}

for (const version of ["starting", "current", "agent"] as const) {
  test(`three-way review selects ${version} versions without changing unrelated project edits`, async ({
    page,
  }) => {
    await open(page);
    const editor = page.locator(".cm-editor");
    await expect(
      editor.locator("[data-three-way-ancestor]").first(),
    ).toContainText("10 samples");
    await expect(editor).toContainText("20 samples");
    await expect(editor).toContainText("15 samples");
    await page
      .locator("[data-proposed-changes-panel]")
      .getByRole("button", {
        name:
          version === "starting"
            ? "Use Ancestors"
            : version === "current"
              ? "Reject All"
              : "Accept All",
        exact: true,
      })
      .click();
    await expect
      .poll(async () => (await state(page)).pending)
      .toEqual(["checklist.md"]);
    const count = version === "starting" ? 10 : version === "current" ? 20 : 15;
    await expect
      .poll(
        async () =>
          (await state(page)).source[
            "/browser-demo/Riverside Study/manuscript.md"
          ],
      )
      .toContain(`We evaluated ${count} samples`);
    const after = await state(page);
    expect(
      after.source["/browser-demo/Riverside Study/manuscript.md"],
    ).toContain("The expanded study");
    expect(
      after.source["/browser-demo/Riverside Study/checklist.md"],
    ).not.toContain("Archive the evaluation");
    expect(after.pending).toEqual(["checklist.md"]);
    expect(after.discarded).toBe(false);
    expect(after.queue).toHaveLength(1);
    await page.screenshot({
      path: test.info().outputPath(`${version}-partial-application.png`),
    });
  });
}

test("three-way controls retain independent selections and support undo/redo", async ({
  page,
}) => {
  await open(page);
  const editor = page.locator(".cm-editor");
  const starting = editor.locator(".cm-threeWayAncestor").getByRole("button", {
    name: "Use Ancestor",
    exact: true,
  });
  await expect(starting).toHaveCount(2);
  await page.screenshot({
    path: "../../output/playwright/agent-three-way-demo.png",
    fullPage: true,
  });
  const before = (await state(page)).source;
  await editor
    .locator(".cm-threeWayAncestor")
    .getByRole("button", { name: "Reject", exact: true })
    .first()
    .click();
  await expect(starting).toHaveCount(1);
  expect((await state(page)).source).toEqual(before);
  await page
    .getByRole("button", { name: "checklist.md", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("group", { name: "Review files", exact: true }),
  ).toContainText("2/2");
  await page
    .getByRole("button", { name: /^manuscript\.md(?:$| )/ })
    .first()
    .click();
  await expect(starting).toHaveCount(1);
  await expect(page.locator(".cm-content[contenteditable=true]")).toContainText(
    "We evaluated 20 samples using manual inspection.",
  );
  await page.locator(".cm-content[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(starting).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(starting).toHaveCount(1);
  await editor
    .locator(".cm-threeWayAncestor")
    .getByRole("button", { name: "Accept", exact: true })
    .last()
    .click();
  // Resolving the final region applies this file asynchronously.
  await expect
    .poll(async () => (await state(page)).pending)
    .toEqual(["checklist.md"]);
  const text = (await state(page)).source[
    "/browser-demo/Riverside Study/manuscript.md"
  ];
  expect(text).toContain("We evaluated 20 samples using manual inspection.");
  expect(text).toContain(
    "The automated protocol should be independently validated.",
  );
  expect(text).toContain("The expanded study");
});

test("inline three-way acceptance stays applied when the remaining draft is refined", async ({
  page,
}) => {
  await open(page);
  await page
    .locator("[data-three-way-ancestor]")
    .first()
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(page.locator("[data-three-way-ancestor]")).toHaveCount(1);
  const input = page.getByRole("textbox", {
    name: "Ask me anything",
    exact: true,
  });
  await input.fill("Refine the remaining interpretation only");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(async () => (await state(page)).queue[0]?.phase)
    .toBe("revising");
  await expect
    .poll(async () => (await state(page)).queue[0]?.phase)
    .toBe("review");
  const source = (await state(page)).source[
    "/browser-demo/Riverside Study/manuscript.md"
  ];
  expect(source).toContain("We evaluated 15 samples");
  expect(source).toContain(
    "The expanded cohort supports a larger follow-up study.",
  );
  expect(source).not.toContain(
    "The automated protocol should be independently validated.",
  );
  const chunks = await page.locator(".cm-deletedChunk").allInnerTexts();
  expect(chunks.every((text) => !text.includes("samples"))).toBe(true);
  await expect(page.locator(".cm-editor")).toContainText("Refinement 1");
  await page.screenshot({
    path: test.info().outputPath("three-way-inline-after-refinement.png"),
  });
});

test("applying a clean file keeps conflicts open and permits agent refinement", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("button", { name: "checklist.md", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("group", { name: "Review files", exact: true }),
  ).toContainText("2/2");
  await page
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: /Accept All/ })
    .click();
  await expect
    .poll(async () => (await state(page)).pending)
    .toEqual(["manuscript.md"]);
  const accepted = (await state(page)).source;
  expect(accepted["/browser-demo/Riverside Study/checklist.md"]).toContain(
    "Archive the evaluation",
  );
  expect(accepted["/browser-demo/Riverside Study/manuscript.md"]).toContain(
    "20 samples",
  );
  const input = page.getByRole("textbox", {
    name: "Ask me anything",
    exact: true,
  });
  await input.fill(
    "Refine the pending manuscript only; preserve the checklist that I already applied.",
  );
  await expect(input).toHaveValue(
    "Refine the pending manuscript only; preserve the checklist that I already applied.",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await state(page)).candidate[
          "/browser-demo/private-worktree/manuscript.md"
        ],
    )
    .toContain("Refinement 1");
  await expect
    .poll(async () => (await state(page)).queue[0]?.phase)
    .toBe("review");
  expect((await state(page)).source).toEqual(accepted);
  expect((await state(page)).pending).toEqual(["manuscript.md"]);
  await page
    .getByRole("button", { name: /^manuscript\.md(?:$| )/ })
    .first()
    .click();
  await expect(
    page.locator(".cm-editor [data-three-way-ancestor]").first(),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("refined-conflict-retained.png"),
  });
});

test("manual edits during inline conflict review survive Accept All", async ({
  page,
}) => {
  await open(page);
  const editor = page.locator(".cm-content[contenteditable=true]");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(
    "\nManual review: the final sample count is independently verified.\n",
  );
  await expect(editor).toContainText("Manual review: the final sample count");
  expect(
    (await state(page)).source["/browser-demo/Riverside Study/manuscript.md"],
  ).not.toContain("Manual review:");
  await page
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: "Accept All", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).pending)
    .toEqual(["checklist.md"]);
  const source = (await state(page)).source[
    "/browser-demo/Riverside Study/manuscript.md"
  ];
  expect(source).toContain(
    "Manual review: the final sample count is independently verified.",
  );
  expect(source).toContain("15 samples");
  expect(source).toContain("The expanded study");
});

test("manual edits within the proposed conflict survive Accept All", async ({
  page,
}) => {
  await open(page);
  const proposedLine = page
    .locator(".cm-content[contenteditable=true] .cm-line")
    .filter({ hasText: "We evaluated 15 samples" });
  await proposedLine.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText(
    "We evaluated 17 samples using independently checked automation.",
  );
  await expect(proposedLine).toHaveCount(0);
  await expect(page.locator(".cm-content[contenteditable=true]")).toContainText(
    "We evaluated 17 samples using independently checked automation.",
  );
  await page
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: "Accept All", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).pending)
    .toEqual(["checklist.md"]);
  const source = (await state(page)).source[
    "/browser-demo/Riverside Study/manuscript.md"
  ];
  expect(source).toContain(
    "We evaluated 17 samples using independently checked automation.",
  );
  expect(source).not.toContain("15 samples");
  expect(source).toContain("The expanded study");
});

for (const fixture of fixtures) {
  const conflicts = fixture.segments.filter(
    (segment) => segment.kind === "conflict",
  );
  for (const version of ["ancestor", "current", "agent"] as const) {
    test(`${fixture.id}: bulk ${version} preserves the entire Git-merged document`, async ({
      page,
    }) => {
      await open(page, fixture.id);
      await expect(
        page.getByRole("combobox", { name: "Merge scenario" }),
      ).toHaveValue(fixture.id);
      await page
        .locator("[data-proposed-changes-panel]")
        .getByRole("button", {
          name:
            version === "ancestor"
              ? "Use Ancestors"
              : version === "current"
                ? "Reject All"
                : "Accept All",
          exact: true,
        })
        .click();
      await expect
        .poll(async () => (await state(page)).pending)
        .toEqual(["checklist.md"]);
      const expected = fixture.segments
        .map((segment) =>
          segment.kind === "resolved" ? segment.content : segment[version],
        )
        .join("");
      expect(
        (await state(page)).source[
          "/browser-demo/Riverside Study/manuscript.md"
        ],
      ).toBe(expected);
    });
  }

  test(`${fixture.id}: mixed regional choices survive undo, redo, and file switching`, async ({
    page,
  }) => {
    await open(page, fixture.id);
    const editor = page.locator(".cm-editor");
    const starting = editor
      .locator(".cm-threeWayAncestor")
      .getByRole("button", {
        name: "Use Ancestor",
        exact: true,
      });
    await expect(starting).toHaveCount(conflicts.length);
    await page.screenshot({
      path: `../../output/playwright/agent-three-way-${fixture.id}.png`,
      fullPage: true,
    });
    const before = (await state(page)).source;
    // The insertion/deletion case starts with an empty ancestor; choose it to
    // exercise a zero-length replacement and its inverse through real UI history.
    const first = fixture.id === "insert-delete" ? "starting" : "current";
    await editor
      .locator(".cm-threeWayAncestor")
      .getByRole("button", {
        name: first === "starting" ? "Use Ancestor" : "Reject",
        exact: true,
      })
      .first()
      .click();
    await expect(starting).toHaveCount(conflicts.length - 1);
    await page
      .getByRole("button", { name: "checklist.md", exact: true })
      .first()
      .click();
    await page
      .getByRole("button", { name: /^manuscript\.md(?:$| )/ })
      .first()
      .click();
    await expect(starting).toHaveCount(conflicts.length - 1);
    await page.locator(".cm-content[contenteditable=true]").click();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(starting).toHaveCount(conflicts.length);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect(starting).toHaveCount(conflicts.length - 1);
    expect((await state(page)).source).toEqual(before);
    const choices =
      fixture.id === "insert-delete"
        ? (["ancestor", "current", "agent"] as const)
        : (["current", "agent"] as const);
    for (const choice of choices.slice(1)) {
      await editor
        .locator(".cm-threeWayAncestor")
        .getByRole("button", {
          name:
            choice === "ancestor"
              ? "Use Ancestor"
              : choice === "current"
                ? "Reject"
                : "Accept",
          exact: true,
        })
        .first()
        .click();
    }
    if ((await state(page)).pending.includes("manuscript.md")) {
      await page
        .locator("[data-proposed-changes-panel]")
        .getByRole("button", { name: "Accept All", exact: true })
        .click();
    }
    await expect
      .poll(async () => (await state(page)).pending)
      .toEqual(["checklist.md"]);
    let index = 0;
    const expected = fixture.segments
      .map((segment) =>
        segment.kind === "resolved"
          ? segment.content
          : segment[choices[index++]],
      )
      .join("");
    const after = await state(page);
    expect(after.source["/browser-demo/Riverside Study/manuscript.md"]).toBe(
      expected,
    );
    expect(after.source["/browser-demo/Riverside Study/checklist.md"]).toBe(
      before["/browser-demo/Riverside Study/checklist.md"],
    );
    expect(after.queue).toHaveLength(1);
  });
}

test("gutter and minimap show only present three-way versions and follow undo", async ({
  page,
}) => {
  await open(page, "insert-delete");
  const gutter = page.locator(".cm-changeGutter .cm-threeWayAncestorGutter");
  const stacks = page.locator(".editor-minimap-stroke[data-review-versions]");
  await expect(gutter).toHaveCount(2);
  await expect
    .poll(() =>
      stacks.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-review-versions")),
      ),
    )
    .toEqual([
      "current proposed",
      "ancestor proposed",
      "ancestor current",
      "current proposed",
    ]);
  // The gutter bar starts below the control row and tracks the ancestor block.
  const ancestor = await page
    .locator(".cm-threeWayAncestorLine")
    .nth(1)
    .boundingBox();
  const bar = await gutter.first().boundingBox();
  expect(Math.abs(bar!.y + 24 - ancestor!.y)).toBeLessThan(2);
  await expect(gutter.first()).toHaveCSS(
    "background-image",
    /rgb\(148, 163, 184\)/,
  );
  await expect(stacks.nth(1)).toHaveCSS(
    "background-image",
    /rgb\(148, 163, 184\).*rgb\(34, 197, 94\)/,
  );
  await expect(stacks.nth(1)).not.toHaveCSS(
    "background-image",
    /rgb\(239, 68, 68\)/,
  );
  await page.screenshot({
    path: "../../output/playwright/agent-three-way-indicators-light.png",
    fullPage: true,
  });
  await page
    .locator(".cm-editor .cm-threeWayAncestor")
    .getByRole("button", { name: "Reject", exact: true })
    .nth(1)
    .click();
  await expect(gutter).toHaveCount(1);
  await expect(
    page.locator(
      '.editor-minimap-stroke[data-review-versions="ancestor proposed"]',
    ),
  ).toHaveCount(0);
  await page.locator(".cm-content[contenteditable=true]").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(gutter).toHaveCount(2);
  await expect(
    page.locator(
      '.editor-minimap-stroke[data-review-versions="ancestor proposed"]',
    ),
  ).toHaveCount(1);
  await page.evaluate(() => {
    localStorage.setItem("theme", "dark");
  });
  await page.reload();
  await expect(page.locator(".cm-threeWayAncestorLine").first()).toHaveCSS(
    "background-color",
    "rgba(148, 163, 184, 0.12)",
  );
  await expect(gutter).toHaveCount(2);
  await page.waitForTimeout(900);
  await page.screenshot({
    path: "../../output/playwright/agent-three-way-indicators-dark.png",
    fullPage: true,
  });
});

test("disconnected comment toast opens the existing manager with the sidebar section collapsed", async ({
  page,
}) => {
  await open(page, "interleaved");
  await expect(page.locator("[data-comment-clear-row]")).toBeHidden();
  await page
    .getByRole("button", { name: "Disconnected comments", exact: true })
    .click();
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Some comments are disconnected." });
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Manage", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Manage comments",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("old-manuscript.md", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("comment-notification-manager.png"),
  });
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator(".cm-editor [data-three-way-ancestor]").first(),
  ).toBeVisible();
});
