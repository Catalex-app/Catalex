import { expect, test } from "@playwright/test";

test("adds custom models, validates input, persists and selects them", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 620 });
  await page.goto("/?debug=claude-models&section=agent&provider=claude");
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await expect(page.getByLabel("Model ID", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a model ID.");
  await page.getByLabel("Model ID", { exact: true }).fill("Claude Opus 4.6");
  await expect(page.getByRole("alert")).toContainText("without spaces");
  await page.getByLabel("Model ID", { exact: true }).fill("claude-opus-4-6");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.locator("#custom-model-configuration").getByRole("status"),
  ).toContainText("Added claude-opus-4-6");
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("claude-opus-4-6");
  await expect(page.getByRole("alert")).toContainText("already available");
  await page.getByLabel("Model ID", { exact: true }).fill("");
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await page.getByLabel("Model ID", { exact: true }).fill("discard-this-model");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove discard-this-model" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await expect(page.getByLabel("Model ID", { exact: true })).toHaveValue("");
  await page.getByLabel("Model ID", { exact: true }).fill("gpt-custom-test");
  await expect(
    page.locator("#custom-model-configuration").getByRole("combobox"),
  ).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/custom-model-add-stage.png",
  });
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.locator("#custom-model-configuration").getByRole("status"),
  ).toContainText("Added gpt-custom-test");
  await page
    .locator('[data-settings-row-id="agent-codex-model"]')
    .getByRole("combobox")
    .click();
  await page
    .getByRole("option", { name: "GPT Custom Legacy", exact: true })
    .click();
  await expect(
    page
      .locator('[data-settings-row-id="agent-codex-reasoning"]')
      .getByRole("combobox"),
  ).toHaveText("Medium");
  await page
    .locator('[data-settings-row-id="agent-provider-tabs"]')
    .evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/custom-model-settings-light.png",
  });
  await page.reload();
  await page.getByRole("tab", { name: "Codex", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Remove gpt-custom-test", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show chat", exact: true }).click();
  await page.getByRole("button", { name: /Opus 4.8/ }).click();
  await page
    .getByRole("button", {
      name: "claude-opus-4-6 — Legacy model",
      exact: true,
    })
    .click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "claude-opus-4-6",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "claude-opus-4-6",
  );
  await page.getByRole("button", { name: "Codex", exact: true }).click();
  await page
    .getByRole("button", { name: "Legacy model", exact: true })
    .filter({ hasText: "GPT Custom Legacy" })
    .click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "gpt-custom-test",
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "gpt-custom-test",
  );
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/custom-model-picker-light.png",
  });
  await page
    .getByRole("button", { name: "Manage legacy models", exact: true })
    .click();
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await expect(page.getByLabel("Model ID", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Remove gpt-custom-test", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove gpt-custom-test", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .locator('[data-settings-row-id="appearance-theme"]')
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/custom-model-settings-dark.png",
  });
});

test("syncs model settings between windows and navigates an already-open Settings window", async ({
  page,
  context,
}) => {
  await page.goto("/?debug=claude-models&section=appearance");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit", {
      event: "settings-navigate",
      payload: "claude",
    });
  });
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  await expect(page.getByLabel("Model ID", { exact: true })).toBeVisible();
  const chat = await context.newPage();
  await chat.goto("/?debug=claude-models");
  await chat.getByRole("button", { name: /Opus 4.8/ }).click();
  await page
    .getByLabel("Model ID", { exact: true })
    .fill("claude-opus-custom-sync");
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const option = chat.getByRole("button", {
    name: /claude-opus-custom-sync.*Legacy model/,
  });
  await expect(option).toBeVisible();
  await option.click();
  await chat
    .getByRole("button", { name: "Simulate discovery failure", exact: true })
    .click();
  await chat
    .getByRole("button", {
      name: "claude-opus-custom-sync · claude-opus-custom-sync · Model settings",
      exact: true,
    })
    .click();
  await expect(option).toBeVisible();
  await expect(chat.getByTestId("claude-model-selection")).toContainText(
    "claude-opus-custom-sync",
  );
  await page
    .getByRole("button", {
      name: "Remove claude-opus-custom-sync",
      exact: true,
    })
    .click();
  await expect(option).toHaveCount(0);
});

test("default approval choices show their icons and tips", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 620 });
  await page.goto("/?debug=claude-models&section=agent&provider=codex");
  const approvalMode = page.getByRole("combobox", {
    name: "Default approval mode",
  });
  await expect(approvalMode).toHaveText("Need approval");
  await approvalMode.click();

  const needApproval = page.getByRole("option", { name: "Need approval" });
  const autoApply = page.getByRole("option", { name: "Auto-apply" });
  const tooltip = page.locator('[data-slot="tooltip-content"]:visible');
  await expect(needApproval.locator("svg.lucide-thumbs-up")).toBeVisible();
  await expect(autoApply.locator("svg.lucide-check-check")).toBeVisible();
  await needApproval.hover();
  await expect(tooltip).toContainText("Review changes before applying.");
  await autoApply.hover();
  await expect(tooltip).toContainText(
    "Apply clean changes automatically. Pause on conflicts or errors.",
  );
  await page.screenshot({
    path: test.info().outputPath("approval-options.png"),
    animations: "disabled",
  });
  await autoApply.click();
  await expect(approvalMode).toHaveText("Auto-apply");
  await expect(approvalMode.locator("svg.lucide-check-check")).toHaveClass(
    /\btext-purple-700\b/,
  );
  await page.reload();
  await expect(approvalMode).toHaveText("Auto-apply");
});

test("provider tabs separate navigation from the exclusive default choice", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 520 });
  await page.goto("/?debug=claude-models&section=agent&provider=codex");
  const codex = page.getByRole("tab", { name: "Codex", exact: true });
  const claude = page.getByRole("tab", { name: "Claude Code", exact: true });
  await expect(codex).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("switch", { name: "Use Codex by default" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page
      .locator('[data-settings-row-id="agent-codex-model"]')
      .getByRole("combobox"),
  ).toHaveText("GPT-5.4");
  const configuration = page.getByRole("region", {
    name: "Agent configuration",
    exact: true,
  });
  await expect(configuration.getByRole("tablist")).toBeVisible();
  await expect(
    configuration.locator('[data-settings-row-id="agent-default-mode"]'),
  ).toHaveCount(0);
  await expect(
    configuration.getByLabel("Global agent instructions"),
  ).toHaveCount(0);
  const approvalMode = page
    .locator('[data-settings-row-id="agent-default-mode"]')
    .getByRole("combobox");
  const instructions = page.getByLabel("Global agent instructions");
  const approvalValue = await approvalMode.textContent();
  const instructionsValue = await instructions.inputValue();
  const instructionsNode = await instructions.elementHandle();
  await claude.click();
  await expect(
    page
      .locator('[data-settings-row-id="agent-claude-model"]')
      .getByRole("combobox"),
  ).toHaveText("Default (Sonnet 4.6)");
  await expect(approvalMode).toHaveText(approvalValue!);
  await expect(instructions).toHaveValue(instructionsValue);
  expect(await instructionsNode!.evaluate((node) => node.isConnected)).toBe(
    true,
  );
  await expect(
    page.getByRole("switch", { name: "Use Claude Code by default" }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    page.locator('[data-settings-row-id="agent-codex-model"]'),
  ).toHaveCount(0);
  await page
    .getByRole("switch", { name: "Use Claude Code by default" })
    .click();
  await claude.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(codex).toBeFocused();
  await expect(
    page.getByRole("switch", { name: "Use Codex by default" }),
  ).toHaveAttribute("aria-checked", "false");
  await page.getByRole("switch", { name: "Use Codex by default" }).click();
  await expect(
    page.getByRole("switch", { name: "Use Codex by default" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/agent-provider-tabs-light.png",
  });
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page
    .locator('[data-settings-row-id="appearance-theme"]')
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.screenshot({
    animations: "disabled",
    path: "../../output/playwright/agent-provider-tabs-dark.png",
  });
});

test("verification gates saving and discards stale results", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 680 });
  await page.goto("/?debug=claude-models&section=agent&provider=codex");
  await page.getByRole("button", { name: "Add New", exact: true }).click();
  const input = page.getByLabel("Model ID", { exact: true });
  const verify = page.getByRole("button", { name: "Verify", exact: true });
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toHaveCount(0);
  await expect(
    page.getByText("Availability is checked", { exact: false }),
  ).toHaveCount(0);
  await input.fill("invalid-model");
  await verify.click();
  await expect(page.getByRole("alert")).toHaveText(
    "This model is not available for your account.",
  );
  await expect(save).toHaveCount(0);
  await input.fill("slow-model");
  await verify.click();
  await expect(page.getByRole("button", { name: "Verifying…" })).toBeDisabled();
  await input.fill("gpt-custom-test");
  // Let the old response arrive; it must not authorize the edited ID.
  await page.waitForTimeout(1100);
  await expect(save).toHaveCount(0);
  await verify.click();
  await expect(save).toBeVisible();
  await expect(
    page.locator("#custom-model-configuration").getByRole("status"),
  ).toContainText("GPT Custom Legacy");
  await page.screenshot({
    path: "../../output/playwright/custom-model-verified.png",
    animations: "disabled",
  });
  await input.fill("another-model");
  await expect(save).toHaveCount(0);
  await expect(verify).toBeVisible();
  await input.fill("gpt-custom-test");
  await verify.click();
  await save.click();
  await expect(page.locator("#custom-model-configuration li")).toHaveText(
    "GPT Custom Legacy",
  );
  await page.reload();
  await expect(page.locator("#custom-model-configuration li")).toHaveText(
    "GPT Custom Legacy",
  );
});
