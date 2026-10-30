import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __setGitActionsPendingReview?: (pending: boolean) => void;
    __resolveGitConflictForHarness?: () => void;
  }
}

test("Agent review disables both Git buttons and closes existing action dialogs", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&suggestions=pending", {
    waitUntil: "domcontentloaded",
  });

  const actions = page.locator('[data-ai-review-blocked="true"]');
  const primaryAction = page.getByRole("button", { name: "Commit" });
  const moreActions = page.getByRole("button", { name: "More git actions" });
  const blockedTitle = "Finish agent review to use Git actions";

  await expect(actions).toBeVisible();
  await expect(primaryAction).toBeDisabled();
  await primaryAction.hover();
  await expect(
    page.getByRole("tooltip", { name: blockedTitle, exact: true }),
  ).toBeVisible();
  await expect(moreActions).toBeDisabled();
  const box = (await moreActions.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.screenshot({
    path: "test-results/git-actions-pending-ai-review.png",
    fullPage: true,
  });

  await page.evaluate(() => window.__setGitActionsPendingReview?.(false));
  await expect(page.locator("[data-ai-review-blocked]")).toHaveCount(0);
  await expect(primaryAction).toBeEnabled();
  await expect(moreActions).toBeEnabled();
  await primaryAction.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() => window.__setGitActionsPendingReview?.(true));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(moreActions).toBeDisabled();
});

test("git actions harness truncates long paths and keeps full tooltip", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions", {
    waitUntil: "domcontentloaded",
  });

  const pathLabel = page.getByTestId("git-actions-path-label");
  await expect(pathLabel).toBeVisible();

  const rendered = (await pathLabel.textContent()) ?? "";
  expect(rendered).toContain("...");

  await pathLabel.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "supplementary-material/figures/37b682a9-64e9-4f42-a999-03dfaa7ce5b7.json",
  );

  await page.screenshot({
    path: "test-results/git-actions-harness.png",
    fullPage: true,
  });
});

test("git command disclosure stays synchronized across action dialogs", async ({
  page,
}) => {
  await page.setViewportSize({ width: 440, height: 900 });
  await page.goto("/?debug=git-actions", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Commit" }).click();
  let dialog = page.getByRole("dialog", { name: "Commit your changes" });
  const commitToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await expect(commitToggle).toHaveAttribute("aria-expanded", "false");
  await expect(dialog.getByTestId("git-command-preview")).toHaveCount(0);

  await expect(dialog).toHaveCSS("opacity", "1");
  await page.waitForTimeout(220);
  await commitToggle.click();
  const resizeDuration = await dialog.evaluate((element) => {
    const animation = element
      .getAnimations()
      .find((item) =>
        (item.effect as KeyframeEffect)
          .getKeyframes()
          .some((frame) => frame.height),
      );
    if (!animation) return null;
    animation.pause();
    animation.currentTime = 90;
    return animation.effect!.getTiming().duration;
  });
  expect(resizeDuration).toBe(180);
  await page.screenshot({
    path: "test-results/git-dialog-resize-midpoint.png",
  });
  await dialog.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  await expect(commitToggle).toHaveAttribute("aria-expanded", "true");
  const commitPreview = dialog.getByTestId("git-command-preview");
  await expect(commitPreview).toContainText("git add -- neurips_2026.tex");
  await expect(commitPreview).toContainText("git commit -m");
  await dialog
    .getByRole("button", { name: "Commit & push", exact: true })
    .click();
  await expect(commitPreview).toContainText("git push");
  const commandLayout = await commitPreview.evaluate((preview) => {
    const wrappedRows = Array.from(preview.querySelectorAll("code")).filter(
      (row) => row.getBoundingClientRect().height > 20,
    );
    return {
      clientWidth: preview.clientWidth,
      scrollWidth: preview.scrollWidth,
      wrappedRowCount: wrappedRows.length,
    };
  });
  expect(commandLayout.scrollWidth).toBeLessThanOrEqual(
    commandLayout.clientWidth + 1,
  );
  expect(commandLayout.wrappedRowCount).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/git-actions-command-disclosure.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Reset" }).click();
  dialog = page.getByRole("dialog", { name: "Reset selected files" });
  const resetToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await expect(resetToggle).toHaveAttribute("aria-expanded", "true");
  await expect(dialog.getByTestId("git-command-preview")).toContainText(
    "git restore",
  );

  await resetToggle.click();
  await expect(resetToggle).toHaveAttribute("aria-expanded", "false");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Commit" }).click();
  dialog = page.getByRole("dialog", { name: "Commit your changes" });
  await expect(
    dialog.getByRole("button", { name: "Show git command" }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("a rejected push opens concise recovery actions with predicted conflicts", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&push=rejected", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Push" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Push rejected due to conflicts",
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("overleaf/main", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Potential conflicts", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("2 files", { exact: true })).toBeVisible();
  const fileListStyle = await dialog
    .getByTestId("push-recovery-file-list")
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        borderRadius: style.borderRadius,
      };
    });
  expect(fileListStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(fileListStyle.borderTopWidth).toBe("0px");
  expect(fileListStyle.borderRadius).toBe("0px");
  await expect(
    dialog.locator('[data-push-conflicted-file="main.tex"]'),
  ).toBeVisible();
  await expect(
    dialog.locator('[data-push-conflicted-file="references.bib"]'),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Pull and merge", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Force push to override remote" }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(
    dialog.getByText(
      "The remote contains changes that are not in your local branch.",
    ),
  ).toHaveCount(0);
  await expect(page.getByText("failed to push some refs")).toHaveCount(0);
  await expect(page.getByText("Updates were rejected")).toHaveCount(0);
  const commandToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await commandToggle.click();
  const commandPreview = dialog.getByTestId("git-command-preview");
  await expect(commandPreview).toContainText("git pull --no-rebase");
  await expect(commandPreview.locator("code")).toHaveCount(1);
  await expect(
    dialog.getByRole("button", { name: "Pull, merge & push", exact: true }),
  ).toHaveCount(0);
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.waitForTimeout(220);

  await page.screenshot({
    path: "test-results/git-actions-push-recovery.png",
    fullPage: true,
  });

  const forceAction = dialog.getByRole("button", {
    name: "Force push to override remote",
  });
  await forceAction.click();
  await expect(forceAction.locator("svg")).toHaveCount(2);
  await expect(commandPreview).toContainText("git fetch overleaf");
  await expect(commandPreview).toContainText("git push --force-with-lease");
  let commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_force_push"),
  ).toBe(false);

  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_force_push"),
  ).toBe(true);
});

test("push recovery can pull into the normal merge conflict workflow", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&push=rejected", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "Push" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Push rejected due to conflicts",
  });
  await expect(dialog.getByText("main.tex", { exact: true })).toBeVisible();
  await dialog
    .getByRole("button", { name: "Pull and merge", exact: true })
    .click();
  let commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(commands.some((entry) => entry.command === "git_panel_pull")).toBe(
    false,
  );
  await dialog.getByRole("button", { name: "Continue" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Abort merge" })).toBeVisible();
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(commands.some((entry) => entry.command === "git_panel_pull")).toBe(
    true,
  );
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);

  await page.evaluate(() => window.__resolveGitConflictForHarness?.());
  await page.getByRole("button", { name: "Finish merge", exact: true }).click();
  const finish = page.getByRole("dialog", {
    name: "Finish merge",
    exact: true,
  });
  await expect(finish.getByTestId("git-commit-submit")).toHaveText(
    "Create merge commit",
  );
  await finish
    .getByRole("button", { name: "Finish merge & push", exact: true })
    .click();
  await finish.getByTestId("git-commit-submit").click();
  await expect(finish).toHaveCount(0);
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands
      .filter((entry) =>
        [
          "git_panel_push",
          "git_panel_pull",
          "git_panel_commit_selected",
        ].includes(entry.command),
      )
      .map((entry) => entry.command),
  ).toEqual([
    "git_panel_push",
    "git_panel_pull",
    "git_panel_commit_selected",
    "git_panel_push",
  ]);
});

test("clean push recovery pulls, merges, and pushes once", async ({ page }) => {
  await page.goto("/?debug=git-actions&push=rejected&pull=clean");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  await expect(dialog).toContainText(
    "Pull, merge & push should complete automatically.",
  );
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "test-results/git-pull-merge-push-clean.png" });
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Pull complete. Push complete", { exact: true }),
  ).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands
      .filter((entry) =>
        ["git_panel_push", "git_panel_pull"].includes(entry.command),
      )
      .map((entry) => entry.command),
  ).toEqual(["git_panel_push", "git_panel_pull", "git_panel_push"]);
});

test("a failed recovery pull never retries the push", async ({ page }) => {
  await page.goto("/?debug=git-actions&push=rejected&pull=failed");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText("Pull connection failed", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);
});

test("an unavailable conflict preview offers only pull and merge", async ({
  page,
}) => {
  await page.goto(
    "/?debug=git-actions&push=rejected&pull=clean&preview=failed",
  );
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  await expect(dialog).toContainText("The conflict preview is unavailable.");
  await expect(
    dialog.getByRole("button", { name: "Pull, merge & push", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Pull and merge", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);
});

test("a clean preview never pushes if the actual pull discovers conflicts", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&push=rejected&preview=clean");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  await expect(
    dialog.getByRole("button", { name: "Pull, merge & push", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("button", { name: "Abort merge", exact: true }),
  ).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);
});

test("a clean preview still allows pulling without pushing", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&push=rejected&pull=clean");
  await page.getByRole("button", { name: "Push", exact: true }).click();
  const dialog = page.getByTestId("push-recovery-dialog");
  await expect(
    dialog.getByRole("button", { name: "Pull, merge & push", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Pull and merge", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Show git command", exact: true })
    .click();
  await expect(
    dialog.getByTestId("git-command-preview").locator("code"),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Pull complete", { exact: true })).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);
});

for (const retry of ["failed", "rejected"]) {
  test(`a ${retry} push after a clean merge preserves the completed pull`, async ({
    page,
  }) => {
    await page.goto(
      `/?debug=git-actions&push=rejected&pull=clean&retry=${retry}`,
    );
    await page.getByRole("button", { name: "Push", exact: true }).click();
    const dialog = page.getByTestId("push-recovery-dialog");
    await dialog.getByRole("button", { name: "Continue" }).click();
    if (retry === "failed") {
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByText(/Pull and merge completed, but push failed/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Push", exact: true }),
      ).toBeEnabled();
    } else {
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Continue" }),
      ).toBeEnabled();
    }
    const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
    expect(
      commands.filter((entry) => entry.command === "git_panel_push"),
    ).toHaveLength(2);
    expect(
      commands.filter((entry) => entry.command === "git_panel_pull"),
    ).toHaveLength(1);
  });
}

test("a resolved merge can still finish locally without pushing", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved");
  await page.getByRole("button", { name: "Finish merge", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Finish merge",
    exact: true,
  });
  await expect(dialog.getByTestId("git-commit-submit")).toHaveText(
    "Create merge commit",
  );
  await dialog.getByTestId("git-commit-submit").click();
  await expect(dialog).toHaveCount(0);
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_commit_selected"),
  ).toHaveLength(1);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(0);
});

test("a failed merge commit never pushes and keeps the finish dialog", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved&commit=failed");
  await page.getByRole("button", { name: "Finish merge", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Finish merge",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Finish merge & push", exact: true })
    .click();
  await dialog.getByTestId("git-commit-submit").click();
  await expect(
    page.getByText("Commit hook failed", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(0);
});

test("a failed push after finishing a merge closes only the completed commit step", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved&retry=failed");
  await page.getByRole("button", { name: "Finish merge", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Finish merge",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Finish merge & push", exact: true })
    .click();
  await dialog.getByTestId("git-commit-submit").click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText(/Commit completed, but push failed/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Push", exact: true }),
  ).toBeEnabled();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.filter((entry) => entry.command === "git_panel_commit_selected"),
  ).toHaveLength(1);
  expect(
    commands.filter((entry) => entry.command === "git_panel_push"),
  ).toHaveLength(1);
});

test("rebase opens a selectable commit graph and runs only after Continue", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto("/?debug=git-actions&rebase=ready", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "More git actions" }).click();
  const rebaseMenuItem = page.getByRole("menuitem", { name: "Rebase" });
  await expect(rebaseMenuItem).toBeEnabled();
  await rebaseMenuItem.click();

  const dialog = page.getByRole("dialog", { name: "Rebase branch" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("rebase-commit-graph")).toBeVisible();
  await expect(dialog.getByText("3 commits", { exact: true })).toBeVisible();
  await expect(dialog.getByText("main", { exact: true })).toBeVisible();
  await expect(dialog.getByTestId("rebase-commit-time-bbbbbbb")).toBeVisible();
  const currentHead = dialog.getByRole("button", {
    name: "Select ccccccc: Local draft updates",
  });
  await expect(currentHead).toBeDisabled();
  const target = dialog.getByRole("button", {
    name: "Select bbbbbbb: Overleaf updates",
  });
  await target.click();
  await expect(target).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByText("Overleaf updates", { exact: true }),
  ).toBeVisible();
  const selectedTargetAuthor = dialog.getByTestId("selected-rebase-author");
  // Leave the graph tooltip before the animated dialog moves another node
  // underneath it. A user can likewise move away before choosing another node.
  await page.mouse.move(0, 0);
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const badgedAuthorBox = await selectedTargetAuthor.boundingBox();
  await dialog
    .getByRole("button", { name: "Select aaaaaaa: Shared base" })
    .click();
  await dialog.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations()
        .map((animation) => animation.finished.catch(() => {})),
    );
  });
  const unbadgedAuthorBox = await selectedTargetAuthor.boundingBox();
  expect(unbadgedAuthorBox?.y).toBe(badgedAuthorBox?.y);
  await target.click();
  const rebaseCommandToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await rebaseCommandToggle.click();
  await expect(dialog.getByTestId("git-command-preview")).toContainText(
    "git rebase bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  await expect(
    dialog.getByRole("button", { name: "Rebase", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    dialog.getByRole("button", { name: "Rebase and push" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Rebase and force push/ }),
  ).toBeVisible();
  await expect(dialog.getByTestId("git-command-preview")).not.toContainText(
    "git push",
  );

  let commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_rebase_onto"),
  ).toBe(false);
  await page.screenshot({
    path: "test-results/git-actions-rebase-graph.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(commands).toContainEqual({
    command: "git_panel_rebase_onto",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      targetCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });

  const updateRemote = page.getByRole("button", { name: "Update remote" });
  await expect(updateRemote).toBeVisible();
  await updateRemote.click();
  const remoteDialog = page.getByRole("dialog", {
    name: "Update remote after rebase",
  });
  await expect(remoteDialog).toBeVisible();
  await expect(
    remoteDialog.getByText("origin/dev", { exact: true }).first(),
  ).toBeVisible();
  await expect(remoteDialog.getByText("dev · 2 ahead")).toBeVisible();
  await expect(remoteDialog.getByText("origin/dev · 1 replaced")).toBeVisible();
  await expect(
    remoteDialog.getByRole("button", { name: "Force push with lease" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    remoteDialog.getByRole("button", { name: "Show git command" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(remoteDialog.getByTestId("git-command-preview")).toContainText(
    "git push --force-with-lease",
  );
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_force_push"),
  ).toBe(false);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/git-actions-update-remote.png",
    fullPage: true,
  });
  await remoteDialog.getByRole("button", { name: "Continue" }).click();
  await expect(remoteDialog).toHaveCount(0);
  commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_force_push"),
  ).toBe(true);
});

test("rebase and push uses a normal push in one flow", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 720 });
  await page.goto("/?debug=git-actions&rebase=ready", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Rebase" }).click();

  const dialog = page.getByRole("dialog", { name: "Rebase branch" });
  await dialog
    .getByRole("button", { name: "Select aaaaaaa: Shared base" })
    .click();
  const rebaseAndPush = dialog.getByRole("button", {
    name: "Rebase and push (Recommended)",
  });
  await rebaseAndPush.click();
  await expect(rebaseAndPush).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Show git command" }).click();
  const commandPreview = dialog.getByTestId("git-command-preview");
  await expect(commandPreview).toContainText(
    "git rebase aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  await expect(commandPreview).toContainText("git push");
  await expect(commandPreview).not.toContainText("--force-with-lease");
  await expect(commandPreview).not.toContainText("git fetch");

  await page.screenshot({
    path: "test-results/git-actions-rebase-and-push.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Update remote" })).toHaveCount(
    0,
  );

  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  const completedCommands = commands
    .map((entry) => entry.command)
    .filter((command) =>
      ["git_panel_rebase_onto", "git_panel_push"].includes(command),
    );
  expect(completedCommands).toEqual([
    "git_panel_rebase_onto",
    "git_panel_push",
  ]);
});

test("rebase recommends a red force push only when normal push will fail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 760 });
  await page.goto("/?debug=git-actions&rebase=ready", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Rebase" }).click();
  const dialog = page.getByRole("dialog", { name: "Rebase branch" });
  await dialog
    .getByRole("button", { name: "Select bbbbbbb: Overleaf updates" })
    .click();

  await expect(
    dialog.getByRole("button", { name: "Rebase and push", exact: true }),
  ).toBeVisible();
  const forcePush = dialog.getByRole("button", {
    name: "Rebase and force push (Recommended)",
  });
  await expect(forcePush).toHaveClass(/text-red-600/);
  await forcePush.click();
  await expect(forcePush).toHaveAttribute("aria-pressed", "true");

  await dialog.getByRole("button", { name: "Show git command" }).click();
  const commandPreview = dialog.getByTestId("git-command-preview");
  await expect(commandPreview).toContainText("git fetch origin");
  await expect(commandPreview).toContainText("git push --force-with-lease");
  await page.screenshot({
    path: "test-results/git-actions-rebase-push-recommendation.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  const completedCommands = commands
    .map((entry) => entry.command)
    .filter((command) =>
      ["git_panel_rebase_onto", "git_panel_force_push"].includes(command),
    );
  expect(completedCommands).toEqual([
    "git_panel_rebase_onto",
    "git_panel_force_push",
  ]);
});

test("a conflicted rebase surfaces Abort then Continue rebase", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&rebase=conflict", {
    waitUntil: "domcontentloaded",
  });

  const rebaseActions = page.locator('[data-rebase-actions="true"]');
  await expect(rebaseActions).toHaveClass(/bg-red-100/);
  await expect(
    page.getByRole("button", { name: "Abort rebase" }),
  ).toBeVisible();

  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      __resolveGitConflictForHarness?: () => void;
    };
    harnessWindow.__resolveGitConflictForHarness?.();
  });

  const continueRebase = page.getByRole("button", { name: "Continue rebase" });
  await expect(continueRebase).toBeVisible();
  await expect(rebaseActions).toHaveClass(/bg-indigo-600/);
  await page.getByRole("button", { name: "More git actions" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByText("Git rebase actions", { exact: true }),
  ).toBeVisible();
  await expect(menu.getByTestId("continue-rebase-action")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    menu.getByRole("menuitem", { name: "Abort rebase" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await continueRebase.click();
  await expect(
    page.getByRole("button", { name: "Update remote" }),
  ).toBeVisible();
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(
    commands.some((entry) => entry.command === "git_panel_continue_rebase"),
  ).toBe(true);
});

test("an unresolved merge surfaces Abort merge and mutes Finish merge", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=merge", {
    waitUntil: "domcontentloaded",
  });

  const mergeActions = page.locator('[data-merge-actions="true"]');
  await expect(mergeActions).toBeVisible();
  await expect(mergeActions).toHaveClass(/bg-\[#ef4444\]/);
  const mergeActionStyle = await mergeActions.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      borderTopWidth: style.borderTopWidth,
    };
  });
  expect(mergeActionStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(mergeActionStyle.backgroundColor).not.toContain("/");
  expect(mergeActionStyle.backgroundImage).toBe("none");
  expect(mergeActionStyle.borderTopWidth).toBe("0px");
  await expect(page.getByRole("button", { name: "Abort merge" })).toBeVisible();

  await page.getByRole("button", { name: "More git actions" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByText("Git merge actions", { exact: true }),
  ).toBeVisible();
  const finishMerge = menu.getByTestId("finish-merge-action");
  await expect(finishMerge).toHaveAttribute("aria-disabled", "true");
  await expect(
    menu.getByRole("menuitem", { name: "Abort merge" }),
  ).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Push" })).toHaveCount(0);
  await expect(menu.getByRole("menuitem", { name: "Pull" })).toHaveCount(0);

  await page.screenshot({
    path: "test-results/git-actions-conflict.png",
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Abort merge" }).click();
  await expect(page.getByRole("button", { name: "Commit" })).toBeVisible();
});

test("a resolved merge surfaces Finish merge and opens merge commit", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved", {
    waitUntil: "domcontentloaded",
  });

  const mergeActions = page.locator('[data-merge-actions="true"]');
  await expect(mergeActions).toBeVisible();
  await expect(mergeActions).toHaveClass(/bg-indigo-600/);
  const quickAction = page.getByRole("button", { name: "Finish merge" });
  await expect(quickAction).toBeVisible();

  await page.getByRole("button", { name: "More git actions" }).click();
  const menu = page.getByRole("menu");
  await expect(
    menu.getByText("Git merge actions", { exact: true }),
  ).toBeVisible();
  await expect(menu.getByTestId("finish-merge-action")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    menu.getByRole("menuitem", { name: "Abort merge" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await quickAction.click();
  const dialog = page.getByRole("dialog", { name: "Finish merge" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("git-conflict-guidance")).toHaveCount(0);
  await expect(dialog.getByText("1 file included")).toBeVisible();
  await expect(
    dialog.locator('[data-merge-touched-file="neurips_2026.tex"]'),
  ).toBeVisible();
  await expect(
    dialog.locator('[data-merge-required-indicator="true"]'),
  ).toHaveText("-");
  await expect(dialog.getByRole("button", { name: "Select All" })).toHaveCount(
    0,
  );
  await expect(
    dialog.getByRole("button", { name: "neurips_2026.tex" }),
  ).toHaveCount(0);
  await expect(dialog.getByText("selected", { exact: false })).toHaveCount(0);
  await expect(dialog.getByTestId("git-commit-submit")).toBeVisible();

  await page.screenshot({
    path: "test-results/git-actions-merge-resolved.png",
    fullPage: true,
  });
});

test("a zero-diff Current resolution can still finish the merge", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved-current", {
    waitUntil: "domcontentloaded",
  });

  const quickAction = page.getByRole("button", { name: "Finish merge" });
  await expect(quickAction).toBeVisible();
  await expect(quickAction).toBeEnabled();
  await quickAction.click();

  const dialog = page.getByRole("dialog", { name: "Finish merge" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("git-conflict-guidance")).toHaveCount(0);
  await expect(dialog.getByText("1 file included")).toBeVisible();
  await expect(
    dialog.locator('[data-merge-touched-file="neurips_2026.tex"]'),
  ).toBeVisible();
  await expect(
    dialog.locator('[data-merge-required-indicator="true"]'),
  ).toHaveText("-");
  await expect(dialog.getByRole("button", { name: "Select All" })).toHaveCount(
    0,
  );
  await expect(dialog.getByText("selected", { exact: false })).toHaveCount(0);
  await expect(
    dialog.getByText("neurips_2026.tex", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByText("staged", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("unstaged", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("untracked", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("conflict", { exact: true })).toHaveCount(0);
  await expect(dialog.getByTestId("git-commit-submit")).toBeEnabled();
  await page.screenshot({
    path: "test-results/git-actions-zero-diff-merge.png",
    fullPage: true,
  });
  const createMergeCommit = dialog.getByTestId("git-commit-submit");
  await createMergeCommit.click();
  await expect(dialog).toHaveCount(0);
  const commands = await page.evaluate(() => window.__gitSetupCommands ?? []);
  expect(commands).toContainEqual({
    command: "git_panel_commit_selected",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      message: "Complete merge",
      selectedFiles: ["neurips_2026.tex"],
    },
  });
  await expect(page.locator('[data-merge-actions="true"]')).toHaveCount(0);
});

test("the quick action updates as soon as the final conflict is resolved", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=merge", {
    waitUntil: "domcontentloaded",
  });

  await expect(page.getByRole("button", { name: "Abort merge" })).toBeVisible();
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      __resolveGitConflictForHarness?: () => void;
    };
    harnessWindow.__resolveGitConflictForHarness?.();
  });

  await expect(
    page.getByRole("button", { name: "Finish merge" }),
  ).toBeVisible();
  await expect(page.locator('[data-merge-actions="true"]')).toHaveClass(
    /bg-indigo-600/,
  );
});

test("reopening a resolved conflict restores the Abort merge action", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&conflict=resolved", {
    waitUntil: "domcontentloaded",
  });

  await expect(
    page.getByRole("button", { name: "Finish merge" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const harnessWindow = window as Window & {
      __reopenGitConflictForHarness?: () => void;
    };
    harnessWindow.__reopenGitConflictForHarness?.();
  });

  await expect(page.getByRole("button", { name: "Abort merge" })).toBeVisible();
  await expect(page.locator('[data-merge-actions="true"]')).toHaveClass(
    /bg-\[#ef4444\]/,
  );
});

test("stash manager keeps the footer inside the dialog surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 618, height: 651 });
  await page.goto("/?debug=git-actions", {
    waitUntil: "domcontentloaded",
  });

  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Stash" }).click();
  await expect(page.getByRole("menu")).toBeHidden();

  const dialog = page.getByRole("dialog", { name: "Stash manager" });
  const continueButton = dialog.getByRole("button", { name: "Continue" });
  await expect(dialog).toBeVisible();
  await expect(continueButton).toBeVisible();
  await page.waitForTimeout(250);

  const bounds = await dialog.evaluate((dialogElement) => {
    const footerElement = dialogElement.querySelector<HTMLElement>(
      '[data-slot="dialog-footer"]',
    );
    if (!footerElement) {
      throw new Error("Dialog footer was not rendered");
    }
    const dialogRect = dialogElement.getBoundingClientRect();
    const footerRect = footerElement.getBoundingClientRect();
    return {
      dialogBottom: dialogRect.bottom,
      footerBottom: footerRect.bottom,
    };
  });
  expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.dialogBottom);

  await page.screenshot({
    path: "test-results/git-actions-stash-manager.png",
    fullPage: true,
  });
});

test("a project without Git can configure gitignore and a remote inline", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions&repo=none", {
    waitUntil: "domcontentloaded",
  });

  const setupButton = page.getByRole("button", { name: "Set up Git" });
  await expect(setupButton).toBeVisible();
  await setupButton.click();

  const dialog = page.getByRole("dialog", { name: "Set up Git" });
  await expect(dialog).toBeVisible();
  const gitignoreCheckbox = dialog.getByRole("checkbox", {
    name: "Create .gitignore",
  });
  await expect(gitignoreCheckbox).toBeChecked();
  const gitignoreContent = dialog.getByLabel(".gitignore content");
  await expect(gitignoreContent).toBeVisible();
  await expect(gitignoreContent).toHaveValue(
    /^# Editor and OS files[\s\S]*# LaTeX build files/,
  );
  await expect(gitignoreContent).not.toHaveAttribute("placeholder");
  await expect(
    dialog.getByRole("button", { name: "Add remote" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: "Create a new repository on GitHub",
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Initialize" }),
  ).toBeEnabled();
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/git-actions-setup-options.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Add remote" }).click();
  const remoteEditor = dialog.getByTestId("git-remote-new-row");
  await expect(remoteEditor).toBeVisible();
  await expect(remoteEditor.getByLabel("Name:")).toHaveValue("origin");
  await expect(remoteEditor.getByLabel("Local branch")).toHaveValue("main");
  await expect(remoteEditor.getByLabel("Local branch")).toBeDisabled();
  await remoteEditor
    .getByLabel("URL:")
    .fill("https://github.com/example/paper.git");
  await remoteEditor.getByLabel("URL:").press("Enter");
  await expect(
    remoteEditor.getByRole("status", { name: "Remote verified" }),
  ).toBeVisible();
  await expect(remoteEditor.getByLabel("Remote branch")).toContainText("main");
  await page.screenshot({
    path: "test-results/git-actions-connect-remote.png",
    fullPage: true,
  });
  await remoteEditor.getByRole("button", { name: "Add remote" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __gitSetupCommands?: Array<{ command: string }>;
            }
          ).__gitSetupCommands?.filter(
            (entry) => entry.command === "git_project_connect_remote",
          ).length ?? 0,
      ),
    )
    .toBe(0);
  await expect(remoteEditor).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Add remote" }),
  ).toBeVisible();

  await dialog.getByRole("button", { name: "Initialize" }).click();
  await expect(dialog).toBeHidden();
  await expect(setupButton).toBeHidden();
  await expect(page.getByRole("button", { name: "Commit" })).toBeVisible();

  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(commands).toContainEqual({
    command: "git_project_connect_remote",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      remoteUrl: "https://github.com/example/paper.git",
      remoteName: "origin",
      upstreamBranch: "main",
    },
  });
  expect(
    commands.findIndex(
      (entry) => entry.command === "git_project_complete_setup",
    ),
  ).toBeLessThan(
    commands.findIndex(
      (entry) => entry.command === "git_project_connect_remote",
    ),
  );
  expect(commands).toContainEqual({
    command: "git_project_complete_setup",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      gitignoreContent: expect.stringContaining("# LaTeX build files"),
    },
  });

  await page.screenshot({
    path: "test-results/git-actions-setup.png",
    fullPage: true,
  });
});

test("setup without a remote only initializes Git", async ({ page }) => {
  await page.goto("/?debug=git-actions&repo=none", {
    waitUntil: "domcontentloaded",
  });

  const setupButton = page.getByRole("button", { name: "Set up Git" });
  await setupButton.click();
  const dialog = page.getByRole("dialog", { name: "Set up Git" });
  const commandToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
  await commandToggle.click();
  await expect(dialog.getByTestId("git-command-preview")).toContainText(
    "git init -b main",
  );
  await dialog.getByRole("button", { name: "Initialize" }).click();
  await expect(dialog).toBeHidden();

  const commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{ command: string }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(
    commands.filter((entry) => entry.command === "git_project_complete_setup"),
  ).toHaveLength(1);
  expect(
    commands.filter((entry) => entry.command === "git_project_connect_remote"),
  ).toHaveLength(0);
});

test("a configured repository can manage multiple Git remotes", async ({
  page,
}) => {
  await page.goto("/?debug=git-actions", {
    waitUntil: "domcontentloaded",
  });

  const commitButton = page.getByRole("button", {
    name: "Commit",
    exact: true,
  });
  await expect(commitButton).toBeEnabled();
  await commitButton.click();
  const commitDialog = page.getByRole("dialog", {
    name: "Commit your changes",
  });
  await expect(commitDialog).toBeVisible();
  await page.waitForTimeout(250);
  const commitTitleBox = await commitDialog
    .getByRole("heading", { name: "Commit your changes" })
    .boundingBox();
  const modifiedFilesHeadingBox = await commitDialog
    .getByText("Modified files")
    .boundingBox();
  expect(commitTitleBox).not.toBeNull();
  expect(modifiedFilesHeadingBox).not.toBeNull();
  const commitTitleToPanelGap =
    (modifiedFilesHeadingBox?.y ?? 0) -
    ((commitTitleBox?.y ?? 0) + (commitTitleBox?.height ?? 0));
  await commitDialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "More git actions" }).click();
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "test-results/git-actions-git-remote-menu.png",
    fullPage: true,
  });
  await page.getByRole("menuitem", { name: "Git Remote" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Git remote configuration",
  });
  await expect(dialog.getByText("Configured Remote")).toBeVisible();
  await page.waitForTimeout(250);
  const dialogTitleBox = await dialog
    .getByRole("heading", { name: "Git remote configuration" })
    .boundingBox();
  const configuredHeadingBox = await dialog
    .getByText("Configured Remote")
    .boundingBox();
  expect(dialogTitleBox).not.toBeNull();
  expect(configuredHeadingBox).not.toBeNull();
  expect(
    Math.abs(
      (configuredHeadingBox?.y ?? 0) -
        ((dialogTitleBox?.y ?? 0) + (dialogTitleBox?.height ?? 0)) -
        commitTitleToPanelGap,
    ),
  ).toBeLessThanOrEqual(1);
  await expect(dialog.getByText("Modified Remote")).toHaveCount(0);
  const originRow = dialog.getByTestId("git-remote-row-origin");
  await expect(originRow).toContainText("origin");
  await expect(originRow).toContainText(
    "git@github.com:example/current-paper.git",
  );
  await expect(originRow).toContainText("dev");
  await expect(originRow).toContainText("master");
  const originReadActions = originRow.getByRole("group", {
    name: "Remote origin actions",
  });
  await expect(originReadActions.getByRole("button")).toHaveCount(2);
  await expect(
    originRow.getByRole("button", { name: "Select remote origin" }),
  ).toHaveCount(0);
  const overleafRow = dialog.getByTestId("git-remote-row-overleaf");
  await expect(overleafRow).toContainText("overleaf");
  await expect(overleafRow).toContainText("git.overleaf.com");
  await expect(
    dialog.getByRole("button", { name: "New remote" }),
  ).toBeVisible();
  await expect(dialog.getByText("Action", { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Apply Selected (0)" }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Discard Selected (0)" }),
  ).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Select All" })).toHaveCount(
    0,
  );
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/git-actions-remote-list.png",
    fullPage: true,
  });

  await dialog.getByRole("button", { name: "Edit remote origin" }).click();
  await expect(dialog.getByTestId("git-remote-editor-origin")).toBeVisible();
  const originEditActions = originRow.getByRole("group", {
    name: "Edit remote origin actions",
  });
  await expect(
    originRow.getByRole("button", { name: "Select remote origin" }),
  ).toHaveCount(0);
  await expect(originEditActions.getByRole("button")).toHaveCount(2);
  await expect(
    originEditActions.getByRole("button", { name: "Save changes" }),
  ).toBeVisible();
  await expect(
    originEditActions.getByRole("button", { name: "Cancel" }),
  ).toBeVisible();
  const remoteName = dialog.getByLabel("Name:");
  const remoteUrl = dialog.getByLabel("URL:");
  await expect(remoteName).toHaveValue("origin");
  await expect(remoteUrl).toHaveValue(
    "git@github.com:example/current-paper.git",
  );
  await expect(dialog.getByLabel("Verifying remote")).toBeVisible();
  await page.screenshot({
    path: "test-results/git-actions-edit-remote-verifying.png",
    fullPage: true,
  });
  await expect(dialog.getByLabel("Remote verified")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Local branch" }),
  ).toHaveText(/dev/);
  await expect(
    dialog.getByRole("combobox", { name: "Remote branch" }),
  ).toHaveText(/master/);

  const githubLink = dialog.getByRole("button", {
    name: "Create a new repository on GitHub",
  });
  await expect(githubLink).toBeVisible();
  await githubLink.click();

  await remoteUrl.fill("https://github.com/example/unreachable.git");
  await remoteUrl.blur();
  await expect(dialog.getByLabel("Verifying remote")).toBeVisible();
  await expect(dialog.getByLabel("Remote verification failed")).toBeVisible();
  await expect(
    dialog.getByText("The Git remote could not be reached"),
  ).toBeVisible();

  await remoteUrl.fill("https://github.com/example/replacement-paper.git");
  await remoteUrl.blur();
  await expect(dialog.getByLabel("Verifying remote")).toBeVisible();
  await expect(dialog.getByLabel("Remote verified")).toBeVisible();
  const remoteBranch = dialog.getByRole("combobox", {
    name: "Remote branch",
  });
  await expect(remoteBranch).toHaveText(/main/);
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/git-actions-edit-remote.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog.getByTestId("git-remote-row-origin")).toContainText(
    "replacement-paper.git",
  );
  await expect(dialog.getByTestId("git-remote-row-origin")).toHaveAttribute(
    "data-pending-change",
    "true",
  );
  await expect(dialog.getByText("Modified Remote")).toBeVisible();
  await expect(dialog.getByText("1/1 selected")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Select remote origin" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Select All" }).click();
  await expect(dialog.getByText("0/1 selected")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Apply Selected (0)" }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "Select All" }).click();
  await expect(dialog.getByText("1/1 selected")).toBeVisible();

  let commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(
    commands.some((entry) => entry.command === "git_project_save_remote"),
  ).toBe(false);

  await dialog.getByRole("button", { name: "New remote" }).click();
  await expect(dialog.getByLabel("Name:")).toHaveValue("");
  await expect(dialog.getByLabel("URL:")).toHaveValue("");
  await dialog.getByLabel("Name:").fill("backup");
  await dialog
    .getByLabel("URL:")
    .fill("https://github.com/example/backup-paper.git");
  await dialog.getByLabel("URL:").blur();
  await expect(dialog.getByLabel("Remote verified")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Remote branch" }),
  ).toHaveText(/main/);
  await page.screenshot({
    path: "test-results/git-actions-new-remote.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Add remote" }).click();
  await expect(dialog.getByTestId("git-remote-row-backup")).toContainText(
    "backup-paper.git",
  );
  await expect(dialog.getByTestId("git-remote-row-backup")).toHaveAttribute(
    "data-pending-change",
    "true",
  );
  await expect(
    dialog
      .getByTestId("git-remote-row-backup")
      .getByText("backup", { exact: true }),
  ).toHaveClass(/text-orange-400/);

  await dialog.getByRole("button", { name: "Delete remote overleaf" }).click();
  const deletedOverleafRow = dialog.getByTestId("git-remote-row-overleaf");
  await expect(deletedOverleafRow).toHaveAttribute(
    "data-pending-delete",
    "true",
  );
  await expect(deletedOverleafRow.locator(".line-through")).toBeVisible();
  await expect(dialog.getByText("3/3 selected")).toBeVisible();
  await dialog
    .getByRole("button", { name: "Undo delete remote overleaf" })
    .click();
  await expect(deletedOverleafRow).not.toHaveAttribute(
    "data-pending-delete",
    "true",
  );
  await expect(deletedOverleafRow.locator(".line-through")).toHaveCount(0);
  await expect(dialog.getByText("2/2 selected")).toBeVisible();
  await dialog.getByRole("button", { name: "Delete remote overleaf" }).click();
  await expect(dialog.getByText("Configured Remote")).toHaveCount(0);
  const commandToggle = dialog.getByRole("button", {
    name: "Show git command",
  });
  await commandToggle.click();
  const commandPreview = dialog.getByTestId("git-command-preview");
  await expect(commandPreview).toContainText(
    "git remote set-url origin https://github.com/example/replacement-paper.git",
  );
  await expect(commandPreview).toContainText(
    "git remote add backup https://github.com/example/backup-paper.git",
  );
  await expect(commandPreview).toContainText("git remote remove overleaf");
  const remoteCommandLayout = await commandPreview.evaluate((preview) => ({
    clientWidth: preview.clientWidth,
    scrollWidth: preview.scrollWidth,
    wrappedRowCount: Array.from(preview.querySelectorAll("code")).filter(
      (row) => row.getBoundingClientRect().height > 20,
    ).length,
  }));
  expect(remoteCommandLayout.scrollWidth).toBeLessThanOrEqual(
    remoteCommandLayout.clientWidth + 1,
  );
  expect(remoteCommandLayout.wrappedRowCount).toBeGreaterThan(0);
  await page.screenshot({
    path: "test-results/git-actions-pending-remotes.png",
    fullPage: true,
  });

  commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(
    commands.some((entry) =>
      ["git_project_save_remote", "git_project_delete_remote"].includes(
        entry.command,
      ),
    ),
  ).toBe(false);

  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toBeHidden();

  commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(commands).toContainEqual({
    command: "git_project_save_remote",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      originalRemoteName: "origin",
      remoteUrl: "https://github.com/example/replacement-paper.git",
      remoteName: "origin",
      localBranch: "dev",
      upstreamBranch: "main",
    },
  });
  expect(commands).toContainEqual({
    command: "git_project_delete_remote",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      remoteName: "overleaf",
    },
  });
  expect(commands).toContainEqual({
    command: "git_project_save_remote",
    args: {
      projectRoot: "/tmp/catalex-git-actions-harness",
      originalRemoteName: null,
      remoteUrl: "https://github.com/example/backup-paper.git",
      remoteName: "backup",
      localBranch: "dev",
      upstreamBranch: "main",
    },
  });
  expect(commands.some((entry) => entry.command === "plugin:shell|open")).toBe(
    true,
  );

  const appliedCommandCount = commands.filter(
    (entry) => entry.command === "git_project_save_remote",
  ).length;
  const appliedDeleteCommandCount = commands.filter(
    (entry) => entry.command === "git_project_delete_remote",
  ).length;
  await page.getByRole("button", { name: "More git actions" }).click();
  await page.getByRole("menuitem", { name: "Git Remote" }).click();
  const reopenedDialog = page.getByRole("dialog", {
    name: "Git remote configuration",
  });
  await expect(reopenedDialog.getByText("Modified Remote")).toHaveCount(0);
  await expect(
    reopenedDialog.getByRole("button", { name: "Apply Selected (0)" }),
  ).toBeDisabled();
  await reopenedDialog
    .getByRole("button", { name: "Edit remote backup" })
    .click();
  await expect(reopenedDialog.getByLabel("Remote verified")).toBeVisible();
  await reopenedDialog
    .getByLabel("URL:")
    .fill("https://git.example.com/discarded.git");
  await reopenedDialog.getByLabel("URL:").blur();
  await expect(reopenedDialog.getByLabel("Remote verified")).toBeVisible();
  await reopenedDialog.getByRole("button", { name: "Save changes" }).click();
  await reopenedDialog
    .getByRole("button", { name: "Discard Selected (1)" })
    .click();
  await reopenedDialog.getByRole("button", { name: "Continue" }).click();
  await expect(reopenedDialog).toBeHidden();

  commands = await page.evaluate(
    () =>
      (
        window as Window & {
          __gitSetupCommands?: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__gitSetupCommands ?? [],
  );
  expect(
    commands.filter((entry) => entry.command === "git_project_save_remote"),
  ).toHaveLength(appliedCommandCount);
  expect(
    commands.filter((entry) => entry.command === "git_project_delete_remote"),
  ).toHaveLength(appliedDeleteCommandCount);
});
