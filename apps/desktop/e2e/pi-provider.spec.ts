import { expect, test } from "@playwright/test";

test("Pi onboarding shares saved path dropdowns and hides them when disabled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: false, step: 2 }, version: 0 }),
    );
  });
  await page.goto("/?onboarding-demo");
  await page.getByRole("tab", { name: /Pi/ }).click();
  const executable = page.getByRole("combobox", {
    name: "Pi executable",
    exact: true,
  });
  const config = page.getByRole("combobox", {
    name: "Config folder",
    exact: true,
  });
  const enable = page.getByRole("switch", { name: "Enable Pi", exact: true });
  await expect(executable).toHaveCount(0);
  await expect(config).toHaveCount(0);
  await enable.click();
  await expect(executable).toHaveText("/demo/bin/pi");
  await expect(config).toHaveText("/demo/.pi/agent");
  await expect(page.getByText(/Uses your installed Pi/)).toHaveCount(0);

  await page.evaluate(async () => {
    const { browserHarness } = await import(
      "/src/renderer/lib/desktop/bridge.ts"
    );
    const harness = browserHarness()!;
    const invoke = harness.invoke;
    const dialogs: unknown[] = [];
    (window as Window & { piDialogs?: unknown[] }).piDialogs = dialogs;
    harness.invoke = async (command, args, options) => {
      if (command === "plugin:dialog|open") {
        const dialog = (args as { options: { directory?: boolean } }).options;
        dialogs.push(dialog);
        return dialog.directory
          ? "/demo/custom configuration/agent"
          : "/demo/custom installation/bin/pi";
      }
      return invoke(command, args, options);
    };
  });
  await executable.click();
  await expect(page.getByRole("option").last()).toHaveText("Add new");
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(executable).toHaveText("/demo/custom installation/bin/pi");
  await config.click();
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(config).toHaveText("/demo/custom configuration/agent");
  const dialogs = await page.evaluate(
    () => (window as Window & { piDialogs: unknown[] }).piDialogs,
  );
  expect(dialogs).toEqual([
    {
      directory: false,
      multiple: false,
      noResolveAliases: true,
      title: "Choose Pi executable",
      defaultPath: "/demo/bin/pi",
    },
    {
      directory: true,
      multiple: false,
      noResolveAliases: false,
      title: "Choose Pi config folder",
      defaultPath: "/demo/.pi/agent",
    },
  ]);
  await page
    .getByRole("heading", { name: "Agent provider", exact: true })
    .click();
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/pi-onboarding-paths.png",
    animations: "disabled",
  });
  await page.reload();
  await page.getByRole("tab", { name: /Pi/ }).click();
  await expect(executable).toHaveText("/demo/custom installation/bin/pi");
  await expect(config).toHaveText("/demo/custom configuration/agent");

  await page.setViewportSize({ width: 640, height: 700 });
  await executable.scrollIntoViewIfNeeded();
  await expect(page.getByRole("region", { name: "Agent setup" })).toBeVisible();
  const overflow = await page
    .getByTestId("onboarding")
    .evaluate((element) =>
      Array.from(element.querySelectorAll("[data-settings-row-id]")).some(
        (row) => row.scrollWidth > row.clientWidth,
      ),
    );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: "test-results/pi-onboarding-paths-compact.png",
    animations: "disabled",
  });
  await config.click();
  await page
    .getByRole("option", {
      name: "/demo/custom configuration/agent",
      exact: true,
    })
    .hover();
  await page
    .getByRole("button", {
      name: "Remove /demo/custom configuration/agent from list",
      exact: true,
    })
    .click();
  await expect(config).toHaveText("/demo/.pi/agent");
  await enable.click();
  await expect(executable).toHaveCount(0);
  await expect(config).toHaveCount(0);
  await enable.click();
  await page.getByLabel("Dependency scenario").selectOption("missing-pi");
  await expect(
    page.getByText("Install Pi in your terminal, then check again."),
  ).toBeVisible();
  await expect(executable).toBeEnabled();
  await expect(config).toBeEnabled();
});

test("opts into installed Pi and chooses provider-qualified models with thinking controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto("/?debug=claude-models&section=agent&provider=pi");
  await expect(page.getByRole("tab", { name: /Pi/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("switch", { name: "Enable Pi", exact: true }).click();
  await expect(
    page
      .locator('[data-settings-row-id="agent-pi-model"]')
      .getByRole("combobox"),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Refresh Pi verification" }).click();
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Verified · v1.2.0");
  await page.screenshot({
    path: "/tmp/catalex-pi-settings.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Show chat", exact: true }).click();
  await page.getByRole("button", { name: /Opus 4.8 ·/ }).click();
  await page
    .getByRole("group", { name: "Provider", exact: true })
    .getByRole("button", { name: "Pi", exact: true })
    .click();
  await expect(page.getByText("Pi default", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    '["provider-a","reasoning-model"]',
  );
  await page
    .getByRole("button", { name: "reasoning-model — provider-b", exact: true })
    .click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    '["provider-b","reasoning-model"]',
  );
  await page.getByRole("button", { name: "High", exact: true }).click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "/ high",
  );
  const effort = page.getByRole("group", { name: "Effort", exact: true });
  await expect(effort.getByRole("button")).toHaveText(["M", "H", "XH", "Max"]);
  await effort.getByRole("button", { name: "Max", exact: true }).click();
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "/ max",
  );
  await page.screenshot({
    path: "/tmp/catalex-pi-picker.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "reasoning-model — provider-a", exact: true })
    .click();
  await expect(effort.getByRole("button")).toHaveText(["L", "M", "H"]);
  await expect(
    effort.getByRole("button", { name: "High", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("claude-model-selection")).toContainText(
    "/ high",
  );
  await page
    .getByRole("button", { name: "fast-model — provider-a", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Effort", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("switch", { name: "Fast mode", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "/ commands", exact: true }).click();
  await expect(page.getByText("/compact", { exact: true })).toBeVisible();
  await page
    .getByRole("button", {
      name: "/skill:pi-fixture Pi skill fixture",
      exact: true,
    })
    .click();
  await expect(page.locator("textarea[data-chat-composer-input]")).toHaveValue(
    "/skill:pi-fixture ",
  );
});

test("Pi settings follow each model's supported thinking levels", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models&section=agent&provider=pi");
  await page.getByRole("switch", { name: "Enable Pi", exact: true }).click();
  const model = page
    .locator('[data-settings-row-id="agent-pi-model"]')
    .getByRole("combobox");
  const effort = page
    .locator('[data-settings-row-id="agent-pi-reasoning"]')
    .getByRole("combobox");
  await expect(model).toBeEnabled();
  await expect(model).toHaveText("Reasoning model · provider-a");
  await model.click();
  await expect(
    page.getByRole("option", { name: "Pi default", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(3);
  await page
    .getByRole("option", {
      name: "Same model, other provider · provider-b",
      exact: true,
    })
    .click();
  await effort.click();
  await expect(page.getByRole("option")).toHaveText([
    "Medium",
    "High",
    "Extra High",
    "Max",
  ]);
  await page.getByRole("option", { name: "Max", exact: true }).click();
  await model.click();
  await page
    .getByRole("option", { name: "Reasoning model · provider-a", exact: true })
    .click();
  await expect(effort).toHaveText("High");
  await effort.click();
  await expect(page.getByRole("option")).toHaveText(["Low", "Medium", "High"]);
  await page.getByRole("option", { name: "High", exact: true }).click();
  await model.click();
  await page
    .getByRole("option", { name: "Fast model · provider-a", exact: true })
    .click();
  await expect(effort).toHaveCount(0);
});

test("Pi path dropdowns add, select and remove saved choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto("/?debug=claude-models&section=agent&provider=pi");
  await page.getByRole("switch", { name: "Enable Pi", exact: true }).click();
  const executable = page.getByRole("combobox", {
    name: "Pi executable",
    exact: true,
  });
  const config = page.getByRole("combobox", {
    name: "Config folder",
    exact: true,
  });
  await expect(executable).toHaveText("/mock/bin/pi");
  await expect(config).toHaveText("/mock/home/.pi/agent");
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Verified · v1.2.0");
  await page.screenshot({
    path: "/tmp/catalex-pi-dropdown-default.png",
    animations: "disabled",
  });
  await executable.click();
  await expect(page.getByRole("option").last()).toHaveText("Add new");
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(executable).toHaveText("/mock/custom bin/pi");
  await config.click();
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(config).toHaveText("/mock/custom config");
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Verified · v1.2.0");
  await executable.click();
  await expect(page.getByRole("option")).toHaveText([
    "/mock/bin/pi",
    "/mock/custom bin/pi",
    "Add new",
  ]);
  await page.screenshot({
    path: "/tmp/catalex-pi-dropdown-options.png",
    animations: "disabled",
  });
  await page.getByRole("option", { name: "/mock/bin/pi", exact: true }).click();
  await expect(executable).toHaveText("/mock/bin/pi");
  await executable.click();
  await page
    .getByRole("option", { name: "/mock/custom bin/pi", exact: true })
    .hover();
  await page
    .getByRole("button", {
      name: "Remove /mock/custom bin/pi from list",
      exact: true,
    })
    .click();
  await expect(executable).toHaveText("/mock/bin/pi");
  await config.click();
  await page
    .getByRole("option", { name: "/mock/custom config", exact: true })
    .hover();
  await page
    .getByRole("button", {
      name: "Remove /mock/custom config from list",
      exact: true,
    })
    .click();
  await expect(config).toHaveText("/mock/home/.pi/agent");
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Verified · v1.2.0");
  const saved = await page.evaluate(
    () => JSON.parse(localStorage.getItem("catalex-settings")!).state,
  );
  expect(saved.piBinaryPaths).toEqual(["/mock/bin/pi"]);
  expect(saved.piConfigDirectories).toEqual(["/mock/home/.pi/agent"]);
  // Keyboard deletion also works, including the last detected option.
  await executable.click();
  await page
    .getByRole("option", { name: "/mock/bin/pi", exact: true })
    .press("Delete");
  await expect(executable).toHaveText("Select…");
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Not verified");
  await page.reload();
  await expect(executable).toHaveText("Select…");
  await executable.click();
  await expect(page.getByRole("option")).toHaveText(["Add new"]);
});

test("Pi Add new preserves selection on cancel, deduplicates and verifies invalid paths", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models&section=agent&provider=pi");
  await page.getByRole("switch", { name: "Enable Pi", exact: true }).click();
  const executable = page.getByRole("combobox", {
    name: "Pi executable",
    exact: true,
  });
  await expect(executable).toHaveText("/mock/bin/pi");
  await page.evaluate(() => {
    (window as Window & { __piPickerResult?: string | null }).__piPickerResult =
      null;
  });
  await executable.click();
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(executable).toHaveText("/mock/bin/pi");
  await page.evaluate(() => {
    (window as Window & { __piPickerResult?: string | null }).__piPickerResult =
      "/mock/bin/pi";
  });
  await executable.click();
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await executable.click();
  await expect(page.getByRole("option")).toHaveText([
    "/mock/bin/pi",
    "Add new",
  ]);
  await page.getByRole("option", { name: "/mock/bin/pi", exact: true }).click();
  await page.evaluate(() => {
    (window as Window & { __piPickerResult?: string | null }).__piPickerResult =
      "/missing/pi";
  });
  await executable.click();
  await page.getByRole("option", { name: "Add new", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Not verified");
  await expect(page.getByRole("alert")).toContainText(
    "Pi executable not found",
  );
  await expect(
    page
      .locator('[data-settings-row-id="agent-pi-model"]')
      .getByRole("combobox"),
  ).toBeDisabled();
  await executable.click();
  await page.getByRole("option", { name: "/missing/pi", exact: true }).hover();
  await page
    .getByRole("button", { name: "Remove /missing/pi from list", exact: true })
    .click();
  await expect(executable).toHaveText("/mock/bin/pi");
  await expect(
    page.getByRole("status", { name: "Pi verification" }),
  ).toHaveText("Verified · v1.2.0");
});

test("Pi skill discovery uses the selected paths once per picker opening", async ({
  page,
}) => {
  await page.goto("/?debug=claude-models");
  await expect(page.getByRole("button", { name: /Opus 4.8/ })).toBeVisible();
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    const { usePiSetupStore } = await import(
      "/src/renderer/stores/pi-setup-store.ts"
    );
    const { useAgentChatStore } = await import(
      "/src/renderer/stores/agent-chat-store.ts"
    );
    const { browserHarness } = await import(
      "/src/renderer/lib/desktop/bridge.ts"
    );
    useSettingsStore.setState({
      piBinaryPath: "/selected/bin/pi",
      piConfigDirectory: "/selected/config",
      enabledProviders: { claude: true, codex: true, pi: true },
    });
    await usePiSetupStore.getState().checkStatus();
    useAgentChatStore.setState((state) => ({
      selectedProvider: "pi",
      selectedPiModel: JSON.stringify(["provider-a", "reasoning-model"]),
      tabs: state.tabs.map((tab) => ({ ...tab, provider: "pi" })),
    }));
    const harness = browserHarness()!;
    const original = harness.invoke;
    (window as Window & { skillCalls?: unknown[] }).skillCalls = [];
    harness.invoke = async (command, args, options) => {
      if (command === "slash_commands_list")
        (window as Window & { skillCalls: unknown[] }).skillCalls.push(args);
      return original(command, args, options);
    };
  });
  const input = page.locator("textarea").first();
  await input.fill("/pi-fixture");
  await expect(
    page.getByRole("button", { name: /skill:pi-fixture/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /skill:pi-fixture/ }).click();
  await expect(input).toHaveValue("/skill:pi-fixture ");
  expect(
    await page.evaluate(
      () => (window as Window & { skillCalls: unknown[] }).skillCalls,
    ),
  ).toEqual([
    {
      provider: "pi",
      piConfig: {
        binaryPath: "/selected/bin/pi",
        configDirectory: "/selected/config",
      },
    },
  ]);
});
