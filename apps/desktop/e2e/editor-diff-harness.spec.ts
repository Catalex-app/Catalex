import { expect, test } from "@playwright/test";

test("agent execution keeps the source editor and source PDF visible", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&agentDraft=working&withPdf", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(page.locator('[data-agent-draft-banner="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(page.locator(".cm-editor")).toContainText(
    "This paragraph is the original text.",
  );
  await expect(page.locator(".cm-editor")).not.toContainText(
    "proposed change from the assistant",
  );
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__editorDiffHarness?.getState?.().compileRequestContents ?? [],
      ),
    )
    .toContain(
      "% Diff harness\n\\documentclass{article}\n\\begin{document}\n\\section{Draft}\nThis paragraph is the original text.\n\\end{document}\n",
    );

  await page.screenshot({
    path: "test-results/agent-workspace-working.png",
    fullPage: true,
  });
});

test("completed Ask draft uses a compact chat link to open the existing review", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&agentDraft=review&withChat", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  if (!(await page.locator("[data-chat-messages]").isVisible())) {
    await page.getByRole("button", { name: "Toggle drawer" }).click();
  }

  const reviewLink = page.locator('[data-agent-workspace-review-link="true"]');
  await expect(reviewLink).toHaveText("Review draft (1 change)");
  await expect(page.getByRole("button", { name: "Accept draft" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Reject draft" })).toHaveCount(
    0,
  );

  await page.screenshot({
    path: "test-results/agent-workspace-chat-link.png",
    fullPage: true,
  });

  await reviewLink.click();
  await expect(
    page.locator('[data-proposed-changes-panel="true"]'),
  ).toContainText("Review draft");
});

test("recovered draft opens its chat and review state without an error banner", async ({
  page,
}) => {
  await page.goto(
    "/?debug=editor-diff&agentDraft=review&recoverDraft&withChat",
    { waitUntil: "domcontentloaded" },
  );

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  const chatMessages = page.locator("[data-chat-messages]");
  await expect(chatMessages.getByText("Polish this paragraph")).toBeVisible();
  await expect(
    chatMessages.getByText("Polished the paragraph and verified the document."),
  ).toBeVisible();
  await expect(
    page.getByText("Recovered an unsettled agent draft", { exact: false }),
  ).toHaveCount(0);
  await expect(page.locator("[data-chat-error-composer]")).toHaveCount(0);
  await expect(
    page.locator('[data-proposed-changes-panel="true"]'),
  ).toContainText("Review draft");

  await page.screenshot({
    path: "test-results/agent-workspace-recovered-chat.png",
    fullPage: true,
  });
});

test("completed Ask draft enters review with the accepted editor and PDF case", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&agentDraft=review&withPdf", {
    waitUntil: "domcontentloaded",
  });

  const panel = page.locator('[data-proposed-changes-panel="true"]');
  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(panel).toContainText("Review draft");
  await expect(panel).not.toContainText("modified");
  await expect(page.locator(".cm-content")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(page.getByRole("button", { name: /Reject All/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await expect(page.locator(".cm-editor")).toContainText(
    "This paragraph has a proposed change from the assistant.",
  );
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          window.__editorDiffHarness?.getState?.().compileRequestContents ?? [],
      ),
    )
    .toContain(
      "% Diff harness\n\\documentclass{article}\n\\begin{document}\n\\section{Revised Draft}\nThis paragraph has a proposed change from the assistant.\n\\end{document}\n",
    );

  await page.screenshot({
    path: "test-results/agent-workspace-review.png",
    fullPage: true,
  });
});

test("AI review puts reject actions before accept actions", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator(".cm-chunkButtons").first()).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);

  const [blockReject, blockAccept, rejectAll, acceptAll] = await Promise.all([
    page
      .locator('.cm-chunkButtons button[name="reject"]')
      .first()
      .boundingBox(),
    page
      .locator('.cm-chunkButtons button[name="accept"]')
      .first()
      .boundingBox(),
    page.getByRole("button", { name: "Reject All ⌘N" }).boundingBox(),
    page.getByRole("button", { name: "Accept All ⌘Y" }).boundingBox(),
  ]);
  expect(blockReject?.x).toBeLessThan(blockAccept?.x ?? 0);
  expect(rejectAll?.x).toBeLessThan(acceptAll?.x ?? 0);

  await page.screenshot({
    path: "test-results/editor-proposed-reject-first.png",
    fullPage: true,
  });
});

test("pending AI review survives Home navigation and an app reload", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&persistentReview=seed", {
    waitUntil: "domcontentloaded",
  });

  const proposalPanel = page.locator('[data-proposed-changes-panel="true"]');
  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(proposalPanel).toBeVisible();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Reject All/ })).toBeVisible();

  const homePendingCount = await page.evaluate(() =>
    window.__editorDiffHarness?.leavePersistentReviewProject?.(),
  );
  expect(homePendingCount).toBe(0);
  await expect(proposalPanel).toHaveCount(0);

  const reopenedPendingCount = await page.evaluate(() =>
    window.__editorDiffHarness?.reopenPersistentReviewProject?.(),
  );
  expect(reopenedPendingCount).toBe(1);
  await expect(proposalPanel).toBeVisible();

  await page.goto("/?debug=editor-diff&persistentReview=restore", {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(proposalPanel).toBeVisible();
  await expect(page.locator(".cm-chunkButtons").first()).toBeVisible();
  await expect(page.locator("#loading-screen")).toHaveCount(0);

  await page.screenshot({
    path: "test-results/editor-restored-ai-review.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Accept All ⌘Y" }).click();
  await expect(proposalPanel).toHaveCount(0);
  const resolvedAfterReopen = await page.evaluate(() => {
    window.__editorDiffHarness?.leavePersistentReviewProject?.();
    return window.__editorDiffHarness?.reopenPersistentReviewProject?.();
  });
  expect(resolvedAfterReopen).toBe(0);
});

test("ignored files hide Git line markers while untracked files keep them", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1&gitHead=ignored", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator(".cm-gitChangeGutter")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/editor-ignored-file-no-gutter.png",
    fullPage: true,
  });

  await page.goto("/?debug=editor-diff&deferDiff=1&gitHead=untracked", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator(".cm-gitChangeGutter")).toHaveCount(1);
  await expect(page.locator(".cm-gitLineAdd").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/editor-untracked-file-gutter.png",
    fullPage: true,
  });
});

test("Git conflicts use a Current versus Incoming merge review", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitConflict=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await expect(page.getByText("Resolve Git Conflict")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Use incoming for this conflict" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Keep current for this conflict" }),
  ).toBeVisible();

  const editor = page.locator(".cm-editor");
  await expect(editor).toContainText("Making some issues");
  await expect(editor).toContainText("Making some problems");
  await expect(editor).not.toContainText("<<<<<<< HEAD");
  await expect(editor.locator(".cm-changeGutter")).toHaveCount(1);
  await expect(editor.locator(".cm-changedLineGutter")).toBeVisible();
  await expect(editor.locator(".cm-deletedLineGutter")).toBeVisible();
  await expect(editor.locator(".cm-gitChangeGutter")).toHaveCount(0);

  const conflictColors = await page.evaluate(() => {
    const incoming = document.querySelector<HTMLButtonElement>(
      '.cm-chunkButtons button[name="accept"]',
    );
    const current = document.querySelector<HTMLButtonElement>(
      '.cm-chunkButtons button[name="reject"]',
    );
    const incomingGutter = document.querySelector<HTMLElement>(
      ".cm-changedLineGutter",
    );
    const currentGutter = document.querySelector<HTMLElement>(
      ".cm-deletedLineGutter",
    );
    return {
      incoming: incoming ? getComputedStyle(incoming).backgroundColor : null,
      current: current ? getComputedStyle(current).backgroundColor : null,
      incomingGutter: incomingGutter
        ? getComputedStyle(incomingGutter).backgroundColor
        : null,
      currentGutter: currentGutter
        ? getComputedStyle(currentGutter).backgroundColor
        : null,
    };
  });
  expect(conflictColors).toEqual({
    incoming: "rgb(124, 58, 237)",
    current: "rgb(37, 99, 235)",
    incomingGutter: "rgb(124, 58, 237)",
    currentGutter: "rgb(37, 99, 235)",
  });
  const [blockCurrent, blockIncoming, allCurrent, allIncoming] =
    await Promise.all([
      page
        .getByRole("button", { name: "Keep current for this conflict" })
        .boundingBox(),
      page
        .getByRole("button", { name: "Use incoming for this conflict" })
        .boundingBox(),
      page.getByRole("button", { name: /Keep All Current/ }).boundingBox(),
      page.getByRole("button", { name: /Use All Incoming/ }).boundingBox(),
    ]);
  expect(blockCurrent?.x).toBeLessThan(blockIncoming?.x ?? 0);
  expect(allCurrent?.x).toBeLessThan(allIncoming?.x ?? 0);

  await page.screenshot({
    path: "test-results/editor-git-conflict.png",
    fullPage: true,
  });

  await page
    .getByRole("button", { name: "Use incoming for this conflict" })
    .click();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText(
    "Making some problems",
  );
  await expect(page.locator(".cm-content")).not.toContainText(
    "Making some issues",
  );
});

test("Git conflicts can use all incoming content", async ({ page }) => {
  await page.goto("/?debug=editor-diff&gitConflict=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await page.getByRole("button", { name: /Use All Incoming/ }).click();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText(
    "Making some problems",
  );
  await expect(page.locator(".cm-content")).not.toContainText(
    "Making some issues",
  );
});

test("Cmd+Z reopens the last resolved conflict before finishing the merge", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitConflict=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await page.getByRole("button", { name: /Use All Incoming/ }).click();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText(
    "Making some problems",
  );

  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("Making some issues");
  await expect(page.locator(".cm-content")).toContainText(
    "Making some problems",
  );
  await expect(page.locator(".cm-content")).not.toContainText("<<<<<<<");

  await page.screenshot({
    path: "test-results/editor-git-conflict-undo.png",
    fullPage: true,
  });
});

test("Cmd+Z restores Git conflict choices one action at a time", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitConflict=multi", {
    waitUntil: "domcontentloaded",
  });

  const incomingActions = page.getByRole("button", {
    name: "Use incoming for this conflict",
  });
  const currentActions = page.getByRole("button", {
    name: "Keep current for this conflict",
  });
  const editor = page.locator(".cm-content");
  const initialPreviewRefreshCount = await page.evaluate(
    () =>
      window.__editorDiffHarness?.getState?.().mergePreviewRefreshCount ?? 0,
  );

  await expect(incomingActions).toHaveCount(2);
  await incomingActions.first().click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__editorDiffHarness?.getState?.().mergePreviewRefreshCount ??
          0,
      ),
    )
    .toBe(initialPreviewRefreshCount + 1);
  await expect(incomingActions).toHaveCount(1);
  await expect(editor).toContainText("First choice from incoming");
  await expect(editor).not.toContainText("First choice from current");

  await currentActions.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__editorDiffHarness?.getState?.().mergePreviewRefreshCount ??
          0,
      ),
    )
    .toBe(initialPreviewRefreshCount + 2);
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(editor).toContainText("First choice from incoming");
  await expect(editor).toContainText("Second choice from current");

  await page.keyboard.press("ControlOrMeta+z");

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__editorDiffHarness?.getState?.().mergePreviewRefreshCount ??
          0,
      ),
    )
    .toBe(initialPreviewRefreshCount + 3);
  await expect(incomingActions).toHaveCount(1);
  await expect(editor).toContainText("First choice from incoming");
  await expect(editor).not.toContainText("First choice from current");
  await expect(editor).toContainText("Second choice from incoming");
  await expect(editor).toContainText("Second choice from current");

  await page.keyboard.press("ControlOrMeta+z");

  await expect(incomingActions).toHaveCount(2);
  await expect(editor).toContainText("First choice from incoming");
  await expect(editor).toContainText("First choice from current");

  await page.screenshot({
    path: "test-results/editor-git-conflict-action-undo.png",
    fullPage: true,
  });
});

test("Git conflicts can keep all current content", async ({ page }) => {
  await page.goto("/?debug=editor-diff&gitConflict=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await page.getByRole("button", { name: /Keep All Current/ }).click();
  await expect(page.locator('[data-git-conflict-panel="true"]')).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("Making some issues");
  await expect(page.locator(".cm-content")).not.toContainText(
    "Making some problems",
  );
});

test("Keep Current recompiles the provisional Current source", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitConflict=multi&withPdf=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator('[data-git-conflict-panel="true"]')).toBeVisible();
  await expect(page.getByTestId("editor-diff-pdf-shell")).toBeVisible();
  await page.waitForFunction(
    () =>
      (window.__editorDiffHarness?.getState?.().compileRequestContents.length ??
        0) > 0,
  );
  const initialCompileCount = await page.evaluate(
    () =>
      window.__editorDiffHarness?.getState?.().compileRequestContents.length ??
      0,
  );

  await page
    .getByRole("button", { name: "Keep current for this conflict" })
    .first()
    .click();

  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__editorDiffHarness?.getState?.().compileRequestContents
              .length ?? 0,
        ),
      { timeout: 5_000 },
    )
    .toBeGreaterThan(initialCompileCount);
  const latestCompiledSource = await page.evaluate(() => {
    const contents =
      window.__editorDiffHarness?.getState?.().compileRequestContents ?? [];
    return contents[contents.length - 1] ?? "";
  });
  expect(latestCompiledSource).toContain("First choice from current");
  expect(latestCompiledSource).not.toContain("First choice from incoming");
  expect(latestCompiledSource).toContain("Second choice from incoming");
  expect(latestCompiledSource).not.toContain("<<<<<<<");

  await page.screenshot({
    path: "test-results/editor-git-conflict-pdf-current.png",
    fullPage: true,
  });
});

test("accepted agent edits remain undoable and redoable", async ({ page }) => {
  await page.goto("/?debug=editor-diff&deferDiff=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorDiffHarness?.ready;
  });
  const activated = await page.evaluate(() => {
    return window.__editorDiffHarness?.activateDiffWithStaleWholeDocumentSelection?.();
  });
  expect(activated).toBe(true);
  await expect(
    page.getByRole("button", { name: "Accept All ⌘Y" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reject All ⌘N" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/editor-proposed-actions.png",
    fullPage: true,
  });

  const beforeAcceptState = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });
  expect(beforeAcceptState?.cmSelection?.empty).toBe(true);
  expect(beforeAcceptState?.cmSelection?.from).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Accept All ⌘Y" }).click();

  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Revised Draft");
  await expect(editor).toBeFocused();
  const acceptedState = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });
  expect(acceptedState?.cmSelection).toEqual(beforeAcceptState?.cmSelection);
  await page.keyboard.press("ControlOrMeta+z");

  await expect(editor).toContainText("This paragraph is the original text.");
  await expect(editor).not.toContainText("Revised Draft");
  const undoneState = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });
  expect(undoneState?.cmSelection?.empty).toBe(true);
  expect(undoneState?.cmSelection?.from).toBe(
    beforeAcceptState?.cmSelection?.from,
  );
  expect(undoneState?.cmSelection?.to).toBe(beforeAcceptState?.cmSelection?.to);

  await page.keyboard.press("ControlOrMeta+Shift+z");

  await expect(editor).toContainText("Revised Draft");
  await expect(editor).toContainText(
    "This paragraph has a proposed change from the assistant.",
  );
  const redoneState = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });
  expect(redoneState?.cmSelection?.empty).toBe(true);
});

test("editor diff harness clears stale selection context when merge mode starts", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorDiffHarness?.ready;
  });

  const activated = await page.evaluate(() => {
    return window.__editorDiffHarness?.activateDiffWithStaleWholeDocumentSelection?.();
  });
  expect(activated).toBe(true);

  await expect(
    page.locator('[data-proposed-changes-panel="true"]'),
  ).toBeVisible();
  await page.waitForFunction(() => {
    return window.__editorDiffHarness?.getState?.().storeSelection === null;
  });

  const state = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });

  expect(state?.storeSelection).toBeNull();
  expect(state?.cmSelection?.empty).toBe(true);
  expect(state?.proposedPanelVisible).toBe(true);
  expect(state?.inlineCommentMarkCount).toBe(0);
});

test("editor diff harness keeps merge controls in the reserved spacer row", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorDiffHarness?.ready;
  });

  const activated = await page.evaluate(() => {
    return window.__editorDiffHarness?.activateDiffWithStaleWholeDocumentSelection?.();
  });
  expect(activated).toBe(true);

  await expect(page.locator(".cm-chunkButtons")).toBeVisible();
  await expect(page.getByLabel("Accept this change")).toHaveCount(0);
  await expect(page.getByLabel("Reject this change")).toHaveCount(0);

  const layout = await page.evaluate(() => {
    const buttons = document.querySelector(".cm-chunkButtons");
    const deletedChunk = document.querySelector(".cm-deletedChunk");
    if (!(buttons instanceof HTMLElement)) return null;
    if (!(deletedChunk instanceof HTMLElement)) return null;

    const buttonRect = buttons.getBoundingClientRect();
    const deletedRect = deletedChunk.getBoundingClientRect();
    return {
      buttonsBottom: buttonRect.bottom,
      deletedTop: deletedRect.top,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.buttonsBottom).toBeLessThanOrEqual(
    (layout?.deletedTop ?? 0) + 1,
  );
});

test("editor diff harness centers the first AI change when entering diff mode", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorDiffHarness?.ready;
  });

  const activated = await page.evaluate(() => {
    return window.__editorDiffHarness?.activateDiffWithLongUnchangedPrefix?.();
  });
  expect(activated).toBe(true);

  await expect(page.locator(".cm-chunkButtons")).toBeVisible();
  await page.waitForFunction(() => {
    const metrics = window.__editorDiffHarness?.getFirstDiffViewportMetrics?.();
    return metrics !== null && metrics.deltaFromCenter <= 48;
  });

  const state = await page.evaluate(() => {
    return window.__editorDiffHarness?.getState?.();
  });
  const metrics = await page.evaluate(() => {
    return window.__editorDiffHarness?.getFirstDiffViewportMetrics?.();
  });

  expect(state?.cmSelection?.empty).toBe(true);
  expect(metrics).not.toBeNull();
  expect(metrics?.deltaFromCenter).toBeLessThanOrEqual(48);
});

test("editor diff harness centers the first AI change after comment layout is removed", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&deferDiff=1", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByTestId("editor-diff-harness-shell")).toBeVisible();
  await page.waitForFunction(() => {
    return !!window.__editorDiffHarness?.ready;
  });

  const prepared = await page.evaluate(() => {
    return window.__editorDiffHarness?.prepareLongPrefixDocument?.();
  });
  expect(prepared).toBe(true);
  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(2);

  const scrolled = await page.evaluate(() => {
    return window.__editorDiffHarness?.setScrollTop?.(900);
  });
  expect(scrolled).toBe(true);

  const activated = await page.evaluate(() => {
    return window.__editorDiffHarness?.activateDiffWithLongUnchangedPrefix?.();
  });
  expect(activated).toBe(true);

  await expect(page.locator(".cm-inlineCommentCard")).toHaveCount(0);
  await expect(page.locator(".cm-chunkButtons")).toBeVisible();
  await page.waitForFunction(() => {
    const metrics = window.__editorDiffHarness?.getFirstDiffViewportMetrics?.();
    return metrics !== null && metrics.deltaFromCenter <= 48;
  });

  const metrics = await page.evaluate(() => {
    return window.__editorDiffHarness?.getFirstDiffViewportMetrics?.();
  });
  expect(metrics).not.toBeNull();
  expect(metrics?.deltaFromCenter).toBeLessThanOrEqual(48);
});

test("proposal originals remain selectable and read-only with Git indicators", async ({
  page,
}) => {
  await page.goto("/?debug=editor-diff&gitHead=untracked");
  const original = page.locator(".cm-deletedLine").last();
  await expect(original).toHaveText("This paragraph is the original text.");
  await expect(
    page.locator(".cm-gitChangeGutter .cm-gitLineAdd").first(),
  ).toBeVisible();
  const before = await page.locator(".cm-content").textContent();
  const box = (await original.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 8, { steps: 20 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain("This paragraph");
  await page.keyboard.type("must not edit");
  await expect(page.locator(".cm-content")).toHaveText(before!);
  await page.getByRole("button", { name: "Accept All", exact: false }).click();
  await expect(page.locator(".cm-deletedChunk")).toHaveCount(0);
  await expect(
    page.locator(".cm-gitChangeGutter .cm-gitLineAdd").first(),
  ).toBeVisible();
});
