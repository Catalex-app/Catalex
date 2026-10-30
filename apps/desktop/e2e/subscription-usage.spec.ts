import { expect, test, type Page } from "@playwright/test";

async function requests(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { subscriptionUsageRequests: string[] })
        .subscriptionUsageRequests,
  );
}

test("queries on open and provider switch, with only reported bars", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 720, height: 720 });
  await page.goto("/?debug=claude-models");
  const open = page.getByRole("button", { name: /Opus 4.8/ });
  await expect(open).toBeVisible();
  expect(await requests(page)).toEqual([]);
  await open.click();
  const usage = page.getByRole("group", {
    name: "Subscription usage",
    exact: true,
  });
  await expect(usage.getByRole("progressbar")).toHaveCount(2);
  await expect(usage.getByText("82% left")).toBeVisible();
  await expect(usage.getByText("53% left")).toBeVisible();
  await expect(page.locator("[data-model-picker-outgoing]")).toHaveCount(0);
  const providerHeading = await page
    .getByText("Provider", { exact: true })
    .boundingBox();
  const usageHeading = await usage
    .getByText("Subscription usage", { exact: true })
    .boundingBox();
  const modelHeading = await page
    .getByText("Model", { exact: true })
    .boundingBox();
  expect(usageHeading!.x).toBe(providerHeading!.x);
  expect(usageHeading!.x).toBe(modelHeading!.x);
  await page.screenshot({ path: testInfo.outputPath("claude-usage.png") });
  await page
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  await expect(usage.getByRole("progressbar")).toHaveCount(1);
  await expect(usage.getByText("68% left")).toBeVisible();
  await expect(usage.getByText("5-hour", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("codex-usage.png") });
  expect(await requests(page)).toEqual([
    "read_claude_subscription_usage",
    "read_codex_subscription_usage",
  ]);
  await page
    .getByRole("button", { name: "Show settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Show chat", exact: true }).click();
  await page
    .getByRole("button", { name: /GPT-5.4/ })
    .first()
    .click();
  await expect(usage.getByRole("progressbar")).toHaveCount(1);
  expect(await requests(page)).toEqual([
    "read_claude_subscription_usage",
    "read_codex_subscription_usage",
    "read_codex_subscription_usage",
  ]);
});

test("refresh queries usage again and stays disabled while loading", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models&usage=slow");
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  const refresh = page.getByRole("button", {
    name: "Refresh subscription usage",
  });
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled();
  expect(await requests(page)).toEqual([
    "read_claude_subscription_usage",
    "read_claude_subscription_usage",
  ]);
});

for (const scenario of ["unavailable", "error"]) {
  test(`${scenario} does not create empty bars or block model selection`, async ({
    page,
  }) => {
    await page.goto(`/?debug=claude-models&usage=${scenario}`);
    await page.getByRole("button", { name: /Opus 4.8/ }).click();
    const usage = page.getByRole("group", {
      name: "Subscription usage",
      exact: true,
    });
    await expect(usage.getByText("Usage unavailable")).toBeVisible();
    await expect(usage.getByRole("progressbar")).toHaveCount(0);
    const refresh = page.getByRole("button", {
      name: "Refresh subscription usage",
    });
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(usage.getByText("Usage unavailable")).toBeVisible();
    expect(await requests(page)).toHaveLength(2);
    await expect(page.locator('[data-model-provider="claude"]')).toBeVisible();
  });
}

test("usage refresh animates popup height and fades content, respecting reduced motion", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models&usage=slow");
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  const refresh = page.getByRole("button", {
    name: "Refresh subscription usage",
  });
  await expect(refresh).toBeEnabled();
  await expect(page.locator("[data-model-picker-outgoing]")).toHaveCount(0);
  const [transition] = await Promise.all([
    page.evaluate(
      () =>
        new Promise<{
          fadingTargets: string[];
          frames: Keyframe[][];
        }>((resolve) => {
          const observer = new MutationObserver(() => {
            const content = document.querySelector<HTMLElement>(
              "[data-model-picker-content]",
            );
            const popup = content?.parentElement;
            if (!popup) return;
            const animations = popup.getAnimations({ subtree: true });
            if (!animations.length) return;
            observer.disconnect();
            resolve({
              fadingTargets: animations
                .filter((animation) =>
                  (animation.effect as KeyframeEffect)
                    .getKeyframes()
                    .some((frame) => "opacity" in frame),
                )
                .map((animation) =>
                  (
                    (animation.effect as KeyframeEffect).target as HTMLElement
                  ).hasAttribute("data-subscription-content")
                    ? "usage"
                    : "other",
                ),
              frames: animations.map((animation) =>
                (animation.effect as KeyframeEffect).getKeyframes(),
              ),
            });
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }),
    ),
    refresh.click(),
  ]);
  expect(transition.fadingTargets).toEqual(["usage"]);
  expect(
    transition.frames.some((frames) =>
      frames.some((frame) => "height" in frame),
    ),
  ).toBe(true);
  expect(
    transition.frames.some((frames) =>
      frames.some((frame) => "opacity" in frame),
    ),
  ).toBe(true);
  await expect(refresh).toBeEnabled();
  await expect(page.locator("[data-model-picker-outgoing]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await refresh.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Loading usage..." }),
  ).toBeVisible();
  await expect(page.locator("[data-model-picker-outgoing]")).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await expect(page.locator("[data-model-picker-outgoing]")).toHaveCount(0);
});

test("late Claude response cannot overwrite the selected Codex usage", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models&usage=slow");
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: "Codex", exact: true })
    .click();
  const usage = page.getByRole("group", {
    name: "Subscription usage",
    exact: true,
  });
  await expect(usage.getByText("68% left")).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(usage.getByRole("progressbar")).toHaveCount(1);
  await expect(usage.getByText("68% left")).toBeVisible();
  expect(await requests(page)).toHaveLength(2);
});
