import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-settings",
      JSON.stringify({
        state: { enabledProviders: { claude: false, codex: false, pi: true } },
        version: 25,
      }),
    );
  });
  await page.goto("/?onboarding-demo&welcome");
  await expect(page.getByTestId("welcome-layout")).toBeVisible();
});

test("shows and refreshes only enabled agents, including Pi", async ({
  page,
}) => {
  const sidebar = page.getByTestId("welcome-sidebar-panel");
  const refresh = sidebar.getByRole("button", {
    name: "Check again",
    exact: true,
  });
  await expect(sidebar.getByText("1.2.0", { exact: true })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await page.evaluate(async () => {
    const { browserHarness } = await import(
      "/src/renderer/lib/desktop/bridge.ts"
    );
    const harness = browserHarness()!;
    const invoke = harness.invoke;
    const requests: string[] = [];
    (
      window as Window & { environmentRequests?: string[] }
    ).environmentRequests = requests;
    harness.invoke = async (command, args, options) => {
      if (
        [
          "detect_texlive",
          "check_pi_status",
          "check_claude_status",
          "check_codex_status",
        ].includes(command)
      )
        requests.push(command);
      return invoke(command, args, options);
    };
  });

  const labels = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
  for (const enabled of [
    ["pi"],
    ["claude"],
    ["codex"],
    [],
    ["claude", "codex", "pi"],
  ]) {
    await page.evaluate(async (enabled) => {
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      useSettingsStore.setState({
        enabledProviders: {
          claude: enabled.includes("claude"),
          codex: enabled.includes("codex"),
          pi: enabled.includes("pi"),
        },
      });
    }, enabled);
    for (const [provider, label] of Object.entries(labels)) {
      const rowLabel = sidebar.getByText(label, { exact: true });
      if (enabled.includes(provider)) await expect(rowLabel).toBeVisible();
      else await expect(rowLabel).toHaveCount(0);
    }
    await expect(refresh).toBeEnabled();
    await page.evaluate(() => {
      (
        window as Window & { environmentRequests: string[] }
      ).environmentRequests.length = 0;
    });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    const requests = await page.evaluate(
      () =>
        (window as Window & { environmentRequests: string[] })
          .environmentRequests,
    );
    expect(requests.sort()).toEqual(
      [
        "detect_texlive",
        ...enabled.map((provider) => `check_${provider}_status`),
      ].sort(),
    );
    await expect(sidebar.getByText("LaTeXmk", { exact: true })).toBeVisible();
    if (enabled.length === 1 && enabled[0] === "pi")
      await page.screenshot({
        path: "/tmp/catalex-welcome-pi-only.png",
        animations: "disabled",
      });
    if (enabled.length === 0)
      await sidebar.screenshot({
        path: "/tmp/catalex-welcome-agents-off.png",
        animations: "disabled",
      });
  }
  await page.screenshot({
    path: "/tmp/catalex-welcome-all-agents.png",
    animations: "disabled",
  });
});

test("shows Pi checking and unavailable states, and recovers on refresh", async ({
  page,
}) => {
  const sidebar = page.getByTestId("welcome-sidebar-panel");
  const refresh = sidebar.getByRole("button", {
    name: "Check again",
    exact: true,
  });
  const piRow = sidebar.getByText("Pi", { exact: true }).locator("..");
  await expect(piRow).toContainText("1.2.0");
  await expect(refresh).toBeEnabled();
  await page.evaluate(async () => {
    const { browserHarness } = await import(
      "/src/renderer/lib/desktop/bridge.ts"
    );
    const harness = browserHarness()!;
    const invoke = harness.invoke;
    harness.invoke = async (command, args, options) => {
      if (command === "check_pi_status") {
        harness.invoke = invoke;
        return new Promise((_resolve, reject) => {
          (window as Window & { failPiCheck?: () => void }).failPiCheck = () =>
            reject(new Error("Pi check failed"));
        });
      }
      return invoke(command, args, options);
    };
  });
  await refresh.click();
  await expect(piRow).toContainText("Checking");
  await expect(refresh).toBeDisabled();
  await page.evaluate(() =>
    (window as Window & { failPiCheck: () => void }).failPiCheck(),
  );
  await expect(piRow).toContainText("Unavailable");
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(piRow).toContainText("1.2.0");
  await expect(refresh).toBeEnabled();

  await page
    .getByRole("combobox", { name: "Dependency scenario" })
    .selectOption("missing-providers");
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      enabledProviders: { claude: true, codex: true, pi: true },
    });
  });
  await expect(
    sidebar.getByRole("link", { name: "Install Claude CLI" }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("link", { name: "Install Codex CLI" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      enabledProviders: { claude: false, codex: false, pi: true },
    });
  });
  await expect(
    sidebar.getByRole("link", { name: "Install Claude CLI" }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("link", { name: "Install Codex CLI" }),
  ).toHaveCount(0);
  await expect(sidebar.getByText("Claude Code", { exact: true })).toHaveCount(
    0,
  );
  await expect(sidebar.getByText("Codex", { exact: true })).toHaveCount(0);
  await expect(piRow).toContainText("Unavailable");
});
