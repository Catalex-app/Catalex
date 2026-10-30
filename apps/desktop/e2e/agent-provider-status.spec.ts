import { expect, test, type Page } from "@playwright/test";

async function emit(page: Page, provider: string, message: unknown) {
  await page.evaluate(
    async ({ provider, message }) => {
      await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
        event: `${provider}-output`,
        payload: { tab_id: "pause-tab", data: JSON.stringify(message) },
      });
    },
    { provider, message },
  );
}

for (const provider of ["claude", "codex"]) {
  test(`${provider} reports provider states without ending the turn`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: provider === "claude" ? 480 : 900,
      height: 760,
    });
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    const label = page.getByTestId("round-timer");
    await emit(
      page,
      provider,
      provider === "claude"
        ? { type: "system", subtype: "status", status: "compacting" }
        : { type: "provider_status", status: "compacting" },
    );
    await expect(label).toHaveText("Compacting...");
    await emit(
      page,
      provider,
      provider === "claude"
        ? { type: "system", subtype: "api_retry", error_status: null }
        : { type: "provider_status", status: "retrying" },
    );
    await expect(label).toHaveText("Retrying...");
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    await expect(page.locator("[data-chat-error-composer]")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("retry-status.png"),
      animations: "disabled",
    });
    await emit(
      page,
      provider,
      provider === "claude"
        ? { type: "stream_event", event: { type: "message_start" } }
        : { type: "provider_status", status: null },
    );
    await expect(label).toHaveText("Working...");
    await emit(
      page,
      provider,
      provider === "claude"
        ? { type: "system", subtype: "compact_boundary" }
        : { type: "provider_status", status: null },
    );
    await expect(label).toHaveText("Working...");
    await emit(
      page,
      provider,
      provider === "claude"
        ? { type: "system", subtype: "api_retry", error_status: 429 }
        : {
            type: "provider_status",
            status: "retrying",
          },
    );
    await expect(label).toHaveText("Retrying...");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(page.getByTestId("pause-status")).toHaveText("idle");
    await expect(label).toHaveCount(0);
  });
}

test("full-app preview reuses the expanded and collapsed chat status", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/?onboarding-demo&project&agent-state=compacting");
  const status = page.locator('[data-testid="round-timer"]:visible').last();
  await expect(status).toContainText("Compacting...");
  await page.getByLabel("Agent status preview").selectOption("retrying");
  await expect(status).toContainText("Retrying...");
  await expect(status).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("full-app-retry.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await expect(
    page
      .getByText("Retrying...", { exact: true })
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
});
