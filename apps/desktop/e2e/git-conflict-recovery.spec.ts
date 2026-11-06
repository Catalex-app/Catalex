import { writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

async function openProject(
  page: Page,
  scenario = "mixed",
  rebase = false,
  syntaxWarning = false,
  ancestor = false,
) {
  await page.addInitScript(() => {
    window.addEventListener(
      "app-visibility-restored",
      () => {
        document.documentElement.dataset.harnessVisibilityReady = "true";
      },
      { once: true },
    );
  });
  await page.goto(
    `/?debug=git-actions&recovery=${scenario}&workspace=1${rebase ? "&rebase=conflict" : ""}${syntaxWarning ? "&syntax=warning" : ""}${ancestor ? "&ancestor=1" : ""}`,
    { waitUntil: "domcontentloaded" },
  );
  // Match the input-transfer harness: interact after startup visibility recovery.
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute(
    "data-harness-visibility-ready",
    "true",
  );
  await expect(
    page.locator('[data-git-conflicted="true"]').first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Artisan", exact: true }).click();
}
async function openFile(page: Page, path: string) {
  await page.getByText(path, { exact: true }).first().click();
  const artisan = page.getByRole("tab", { name: "Artisan", exact: true });
  await artisan.click();
  await expect(artisan).toHaveAttribute("aria-selected", "true");
}
async function openImage(page: Page, scenario = "mixed", rebase = false) {
  await openProject(page, scenario, rebase);
  await openFile(page, "figure.png");
  const view = page.getByRole("region", {
    name: "File conflict versions",
    exact: true,
  });
  await expect(view).toBeVisible();
  await expect
    .poll(() =>
      view.evaluate((el) => {
        const group = el.querySelector(":scope > [data-panel-group-id]")!;
        return (
          group
            .querySelectorAll(":scope > [data-panel-id]")[1]
            .getBoundingClientRect().width / group.getBoundingClientRect().width
        );
      }),
    )
    .toBeCloseTo(0.5, 2);
  return view;
}

test("unresolved files keep their icons with a right-side merge marker and conflict colors", async ({
  page,
}) => {
  await openProject(page);
  await expect(page.getByText(/Resolve conflicts/)).toHaveCount(0);
  const rows = page.locator('[data-git-conflicted="true"]');
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    const icon = row.getByLabel("Unresolved Git conflict");
    const name = row.locator("span.text-violet-700");
    await expect(icon).toHaveClass(/lucide-git-merge/);
    await expect(name).toHaveClass(/text-violet-700/);
    await expect(row.locator("svg").first()).not.toHaveClass(
      /lucide-git-merge/,
    );
    const markerBox = await icon.boundingBox();
    const nameBox = await name.boundingBox();
    expect(markerBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
    expect(await icon.evaluate((el) => getComputedStyle(el).color)).toEqual(
      await name.evaluate((el) => getComputedStyle(el).color),
    );
  }
  await openFile(page, "chapter.tex");
  const selected = page.locator('[data-sidebar-file-id="chapter.tex"]');
  const navigation = page.locator("[data-review-file-navigation]");
  const color = (el: Element) => getComputedStyle(el).color;
  const background = (el: Element) => getComputedStyle(el).backgroundColor;
  await page.mouse.move(600, 10);
  await expect(selected).toHaveClass(/bg-violet-100/);
  expect(await selected.evaluate(background)).not.toBe("rgba(0, 0, 0, 0)");
  expect(
    await selected.locator("span.text-violet-700").evaluate(color),
  ).toEqual(
    await navigation.evaluate((el) => getComputedStyle(el).borderTopColor),
  );
  await page.screenshot({
    path: "test-results/git-conflict-sidebar-colors.png",
    animations: "disabled",
  });
});

test("image tab opens resizable workspace panes with text conflict button styling", async ({
  page,
}) => {
  const view = await openImage(page);
  await expect(
    page.locator('[data-workspace-mode-content="true"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Back to workspace" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Conflicted file" }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const current = view.getByRole("region", {
    name: "Current version",
    exact: true,
  });
  const incoming = view.getByRole("region", {
    name: "Incoming version",
    exact: true,
  });
  expect(
    await view.evaluate((el) => el.closest("[data-drawer-host]")),
  ).toBeNull();
  await expect(view.locator(":scope > [data-panel-group-id]")).toHaveCount(1);
  await expect(
    view.locator(":scope > [data-panel-group-id] > [data-panel-id]"),
  ).toHaveCount(4);
  expect(
    await current.evaluate((el) =>
      Boolean(
        el
          .closest('[data-drawer-host="true"]')
          ?.closest('[data-drawer-shell="true"]'),
      ),
    ),
  ).toBe(true);
  expect(
    await incoming.evaluate((el) => el.closest("[data-drawer-host]")),
  ).toBeNull();
  const left = await current.boundingBox();
  const right = await incoming.boundingBox();
  expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x);
  expect(left!.y).toEqual(right!.y);
  await expect(
    current.locator("header").getByRole("button", { name: "Accept current" }),
  ).toBeVisible();
  await expect(
    incoming.locator("header").getByRole("button", { name: "Accept incoming" }),
  ).toBeVisible();
  const divider = view.getByRole("separator", {
    name: "Resize conflict panes",
  });
  const dividerBox = await divider.boundingBox();
  const dividerX = dividerBox!.x + dividerBox!.width / 2;
  // The middle third is reserved for navigation controls.
  const dividerY = dividerBox!.y + 20;
  await page.mouse.move(dividerX, dividerY);
  await page.mouse.down();
  await page.mouse.move(dividerX + 90, dividerY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await current.boundingBox())!.width)
    .toBeGreaterThan(left!.width + 50);
  const movedDivider = await divider.boundingBox();
  await page.mouse.move(movedDivider!.x + movedDivider!.width / 2, dividerY);
  await page.mouse.down();
  await page.mouse.move(dividerX, dividerY, { steps: 8 });
  await page.mouse.up();
  await page.mouse.move(600, 10);
  const buttonStyle = (el: Element) => {
    const style = getComputedStyle(el);
    return {
      color: style.color,
      background: style.backgroundColor,
      height: style.height,
      radius: style.borderRadius,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      padding: style.padding,
      gap: style.gap,
    };
  };
  const currentStyle = await current
    .getByRole("button", { name: "Accept current" })
    .evaluate(buttonStyle);
  const incomingStyle = await incoming
    .getByRole("button", { name: "Accept incoming" })
    .evaluate(buttonStyle);
  await page.screenshot({
    path: "test-results/git-conflict-image-tab.png",
    animations: "disabled",
  });
  await openFile(page, "chapter.tex");
  await expect(view).not.toBeVisible();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await expect(page.locator(".cm-editor")).toBeVisible();
  expect(currentStyle).toEqual(
    await page
      .getByRole("button", { name: "Keep current (delete file)" })
      .evaluate(buttonStyle),
  );
  expect(incomingStyle).toEqual(
    await page
      .getByRole("button", { name: "Use incoming" })
      .evaluate(buttonStyle),
  );
  await openFile(page, "figure.png");
  await expect(view).toBeVisible();
});

test("image and binary tabs resolve their own files and normal Git controls finish merge", async ({
  page,
}) => {
  const view = await openImage(page, "nontext");
  await view
    .getByRole("button", { name: "Accept incoming", exact: true })
    .click();
  await expect(page.locator('[data-git-conflicted="true"]')).toHaveCount(1);
  const resolvedRow = page.locator('[data-sidebar-file-id="figure.png"]');
  await expect(resolvedRow.locator("svg").first()).toHaveClass(/lucide-image/);
  await expect(resolvedRow.locator("span").first()).not.toHaveClass(
    /text-violet/,
  );
  await openFile(page, "data.bin");
  await expect(view).toBeVisible();
  await expect(view).toContainText("No preview available");
  await view
    .getByRole("button", { name: "Accept current", exact: true })
    .click();
  await expect(page.locator('[data-git-conflicted="true"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Finish merge", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "Finish merge" }),
  ).toBeVisible();
});

for (const scenario of ["delete-current", "delete-incoming"]) {
  for (const keepFile of [true, false]) {
    test(`${scenario}: ${keepFile ? "keep file" : "keep deletion"} in the text editor`, async ({
      page,
    }) => {
      await openProject(page, scenario);
      await openFile(page, "chapter.tex");
      const panel = page.locator('[data-git-conflict-panel="true"]');
      await expect(panel).toBeVisible();
      await expect(
        page.getByRole("region", {
          name: "File conflict versions",
          exact: true,
        }),
      ).toHaveCount(0);
      const currentDeleted = scenario === "delete-current";
      const choice = keepFile
        ? currentDeleted
          ? "incoming"
          : "current"
        : currentDeleted
          ? "current"
          : "incoming";
      const name =
        choice === "current"
          ? currentDeleted
            ? "Keep current (delete file)"
            : "Keep current"
          : currentDeleted
            ? "Use incoming"
            : "Use incoming (delete file)";
      await expect(panel).not.toContainText("chapter.tex");
      await expect(panel).not.toContainText("deleted on");
      await expect(
        panel.getByRole("button", { name: "Keep All Current" }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: "Use All Incoming" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: `test-results/git-text-${scenario}.png`,
        animations: "disabled",
      });
      await panel.getByRole("button", { name }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            (
              window as unknown as {
                __gitSetupCommands: Array<{
                  command: string;
                  args: { choice: string };
                }>;
              }
            ).__gitSetupCommands
              .filter(
                (entry) => entry.command === "git_panel_resolve_conflict_side",
              )
              .map((entry) => entry.args.choice),
          ),
        )
        .toEqual([choice]);
      await expect(panel).not.toBeVisible();
    });
  }
}

test("ordinary text tabs keep the existing inline merge editor", async ({
  page,
}) => {
  await openProject(page, "text");
  await openFile(page, "neurips_2026.tex");
  const panel = page.locator('[data-git-conflict-panel="true"]');
  await expect(panel).toBeVisible();
  await expect(page.locator(".cm-gitConflictMerge")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "File conflict versions", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/git-text-inline.png",
    animations: "disabled",
  });
  await panel.getByRole("button", { name: "Use All Incoming" }).click();
  await expect(panel).not.toBeVisible();
});

test("image resolution errors stay in the file tab and allow retry", async ({
  page,
}) => {
  const view = await openImage(page, "fail");
  await view
    .getByRole("button", { name: "Accept incoming", exact: true })
    .click();
  await expect(view.getByRole("alert")).toContainText(
    "Could not lock the Git index",
  );
  await page.screenshot({
    path: "test-results/git-conflict-retry.png",
    animations: "disabled",
  });
  await view
    .getByRole("button", { name: "Accept incoming", exact: true })
    .click();
  await expect(view).not.toBeVisible();
  await expect(page.locator('[data-git-conflicted="true"]')).toHaveCount(0);
});

test("rebase side labels are explained and continuation uses the normal Git control", async ({
  page,
}) => {
  const view = await openImage(page, "binary", true);
  await expect(
    view.getByRole("region", { name: "Current version", exact: true }),
  ).toContainText("Rebase target");
  await expect(
    view.getByRole("region", { name: "Incoming version", exact: true }),
  ).toContainText("Commit being replayed");
  await view
    .getByRole("button", { name: "Accept incoming", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Continue rebase", exact: true })
    .first()
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            __gitSetupCommands: Array<{ command: string }>;
          }
        ).__gitSetupCommands.some(
          (entry) => entry.command === "git_panel_continue_rebase",
        ),
      ),
    )
    .toBe(true);
});

for (const scenario of ["delete-incoming", "text"]) {
  test(`${scenario}: syntax diagnostics hide during conflict resolution and resume afterward`, async ({
    page,
  }) => {
    await openProject(page, scenario, false, true);
    await openFile(
      page,
      scenario === "text" ? "neurips_2026.tex" : "chapter.tex",
    );
    const conflict = page.locator('[data-git-conflict-panel="true"]');
    const problems = page.locator('[data-problems-panel="true"]');
    const markers = page.locator(
      ".cm-lintRange, .cm-lint-marker, .cm-tooltip-lint",
    );
    await expect(conflict).toBeVisible();
    await expect(problems).not.toBeVisible();
    await expect(markers).toHaveCount(0);
    await page.evaluate(() =>
      (
        window as unknown as { __resolveGitConflictForHarness: () => void }
      ).__resolveGitConflictForHarness(),
    );
    await expect(conflict).not.toBeVisible();
    await page.getByRole("button", { name: /^Show problems:/ }).click();
    await expect(problems).toBeVisible();
    await expect(page.locator(".cm-lint-marker").first()).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { __reopenGitConflictForHarness: () => void }
      ).__reopenGitConflictForHarness(),
    );
    await expect(conflict).toBeVisible();
    await expect(problems).not.toBeVisible();
    await expect(markers).toHaveCount(0);
    await page.screenshot({
      path: `test-results/git-conflict-no-lint-${scenario}.png`,
      animations: "disabled",
    });
  });
}

type ConflictMorphFrame = { time: number; ratio: number; visible: boolean };
async function recordConflictMorph(page: Page, path: string) {
  await page.evaluate(() => {
    const group = document.querySelector(
      "[data-workspace-standard-panels] [data-panel-group-id]",
    )!;
    const editor = group.querySelectorAll(":scope > [data-panel-id]")[1];
    const sample = { frames: [] as ConflictMorphFrame[], done: false };
    (
      window as unknown as { __conflictMorphSample: typeof sample }
    ).__conflictMorphSample = sample;
    const start = performance.now();
    const frame = () => {
      const width = group.getBoundingClientRect().width;
      sample.frames.push({
        time: performance.now() - start,
        ratio: width ? editor.getBoundingClientRect().width / width : 0,
        visible: width > 0,
      });
      if (performance.now() - start < 900) requestAnimationFrame(frame);
      else sample.done = true;
    };
    requestAnimationFrame(frame);
  });
  await page.locator(`[data-sidebar-file-id="${path}"]`).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __conflictMorphSample: { done: boolean } })
            .__conflictMorphSample.done,
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __conflictMorphSample: { frames: ConflictMorphFrame[] };
        }
      ).__conflictMorphSample.frames,
  );
}

test("text and image conflicts morph through the same workspace panel group", async ({
  page,
}, testInfo) => {
  await openProject(page);
  await openFile(page, "chapter.tex");
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "Editor", exact: true })
    .click();
  const group = page
    .locator("[data-workspace-standard-panels] [data-panel-group-id]")
    .first();
  const ratio = () =>
    group.evaluate(
      (el) =>
        el
          .querySelectorAll(":scope > [data-panel-id]")[1]
          .getBoundingClientRect().width / el.getBoundingClientRect().width,
    );
  await expect.poll(ratio).toBeGreaterThan(0.995);
  const groupId = await group.getAttribute("data-panel-group-id");
  const editorSurface = await group
    .locator('[data-drawer-shell="true"]')
    .elementHandle();
  for (const path of ["figure.png", "chapter.tex"]) {
    const frames = await recordConflictMorph(page, path);
    await testInfo.attach(`conflict-morph-${path}`, {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(
      frames.filter((frame) => frame.ratio > 0.56 && frame.ratio < 0.94).length,
    ).toBeGreaterThan(2);
    expect(frames.every((frame) => frame.visible)).toBe(true);
    await expect(group).toHaveAttribute("data-panel-group-id", groupId!);
    expect(
      await editorSurface!.evaluate(
        (el) => el.isConnected && el.checkVisibility(),
      ),
    ).toBe(true);
    await expect.poll(ratio).toBeCloseTo(path === "figure.png" ? 0.5 : 1, 2);
    if (path === "figure.png") {
      await expect(
        group.getByRole("region", { name: "Current version", exact: true }),
      ).toBeVisible();
      await expect(
        group.getByRole("region", { name: "Incoming version", exact: true }),
      ).toBeVisible();
    } else await expect(page.locator(".cm-editor")).toBeVisible();
  }
  // Interrupt a running transition in either direction: the final tab wins.
  for (const path of [
    "figure.png",
    "chapter.tex",
    "figure.png",
    "chapter.tex",
  ]) {
    await page.locator(`[data-sidebar-file-id="${path}"]`).click();
    if (path === "figure.png")
      await expect(
        page.getByRole("region", { name: "Current version", exact: true }),
      ).toBeVisible();
    else await expect(page.locator(".cm-editor")).toBeVisible();
  }
  await expect.poll(ratio).toBeGreaterThan(0.995);
  await expect(
    page.getByRole("region", { name: "Current version", exact: true }),
  ).toHaveCount(0);
  await expect(group).toHaveAttribute("data-panel-group-id", groupId!);
  const video = page.video();
  await page.context().close();
  await video?.saveAs("test-results/git-conflict-morph.webm");
});

test("resizing either right panel keeps the shared editor width across tab switches", async ({
  page,
}) => {
  await openProject(page);
  await openFile(page, "chapter.tex");
  const group = page
    .locator("[data-workspace-standard-panels] [data-panel-group-id]")
    .first();
  const ratio = () =>
    group.evaluate(
      (el) =>
        el
          .querySelectorAll(":scope > [data-panel-id]")[1]
          .getBoundingClientRect().width / el.getBoundingClientRect().width,
    );
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "Split", exact: true })
    .click();
  await expect.poll(ratio).toBeCloseTo(0.5, 2);
  const resize = async (distance: number) => {
    await expect(group).toHaveAttribute(
      "data-workspace-layout-animating",
      "false",
    );
    const handle = group.locator('[data-workspace-resize-seam="true"]');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + distance, box.y + 20, {
      steps: 8,
    });
    await page.mouse.up();
  };
  await resize(100);
  const normalRatio = await ratio();
  expect(normalRatio).toBeGreaterThan(0.55);
  await page.locator('[data-sidebar-file-id="figure.png"]').click();
  await expect(
    page.getByRole("region", { name: "Current version", exact: true }),
  ).toBeVisible();
  await expect.poll(ratio).toBeCloseTo(normalRatio, 2);
  await resize(-100);
  const conflictRatio = await ratio();
  expect(conflictRatio).toBeLessThan(normalRatio - 0.05);
  await page.locator('[data-sidebar-file-id="chapter.tex"]').click();
  await expect(page.locator(".cm-editor")).toBeVisible();
  await expect.poll(ratio).toBeCloseTo(conflictRatio, 2);
  await page.locator('[data-sidebar-file-id="figure.png"]').click();
  await expect(
    page.getByRole("region", { name: "Current version", exact: true }),
  ).toBeVisible();
  await expect.poll(ratio).toBeCloseTo(conflictRatio, 2);
});

test("Incoming contracts while preview expands without resizing the main editor", async ({
  page,
}, testInfo) => {
  await openProject(page);
  await openFile(page, "chapter.tex");
  await page
    .getByRole("tablist", { name: "Workspace view mode" })
    .getByRole("tab", { name: "Split", exact: true })
    .click();
  await openFile(page, "figure.png");
  const incoming = page.getByRole("region", {
    name: "Incoming version",
    exact: true,
  });
  await expect(incoming).toBeVisible();
  // Sample actual panel geometry, retaining the outgoing DOM node across the tab change.
  const sample = await incoming.evaluateHandle((el) => {
    const panel = el.closest("[data-panel-id]")!;
    const group = panel.parentElement!;
    const editor = group.querySelectorAll(":scope > [data-panel-id]")[1];
    const preview = group.querySelector(":scope > [data-panel-id]:last-child")!;
    return {
      panel,
      done: false,
      editor,
      preview,
      frames: [] as {
        editor: number;
        incoming: number;
        preview: number;
        outgoingVisible: boolean;
      }[],
    };
  });
  await expect
    .poll(() =>
      sample.evaluate((sample) => sample.preview.getBoundingClientRect().width),
    )
    .toBeLessThan(1);
  for (const path of ["chapter.tex", "figure.png"]) {
    await sample.evaluate((sample, path) => {
      sample.frames = [];
      sample.done = false;
      const start = performance.now();
      const frame = () => {
        sample.frames.push({
          editor: sample.editor.getBoundingClientRect().width,
          incoming: sample.panel.getBoundingClientRect().width,
          preview: sample.preview.getBoundingClientRect().width,
          outgoingVisible: Boolean(
            sample.panel.querySelector("img")?.checkVisibility(),
          ),
        });
        const elapsed = performance.now() - start;
        const closingPanel =
          path === "chapter.tex" ? sample.panel : sample.preview;
        if (
          (elapsed >= 700 && closingPanel.getBoundingClientRect().width < 1) ||
          elapsed >= 5000
        )
          sample.done = true;
        else requestAnimationFrame(frame);
      };
      frame();
    }, path);
    await page.locator(`[data-sidebar-file-id="${path}"]`).click();
    if (path === "chapter.tex")
      await expect(page.locator(".cm-editor")).toBeVisible();
    else
      await expect(
        page.getByRole("region", { name: "Current version", exact: true }),
      ).toBeVisible();
    await expect
      .poll(() => sample.evaluate((sample) => sample.done))
      .toBe(true);
    const frames = await sample.evaluate((sample) => sample.frames);
    await testInfo.attach(`right-panel-transition-${path}`, {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    writeFileSync(
      testInfo.outputPath(`frames-${path}.json`),
      JSON.stringify(frames, null, 2),
    );
    const start = frames[0];
    expect(
      Math.max(...frames.map((f) => f.editor)) -
        Math.min(...frames.map((f) => f.editor)),
    ).toBeLessThan(2);
    const moving = frames.filter((f) => f.incoming > 20 && f.preview > 20);
    expect(moving.length).toBeGreaterThan(2);
    expect(moving.every((f) => f.outgoingVisible)).toBe(true);
    expect(
      frames.at(-1)![path === "chapter.tex" ? "incoming" : "preview"],
    ).toBeLessThan(1);
    expect(
      frames.at(-1)![path === "chapter.tex" ? "preview" : "incoming"],
    ).toBeGreaterThan(start.incoming + start.preview - 2);
  }

  const video = page.video();
  await page.context().close();
  await video?.saveAs("test-results/git-conflict-incoming-to-preview.webm");
});

test("Duet merge tabs reuse the Artisan drawer exit and entry animations", async ({
  page,
}, testInfo) => {
  await openProject(page);
  await openFile(page, "chapter.tex");
  const duet = page.getByRole("tab", { name: "Duet", exact: true });
  const artisan = page.getByRole("tab", { name: "Artisan", exact: true });
  const overlay = page.locator('[data-chat-drawer-overlay="true"]');
  await duet.click();
  await expect(duet).toHaveAttribute("aria-selected", "true");
  await expect(overlay).toHaveAttribute("data-composer-transfer-phase", "idle");

  const record = async (action: () => Promise<unknown>) => {
    // Mode hydration and panel resizing can outlast the initial idle phase.
    // Start each recording only after the drawer has settled on screen.
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        let previous = "";
        let stableFrames = 0;
        const started = performance.now();
        const sample = () => {
          const shell = document.querySelector(
            '[data-chat-drawer-transition-shell="true"]',
          );
          const panel = document.querySelector(
            '[data-chat-drawer-panel="true"]',
          );
          const overlay = document.querySelector(
            '[data-chat-drawer-overlay="true"]',
          );
          const rect = shell?.getBoundingClientRect();
          const geometry = rect
            ? `${rect.x}:${rect.y}:${rect.width}:${rect.height}`
            : "hidden";
          const idle =
            !panel ||
            (getComputedStyle(panel).animationName === "none" &&
              overlay?.getAttribute("data-composer-transfer-phase") === "idle");
          stableFrames = idle && geometry === previous ? stableFrames + 1 : 0;
          previous = geometry;
          if (stableFrames >= 12) resolve();
          else if (performance.now() - started > 5000)
            reject(new Error("Drawer did not settle before recording"));
          else requestAnimationFrame(sample);
        };
        sample();
      });
    });
    const recording = page.evaluate(async () => {
      const frames: {
        present: boolean;
        animation: string | null;
        scaleY: number;
        opacity: number;
        phase: string | null;
        composerY: number;
        shellWidth: number;
        shellX: number;
      }[] = [];
      await new Promise<void>((resolve) => {
        const start = performance.now();
        const sample = () => {
          const panel = document.querySelector(
            '[data-chat-drawer-panel="true"]',
          );
          const overlay = document.querySelector(
            '[data-chat-drawer-overlay="true"]',
          );
          const composer = panel?.querySelector(
            '[data-chat-composer-shell="true"]',
          );
          const style = panel ? getComputedStyle(panel) : null;
          const shell = document
            .querySelector('[data-chat-drawer-transition-shell="true"]')
            ?.getBoundingClientRect();
          frames.push({
            shellWidth: shell?.width ?? 0,
            shellX: shell?.x ?? 0,
            present: Boolean(panel),
            animation: style?.animationName ?? null,
            scaleY: style ? new DOMMatrix(style.transform).m22 : 0,
            opacity: style ? Number(style.opacity) : 0,
            phase:
              overlay?.getAttribute("data-composer-transfer-phase") ?? null,
            composerY: composer
              ? new DOMMatrix(getComputedStyle(composer).transform).m42
              : 0,
          });
          const elapsed = performance.now() - start;
          const last = frames.at(-1)!;
          const settled =
            !last.present ||
            (last.phase === "idle" &&
              last.opacity === 1 &&
              Math.abs(last.composerY) < 0.1);
          if ((elapsed >= 900 && settled) || elapsed >= 5000) resolve();
          else requestAnimationFrame(sample);
        };
        sample();
      });
      return frames;
    });
    await action();
    return recording;
  };

  const baselineExit = await record(() => artisan.click());
  const baselineEntry = await record(() => duet.click());
  const tabExit = await record(() =>
    page.locator('[data-sidebar-file-id="figure.png"]').click(),
  );
  await expect(duet).toHaveAttribute("aria-selected", "true");
  const tabEntry = await record(() =>
    page.locator('[data-sidebar-file-id="chapter.tex"]').click(),
  );
  await expect(duet).toHaveAttribute("aria-selected", "true");
  for (const [name, frames] of [
    ["baseline-exit", baselineExit],
    ["baseline-entry", baselineEntry],
    ["tab-exit", tabExit],
    ["tab-entry", tabEntry],
  ] as const) {
    await testInfo.attach(name, {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    if (name.endsWith("exit")) {
      expect(
        frames.some(
          (f) =>
            f.animation === "workspace-drawer-tv-off" &&
            f.scaleY > 0 &&
            f.scaleY < 0.95,
        ),
      ).toBe(true);
      for (const frame of frames.filter(
        (f) => f.animation === "workspace-drawer-tv-off",
      )) {
        expect(Math.abs(frame.shellWidth - frames[0].shellWidth)).toBeLessThan(
          2,
        );
        expect(Math.abs(frame.shellX - frames[0].shellX)).toBeLessThan(2);
      }
      expect(frames.at(-1)!.present).toBe(false);
    } else {
      expect(
        frames.some(
          (f) => f.animation === "drawer-opacity-reveal" && f.opacity < 1,
        ),
      ).toBe(true);
      expect(frames.some((f) => f.phase === "drawer_enter_prep")).toBe(true);
      expect(
        frames.some((f) => f.phase === "drawer_enter" && f.composerY > 1),
      ).toBe(true);
      const enteringFrames = frames.filter(
        (f) =>
          f.animation === "drawer-opacity-reveal" || f.phase === "drawer_enter",
      );
      for (const frame of enteringFrames) {
        expect(
          Math.abs(frame.shellWidth - enteringFrames[0].shellWidth),
        ).toBeLessThan(2);
        expect(Math.abs(frame.shellX - enteringFrames[0].shellX)).toBeLessThan(
          2,
        );
      }
      expect(frames.at(-1)!.present).toBe(true);
      expect(frames.at(-1)!.phase).toBe("idle");
      expect(frames.at(-1)!.composerY).toBeCloseTo(0);
      expect(frames.at(-1)!.opacity).toBeCloseTo(1);
    }
  }

  // Interrupt exit with entry, then entry with exit. The last tab must win.
  for (const path of ["figure.png", "chapter.tex", "figure.png"]) {
    await page.locator(`[data-sidebar-file-id="${path}"]`).click();
  }
  await expect(overlay).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(overlay).toHaveCount(0);
  await page.locator('[data-sidebar-file-id="chapter.tex"]').click();
  await expect(overlay).toHaveAttribute("data-drawer-presence", "visible");
  await expect(overlay).toHaveAttribute("data-composer-transfer-phase", "idle");
  await expect(duet).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: "test-results/duet-text-drawer-restored.png" });
  const video = page.video();
  await page.context().close();
  await video?.saveAs("test-results/duet-merge-drawer-animation.webm");
});

test("image headers share PDF zoom controls without cropping", async ({
  page,
}) => {
  const view = await openImage(page);
  const current = view.getByRole("region", {
    name: "Current version",
    exact: true,
  });
  const incoming = view.getByRole("region", {
    name: "Incoming version",
    exact: true,
  });
  const toolbar = page.locator("[data-editor-toolbar]");
  await expect(toolbar.getByRole("combobox")).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: /Zoom|Crop/ })).toHaveCount(
    0,
  );
  for (const pane of [current, incoming]) {
    const imageHeader = pane.getByRole("toolbar", { name: "Image controls" });
    await expect(pane.locator("header")).toHaveCount(1);
    await expect(
      imageHeader.getByRole("button", { name: /Accept (current|incoming)/ }),
    ).toBeVisible();
    const sizeBox = (await imageHeader
      .getByText("4 KB", { exact: true })
      .boundingBox())!;
    const zoomBox = (await imageHeader
      .getByRole("button", { name: "Zoom out", exact: true })
      .boundingBox())!;
    expect(sizeBox.x + sizeBox.width).toBeLessThan(zoomBox.x);
    await expect(
      pane.getByRole("toolbar", { name: "Image controls" }),
    ).toContainText("4 KB");
    await expect(
      pane.getByRole("button", { name: "Crop", exact: true }),
    ).toHaveCount(0);
  }
  const image = current.getByRole("img");
  for (const pane of [current, incoming]) {
    await expect(
      pane.getByRole("button", { name: "Fit width", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
  }
  const checkFit = async (pane: typeof current, mode: "width" | "height") => {
    await pane
      .getByRole("button", { name: `Fit ${mode}`, exact: true })
      .click();
    await expect
      .poll(() =>
        pane.getByRole("img").evaluate((el, dimension) => {
          const viewport = el.closest(".app-scrollbar")!;
          const style = getComputedStyle(viewport);
          const available =
            dimension === "width"
              ? viewport.clientWidth -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight)
              : viewport.clientHeight -
                parseFloat(style.paddingTop) -
                parseFloat(style.paddingBottom);
          return Math.abs(el.getBoundingClientRect()[dimension] - available);
        }, mode),
      )
      .toBeLessThan(2);
  };
  await checkFit(current, "height");
  await expect(
    incoming.getByRole("button", { name: "Fit width", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width: 1100, height: 850 });
  await checkFit(current, "height");
  for (const pane of [current, incoming]) {
    expect(
      await pane
        .getByRole("toolbar", { name: "Image controls" })
        .evaluate((header) => {
          const bounds = header.getBoundingClientRect();
          return [...header.querySelectorAll("button, input")].every(
            (control) => {
              const rect = control.getBoundingClientRect();
              return (
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom
              );
            },
          );
        }),
    ).toBe(true);
  }
  await page.screenshot({
    path: test.info().outputPath("image-fit-height-merge.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await checkFit(current, "width");
  const before = await image.boundingBox();
  await current.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(
    current.getByRole("textbox", { name: "Zoom percentage" }),
  ).toHaveValue("125%");
  await expect(
    incoming.getByRole("button", { name: "Fit width", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await image.boundingBox())!.width).toBeGreaterThan(before!.width);
  await page.screenshot({
    path: test.info().outputPath("image-merge-headers.png"),
    animations: "disabled",
  });
  await current.getByRole("button", { name: "Accept current" }).click();
  await expect(
    page.getByRole("region", { name: "Current version", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("chapter.tex");
  await openFile(page, "figure.png");
  // The conflict fixture starts with missing working-tree files. Supply the
  // loaded image bytes for the normal editor, as opening a real image does.
  await page.evaluate(async () => {
    const useDocumentStore = window.__gitActionsDocumentStore!;
    const blob = await (await fetch("/favicon.png")).blob();
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    useDocumentStore.setState((state) => ({
      files: state.files.map((file) =>
        file.id === "figure.png" ? { ...file, dataUrl } : file,
      ),
    }));
  });
  const header = page.getByRole("toolbar", { name: "Image controls" });
  await expect(header).toHaveCount(1);
  await expect(
    header.getByRole("button", { name: "Crop", exact: true }),
  ).toHaveCount(0);
  const normalImage = page.getByRole("img", {
    name: "figure.png",
    exact: true,
  });
  await expect
    .poll(() => normalImage.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
  await expect(
    header.getByRole("button", { name: "Fit width", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  const fullSize = await normalImage.boundingBox();
  const percentage = header.getByRole("textbox", { name: "Zoom percentage" });
  await percentage.fill("50%");
  await percentage.press("Enter");
  await expect(percentage).toHaveValue("50%");
  await expect(
    header.getByRole("button", { name: "Fit width", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect
    .poll(
      async () => (await normalImage.boundingBox())!.width / fullSize!.width,
    )
    .toBeCloseTo(0.5, 1);
  await expect(header).not.toContainText("Size unavailable");
  await header.getByRole("button", { name: "Fit height", exact: true }).click();
  await expect
    .poll(() =>
      normalImage.evaluate((el) => {
        const viewport = el.closest(".app-scrollbar")!;
        return Math.abs(
          el.getBoundingClientRect().height - (viewport.clientHeight - 32),
        );
      }),
    )
    .toBeLessThan(2);
  await page.screenshot({
    path: test.info().outputPath("image-fit-height-normal.png"),
    animations: "disabled",
  });

  const sourceBefore = await normalImage.getAttribute("src");
  const sizeBefore = await normalImage.evaluate((el: HTMLImageElement) => [
    el.naturalWidth,
    el.naturalHeight,
  ]);
  const inputChecks = [
    ["175", "Enter", "175%"],
    ["not a number", "Enter", "175%"],
    ["225", "Escape", "175%"],
    ["9999", "Enter", "400%"],
    ["0", "Enter", "25%"],
  ];
  for (const [value, key, expected] of inputChecks) {
    await percentage.fill(value);
    await percentage.press(key);
    await expect(percentage).toHaveValue(expected);
  }
  await expect(
    header.getByRole("button", { name: "Zoom out", exact: true }),
  ).toBeDisabled();
  await percentage.fill("400");
  await percentage.press("Tab");
  await expect(percentage).toHaveValue("400%");
  await expect(
    header.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeDisabled();
  await normalImage.click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("Control+0");
  await expect(percentage).toHaveValue("100%");
  await page.keyboard.press("Control+-");
  await expect(percentage).toHaveValue("75%");
  await normalImage.dispatchEvent("wheel", { ctrlKey: true, deltaY: -100 });
  await expect(percentage).toHaveValue("85%");
  await header.getByRole("button", { name: "Fit width", exact: true }).click();
  await page.setViewportSize({ width: 900, height: 700 });
  await expect
    .poll(() =>
      normalImage.evaluate((el) => {
        const viewport = el.closest(".app-scrollbar")!;
        return Math.abs(
          el.getBoundingClientRect().width - (viewport.clientWidth - 32),
        );
      }),
    )
    .toBeLessThan(2);
  await expect(normalImage).toHaveAttribute("src", sourceBefore!);
  expect(
    await normalImage.evaluate((el: HTMLImageElement) => [
      el.naturalWidth,
      el.naturalHeight,
    ]),
  ).toEqual(sizeBefore);
  await expect(
    page.getByRole("button", { name: "Crop", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("image-normal-header.png"),
    animations: "disabled",
  });
  const opened = page.waitForEvent("popup");
  await page.evaluate(async () => {
    const { openPanelWindow } = await import(
      /* @vite-ignore */ "/src/renderer/lib/panel-windows.ts"
    );
    await openPanelWindow("editor", "duet", { fileId: "figure.png" });
  });
  const child = await opened;
  await child.setViewportSize({ width: 380, height: 620 });
  const childHeader = child.getByRole("toolbar", { name: "Image controls" });
  const childPercentage = childHeader.getByRole("textbox", {
    name: "Zoom percentage",
  });
  await expect(childPercentage).toBeVisible();
  await childHeader
    .getByRole("button", { name: "Fit height", exact: true })
    .click();
  await expect(
    childHeader.getByRole("button", { name: "Fit height", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await childPercentage.fill("150");
  await childPercentage.press("Enter");
  await expect(childPercentage).toHaveValue("150%");
  await expect(
    childHeader.getByRole("button", { name: "Fit height", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(
    childHeader.getByRole("button", { name: "Fit width", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await child.mouse.move(10, 10);
  await expect(percentage).toHaveValue("100%");
  await expect(
    child.getByRole("button", { name: "Crop", exact: true }),
  ).toHaveCount(0);
  await expect(
    child.getByRole("img", { name: "figure.png", exact: true }),
  ).toHaveAttribute("src", sourceBefore!);
  await child.screenshot({
    path: test.info().outputPath("image-popout-narrow.png"),
  });
  await child.close();
});

for (const [file, choice, key, hint] of [
  ["figure.png", "current", "n", "⌘N"],
  ["data.bin", "incoming", "y", "⌘Y"],
] as const) {
  test(`${file} resolves ${choice} from its header shortcut`, async ({
    page,
  }) => {
    await openProject(page);
    await openFile(page, file);
    const pane = page.getByRole("region", {
      name: `${choice === "current" ? "Current" : "Incoming"} version`,
      exact: true,
    });
    const header = pane.getByRole("toolbar");
    const accept = header.getByRole("button", {
      name: `Accept ${choice}`,
      exact: true,
    });
    await expect(accept).toContainText(`Accept ${choice}`);
    await expect(accept.locator("kbd")).toHaveText(hint);
    await expect(pane.locator("header")).toHaveCount(1);
    if (file === "data.bin") {
      await expect(header).toContainText("BIN file · 4 KB");
      await expect(header.getByRole("combobox")).toHaveCount(0);
      await page.screenshot({
        path: "test-results/binary-merge-header.png",
        animations: "disabled",
      });
    }
    await accept.focus();
    await page.keyboard.press(`Meta+${key}`);
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __gitSetupCommands: Array<{
                command: string;
                args?: { filePath?: string; choice?: string };
              }>;
            }
          ).__gitSetupCommands
            .filter(
              (entry) => entry.command === "git_panel_resolve_conflict_side",
            )
            .map((entry) => ({
              file: entry.args?.filePath,
              choice: entry.args?.choice,
            })),
        ),
      )
      .toEqual([{ file, choice }]);
    await expect(page.locator('[data-git-conflicted="true"]')).toHaveCount(2);
  });
}

test("normal non-editor files show type and size without image controls", async ({
  page,
}) => {
  await openProject(page);
  await page.evaluate(async () => {
    const useDocumentStore = window.__gitActionsDocumentStore!;
    const store = useDocumentStore.getState();
    useDocumentStore.setState({
      files: [
        ...store.files,
        {
          id: "archive.dat",
          name: "archive.dat",
          relativePath: "archive.dat",
          absolutePath: `${store.projectRoot}/archive.dat`,
          type: "other",
          isBinary: true,
          fileSize: 8192,
          isDirty: false,
        },
      ],
    });
  });
  await openFile(page, "archive.dat");
  const header = page.getByRole("toolbar", {
    name: "File information",
    exact: true,
  });
  await expect(header).toHaveText("DAT file · 8 KB");
  await expect(header.getByRole("button")).toHaveCount(0);
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await expect(
    page.getByText("No preview available", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/binary-normal-header.png",
    animations: "disabled",
  });
});

test("external whole-file conflict exposes a slate selectable common ancestor", async ({
  page,
}) => {
  await openProject(page, "nontext", false, false, true);
  await openFile(page, "figure.png");
  const view = page.getByRole("region", {
    name: "File conflict versions",
    exact: true,
  });
  const ancestor = view.getByRole("region", {
    name: "Common ancestor version",
    exact: true,
  });
  await expect(ancestor).toBeVisible();
  await expect(
    view.getByRole("region", { name: "Current version", exact: true }),
  ).toBeVisible();
  await expect(
    view.getByRole("region", { name: "Incoming version", exact: true }),
  ).toBeVisible();
  const choice = ancestor.getByRole("button", {
    name: "Use starting version of entire file",
  });
  await expect(choice).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(choice).toHaveCSS("background-color", "rgb(100, 116, 139)");
  await page.screenshot({
    path: "test-results/git-three-way-file.png",
    animations: "disabled",
  });
  await choice.click();
  await expect(
    page.locator('[data-sidebar-file-id="figure.png"]'),
  ).not.toHaveAttribute("data-git-conflicted", "true");
  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands,
  );
  expect(commands).toContainEqual({
    command: "git_panel_resolve_conflict_side",
    args: expect.objectContaining({
      choice: "ancestor",
      expectedVersion: "conflict:figure.png",
    }),
  });
});

test("external text conflict labels ancestor restoration as the entire file", async ({
  page,
}) => {
  await openProject(page, "text", false, false, true);
  await openFile(page, "neurips_2026.tex");
  await expect(
    page.getByText("Common ancestor · entire starting file", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("details pre")).toContainText("Starting content");
  const useStarting = page.getByRole("button", {
    name: "Use starting file",
    exact: true,
  });
  await expect(useStarting).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(useStarting).toHaveCSS("background-color", "rgb(100, 116, 139)");
  await page.screenshot({
    path: "test-results/git-three-way-text.png",
    animations: "disabled",
  });
  await useStarting.click();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("Starting content");
});
