import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

declare global {
  interface Window {
    reviewNavigation: {
      files: string[];
      started: boolean;
      release: () => void;
    };
  }
}

async function holdDecision(
  page: Page,
  fail = false,
  commandToHold = "apply_agent_workspace",
) {
  await page.evaluate(
    async ({ fail, commandToHold }) => {
      const storePath = "/src/renderer/stores/document-store.ts";
      const bridgePath = "/src/renderer/lib/desktop/bridge.ts";
      const { useDocumentStore } = await import(storePath);
      const { browserHarness } = await import(bridgePath);
      const bridge = browserHarness();
      const original = bridge.invoke;
      const observed = {
        files: [] as string[],
        started: false,
        release: () => {},
      };
      window.reviewNavigation = observed;
      let failNext = fail;
      useDocumentStore.subscribe(
        (
          state: { activeFileId: string },
          previous: { activeFileId: string },
        ) => {
          if (state.activeFileId !== previous.activeFileId)
            observed.files.push(state.activeFileId);
        },
      );
      bridge.invoke = async (
        command: string,
        raw: unknown,
        options: unknown,
      ) => {
        if (command === commandToHold) {
          await new Promise<void>((resolve) => {
            observed.started = true;
            observed.release = resolve;
          });
          if (failNext) {
            failNext = false;
            throw new Error(
              commandToHold === "apply_agent_workspace"
                ? "Acceptance write failed"
                : "Git resolution failed",
            );
          }
        }
        return original(command, raw, options);
      };
    },
    { fail, commandToHold },
  );
}
const navigations = (page: Page) =>
  page.evaluate(() => window.reviewNavigation.files);
async function waitForDecision(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.reviewNavigation.started))
    .toBe(true);
}

async function openGitRecovery(page: Page, scenario: string) {
  await page.addInitScript(() => {
    window.addEventListener(
      "app-visibility-restored",
      () => {
        document.documentElement.dataset.harnessVisibilityReady = "true";
      },
      { once: true },
    );
  });
  await page.goto(`/?debug=git-actions&recovery=${scenario}&workspace=1`, {
    waitUntil: "domcontentloaded",
  });
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

for (const kind of ["markdown", "pdf"] as const) {
  for (const accept of [true, false]) {
    test(`${kind} ${accept ? "acceptance" : "rejection"} navigates once after settlement`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      if (kind === "pdf") {
        const bytes = await readFile(
          new URL("../public/examples/blank/main.pdf", import.meta.url),
        );
        await page.route("http://127.0.0.1:4175/compile", async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          await route.fulfill({ json: { result: [...bytes] } });
        });
      }
      await page.goto(
        `/?debug=agent-file-review&${kind === "pdf" ? "compileCase" : "textReview"}`,
      );
      const panel = page.locator("[data-proposed-changes-panel]");
      await expect(panel).toBeVisible();
      await holdDecision(page);
      await panel
        .getByRole("button", {
          name: accept ? "Accept All" : "Reject All",
          exact: false,
        })
        .click();
      await waitForDecision(page);
      expect(await navigations(page)).toEqual([]);
      await page.evaluate(() => window.reviewNavigation.release());
      await expect.poll(() => navigations(page)).toEqual(["new-figure.png"]);
      await expect(page.locator("[data-agent-file-review]")).toBeVisible();
      await page.waitForTimeout(800);
      expect(await navigations(page)).toEqual(["new-figure.png"]);
      await page.screenshot({ path: test.info().outputPath("next-file.png") });
    });
  }
}

for (const action of [
  "manual selection",
  "failed transaction",
  "asset acceptance",
] as const) {
  test(`${action} preserves the selected file`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(
      `/?debug=agent-file-review${action === "asset acceptance" ? "" : "&textReview"}`,
    );
    const review = page.locator(
      action === "asset acceptance"
        ? "[data-agent-file-review]"
        : "[data-proposed-changes-panel]",
    );
    await expect(review).toBeVisible();
    await holdDecision(page, action === "failed transaction");
    await review
      .getByRole("button", {
        name: action === "asset acceptance" ? "Accept" : "Accept All",
        exact: action === "asset acceptance",
      })
      .click();
    await waitForDecision(page);
    expect(await navigations(page)).toEqual([]);
    if (action === "manual selection")
      await page.getByText("results.png", { exact: true }).first().click();
    await page.evaluate(() => window.reviewNavigation.release());
    if (action === "failed transaction") {
      await expect(
        page.locator("[data-chat-error-composer]").filter({ visible: true }),
      ).toContainText("Acceptance write failed");
      expect(await navigations(page)).toEqual([]);
    } else {
      await expect.poll(() => navigations(page)).toEqual(["results.png"]);
      await expect(
        page
          .locator("[data-agent-file-review]")
          .getByRole("region", { name: "Current file" }),
      ).toBeVisible();
      await page.waitForTimeout(800);
      expect(await navigations(page)).toEqual(["results.png"]);
    }
  });
}

test("compact review navigation stays before the file tabs across file types", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?debug=agent-file-review&textReview");
  const navigation = page.getByRole("group", {
    name: "Review files",
    exact: true,
  });
  const panel = page.locator("[data-proposed-changes-panel]");
  await expect(navigation).toContainText("3/3");
  const pendingImage = page.locator('[data-sidebar-file-id="new-figure.png"]');
  await page.mouse.move(0, 0);
  await expect(pendingImage).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(panel).not.toContainText("manuscript.md");
  await expect(panel).not.toContainText("files");
  const initialNav = (await navigation.boundingBox())!;
  await navigation
    .getByRole("button", { name: "Next review file", exact: true })
    .click();
  await expect(navigation).toContainText("1/3");
  await expect(page.locator("[data-agent-file-review]")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(pendingImage).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  expect((await navigation.boundingBox())!.x).toBe(initialNav.x);
  await navigation
    .getByRole("button", { name: "Previous review file", exact: true })
    .click();
  await expect(navigation).toContainText("3/3");
  await expect(panel).toBeVisible();
  const git = page.locator("[data-git-actions-control]");
  const tabs = page.locator("[data-editor-toolbar]");
  const navBox = (await navigation.boundingBox())!;
  const gitBox = (await git.boundingBox())!;
  const tabsBox = (await tabs.boundingBox())!;
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(tabsBox.x);
  expect(navBox.width).toBeLessThan(140);
  expect(navBox.height).toBe(32);
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(gitBox.x);
  expect(
    Math.abs(navBox.y + navBox.height / 2 - gitBox.y - gitBox.height / 2),
  ).toBeLessThan(1);
  await page.screenshot({
    path: test.info().outputPath("review-header-light.png"),
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.setViewportSize({ width: 900, height: 760 });
  await expect(navigation).toBeVisible();
  const narrowNav = (await navigation.boundingBox())!;
  const narrowGit = (await git.boundingBox())!;
  expect(narrowNav.x).toBeGreaterThanOrEqual(0);
  expect(narrowNav.x).toBe(initialNav.x);
  expect(narrowNav.x + narrowNav.width).toBeLessThanOrEqual(narrowGit.x);
  expect(narrowGit.x + narrowGit.width).toBeLessThanOrEqual(900);
  await page.screenshot({
    path: test.info().outputPath("review-header-dark-narrow.png"),
  });
});

test("review counter follows remaining files and clears when review finishes", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview");
  const navigation = page.getByRole("group", {
    name: "Review files",
    exact: true,
  });
  await expect(navigation).toContainText("3/3");
  await page
    .locator("[data-proposed-changes-panel]")
    .getByRole("button", { name: /Accept All/ })
    .click();
  await expect(navigation).toContainText("1/2");
  await page.getByText("manuscript.md", { exact: true }).first().click();
  await expect(navigation).toContainText("2 left");
  await navigation
    .getByRole("button", { name: "Next review file", exact: true })
    .click();
  await expect(navigation).toContainText("1/2");
  await page
    .locator("[data-agent-file-review]")
    .getByRole("button", { name: "Accept", exact: true })
    .click();
  await expect(navigation).toContainText("1/1");
  await expect(
    navigation.getByRole("button", { name: "Next review file", exact: true }),
  ).toBeDisabled();
  await page
    .locator("[data-agent-file-review]")
    .getByRole("button", { name: "Reject", exact: true })
    .click();
  await expect(navigation).toHaveCount(0);
});

test("Git conflict navigation uses the same header group and updates after resolution", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?debug=git-actions&recovery=mixed&workspace=1");
  const navigation = page.getByRole("group", {
    name: "Git conflict files",
    exact: true,
  });
  await expect(navigation).toContainText("3 left");
  await navigation
    .getByRole("button", { name: "Next conflicted file", exact: true })
    .click();
  await expect(navigation).toContainText("1/3");
  await expect(
    page.getByRole("region", { name: "File conflict versions", exact: true }),
  ).toBeVisible();
  await navigation
    .getByRole("button", { name: "Next conflicted file", exact: true })
    .click();
  await expect(navigation).toContainText("2/3");
  await navigation
    .getByRole("button", { name: "Previous conflicted file", exact: true })
    .click();
  await expect(navigation).toContainText("1/3");
  await page
    .getByRole("button", { name: "Accept current", exact: true })
    .click();
  await expect(navigation).toContainText("1/2");
  await page.screenshot({ path: test.info().outputPath("git-header.png") });
});

for (const manualSelection of [false, true]) {
  test(`final agent decision keeps ${manualSelection ? "a manually selected file" : "the last reviewed file"} open`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/?debug=agent-file-review&textReview");
    await page
      .locator("[data-proposed-changes-panel]")
      .getByRole("button", { name: /Accept All/ })
      .click();
    const navigation = page.getByRole("group", {
      name: "Review files",
      exact: true,
    });
    await expect(navigation).toContainText("1/2");
    await page
      .locator("[data-agent-file-review]")
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await expect(navigation).toContainText("1/1");
    await holdDecision(page);
    await page
      .locator("[data-agent-file-review]")
      .getByRole("button", { name: "Accept", exact: true })
      .click();
    await waitForDecision(page);
    if (manualSelection)
      await page.locator('[data-sidebar-file-id="manuscript.md"]').click();
    await page.evaluate(() => window.reviewNavigation.release());
    await expect(navigation).toHaveCount(0);
    const expected = manualSelection ? "manuscript.md" : "results.png";
    await expect(
      page.locator('[data-editor-file-tab][data-active="true"]'),
    ).toContainText(expected);
    await expect
      .poll(() => navigations(page))
      .toEqual(manualSelection ? [expected] : []);
  });
}

for (const kind of ["text", "image"] as const) {
  for (const action of ["advance", "manual selection", "failure"] as const) {
    test(`Git ${kind} resolution ${action} respects file navigation`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 1000 });
      if (kind === "text") await page.goto("/?debug=git-three-way");
      else {
        await openGitRecovery(page, "nontext");
        await page.locator('[data-sidebar-file-id="figure.png"]').click();
        const view = page.getByRole("region", {
          name: "File conflict versions",
          exact: true,
        });
        await expect
          .poll(() =>
            view.evaluate((el) => {
              const group = el.querySelector(":scope > [data-panel-group-id]")!;
              return (
                group
                  .querySelectorAll(":scope > [data-panel-id]")[1]
                  .getBoundingClientRect().width /
                group.getBoundingClientRect().width
              );
            }),
          )
          .toBeCloseTo(0.5, 2);
      }
      const button =
        kind === "text"
          ? page
              .locator("[data-git-conflict-panel]")
              .getByRole("button", { name: "Accept All", exact: true })
          : page
              .getByRole("region", { name: "Incoming version", exact: true })
              .getByRole("button", { name: "Accept incoming", exact: true });
      await expect(button).toBeVisible();
      await holdDecision(
        page,
        action === "failure",
        kind === "text"
          ? "git_panel_resolve_conflict"
          : "git_panel_resolve_conflict_side",
      );
      await button.click();
      await waitForDecision(page);
      expect(await navigations(page)).toEqual([]);
      const manualFile = kind === "text" ? "appendix.md" : "data.bin";
      if (action === "manual selection")
        await page.locator(`[data-sidebar-file-id="${manualFile}"]`).click();
      await page.evaluate(() => window.reviewNavigation.release());
      if (action === "failure") {
        await expect(
          page.getByText("Git resolution failed", { exact: true }).first(),
        ).toBeVisible();
        expect(await navigations(page)).toEqual([]);
        await expect(button).toBeEnabled();
        await page.waitForTimeout(300);
        await expect(button).toBeEnabled();
        await page.evaluate(() => {
          window.reviewNavigation.started = false;
        });
        await button.click();
        await waitForDecision(page);
        await page.evaluate(() => window.reviewNavigation.release());
        await expect
          .poll(() => navigations(page))
          .toEqual([kind === "text" ? "methods.md" : "data.bin"]);
      } else {
        const expected =
          action === "manual selection"
            ? manualFile
            : kind === "text"
              ? "methods.md"
              : "data.bin";
        await expect.poll(() => navigations(page)).toEqual([expected]);
        await expect(
          page.locator('[data-editor-file-tab][data-active="true"]'),
        ).toContainText(expected);
        await page.waitForTimeout(300);
        expect(await navigations(page)).toEqual([expected]);
      }
    });
  }
}

test("Git deletion resolution opens the next pending file after removing the selected file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openGitRecovery(page, "mixed");
  await page.locator('[data-sidebar-file-id="chapter.tex"]').click();
  const panel = page.locator("[data-git-conflict-panel]");
  await expect(panel).toBeVisible();
  await holdDecision(page, false, "git_panel_resolve_conflict_side");
  await panel
    .getByRole("button", { name: "Keep current (delete file)", exact: false })
    .click();
  await waitForDecision(page);
  expect(await navigations(page)).toEqual([]);
  await page.evaluate(() => window.reviewNavigation.release());
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("figure.png");
  await expect(
    page.getByRole("group", { name: "Git conflict files", exact: true }),
  ).toContainText("1/2");
  await expect(
    page.locator('[data-sidebar-file-id="chapter.tex"]'),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-workspace-layout-animating="true"]'),
  ).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("after-git-deletion.png"),
  });
});

test("agent deletion resolution opens the next pending file after removing the selected file", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?debug=agent-file-review&extras");
  await page.locator('[data-sidebar-file-id="removed.png"]').click();
  await page
    .locator("[data-agent-file-review]")
    .getByRole("button", { name: "Accept deletion", exact: true })
    .click();
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("new-figure.png");
  await expect(
    page.getByRole("group", { name: "Review files", exact: true }),
  ).toContainText("1/4");
  await expect(
    page.locator('[data-sidebar-file-id="removed.png"]'),
  ).toHaveCount(0);
});
