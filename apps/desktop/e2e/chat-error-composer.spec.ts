// @ts-nocheck
import { test, expect } from "@playwright/test";

// No errorInput flag: all errors render through the production composer.
async function setup(page) {
  await page.goto("/?debug=agent-file-review");
  await page.locator("[data-chat-drawer-panel] textarea").waitFor();
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/stores/agent-chat-store.ts"));
    window.chat = (await import(url)).useAgentChatStore;
  });
}
test("production error panel preserves drafts and follows drawer and workspace layouts", async ({
  page,
}) => {
  await setup(page);
  const textarea = page.locator("[data-chat-drawer-panel] textarea:visible");
  await textarea.fill("Keep my unsent feedback");
  await page.evaluate(() =>
    window.chat
      .getState()
      ._setError(
        window.chat.getState().activeTabId,
        "The revision failed: missing figure.tex",
      ),
  );
  const panel = page.locator("[data-chat-error-composer]:visible");
  await expect(panel).toContainText("The revision failed: missing figure.tex");
  await expect(page.locator("[data-chat-error-banner]")).toHaveCount(0);
  await expect(page.locator("textarea:visible")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Copy error" })).toBeVisible();
  await panel.getByRole("button", { name: "Copy error" }).focus();
  await expect(panel.locator("..")).toHaveCSS(
    "background-color",
    "rgb(207, 69, 75)",
  );
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await expect(panel).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(
    page.locator(
      "[data-workspace-panel-screen] [data-chat-error-composer]:visible",
    ),
  ).toHaveCount(1);
  await page.screenshot({ path: "/tmp/production-chat-error.png" });
  await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator("textarea:visible")).toHaveValue(
    "Keep my unsent feedback",
  );
});
test("model discovery failure uses production error panel and refreshes without sending chat", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const provider = window.chat.getState().selectedProvider;
    const url = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((url) => url.includes("/stores/" + provider + "-setup-store.ts"));
    const mod = await import(url);
    const store =
      provider === "claude" ? mod.useClaudeSetupStore : mod.useCodexSetupStore;
    window.modelStore = store;
    store.setState({
      modelsStatus: "error",
      modelsError: "Model discovery unavailable",
      refreshModels: async () => {
        store.setState({ modelsStatus: "loading", modelsError: null });
        await new Promise((resolve) => setTimeout(resolve, 150));
        store.setState({ modelsStatus: "ready", modelsError: null });
      },
    });
  });
  const panel = page.locator("[data-chat-error-composer]:visible");
  await expect(panel).toContainText("Model discovery unavailable");
  await expect(
    panel.getByRole("button", { name: "Fix with chat" }),
  ).toHaveCount(0);
  await panel.getByRole("button", { name: "Refresh" }).click();
  await expect(panel).toHaveCount(0);
  await expect(
    page.locator("[data-chat-drawer-panel] textarea:visible"),
  ).toBeVisible();
});
test("Fix with chat sends raw error context once without consuming the composer draft", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator("[data-chat-drawer-panel] textarea:visible")
    .fill("My draft stays here");
  await page.evaluate(() => {
    window.fixPrompts = [];
    window.chat.setState({
      sendPrompt: async (prompt) => {
        window.fixPrompts.push(prompt);
        window.chat
          .getState()
          ._setError(window.chat.getState().activeTabId, null);
      },
    });
    window.chat
      .getState()
      ._setError(
        window.chat.getState().activeTabId,
        "The agent draft did not compile. Missing results.tex",
      );
  });
  await page
    .locator("[data-chat-drawer-panel]")
    .getByRole("button", { name: "Fix with chat", exact: true })
    .click();
  await expect(
    page.locator("[data-chat-drawer-panel] textarea:visible"),
  ).toHaveValue("My draft stays here");
  expect(await page.evaluate(() => window.fixPrompts)).toHaveLength(1);
  expect(await page.evaluate(() => window.fixPrompts[0])).toContain(
    "Missing results.tex",
  );
});

test("revoked Claude token shows terminal recovery and reloads without losing the draft", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator("[data-chat-drawer-panel] textarea:visible")
    .fill("Keep my Claude draft");
  await page.evaluate(async () => {
    const originalInvoke = window.__TAURI_INTERNALS__.invoke;
    window.recoveryCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      if (
        command === "dispose_claude_session" ||
        command === "verify_claude_model"
      ) {
        window.recoveryCalls.push({ command, args });
        await new Promise((resolve) => setTimeout(resolve, 200));
        return null;
      }
      return originalInvoke(command, args, options);
    };
    window.chat.setState({ selectedProvider: "claude" });
    window.chat
      .getState()
      ._setError(
        window.chat.getState().activeTabId,
        "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
      );
  });
  const panel = page.locator("[data-chat-error-composer]:visible");
  await expect(panel).toContainText("401 OAuth access token has been revoked.");
  await expect(panel).toContainText("claude auth logout");
  await expect(panel).toContainText("claude auth login");
  await expect(
    panel.getByRole("button", { name: "Fix with chat" }),
  ).toHaveCount(0);
  await expect(panel.locator("..")).toHaveCSS(
    "background-color",
    "rgb(207, 69, 75)",
  );
  await page.screenshot({ path: "/tmp/claude-auth-recovery-drawer.png" });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(
    page.locator(
      "[data-workspace-panel-screen] [data-chat-error-composer]:visible",
    ),
  ).toHaveCount(1);
  const reload = panel.getByRole("button", { name: "Reload Claude" });
  await expect(panel.locator("..")).toHaveCSS(
    "background-color",
    "rgb(207, 69, 75)",
  );
  await expect
    .poll(async () => {
      const box = await reload.boundingBox();
      return !!box && box.y + box.height <= page.viewportSize().height;
    })
    .toBe(true);
  await page.screenshot({ path: "/tmp/claude-auth-recovery-workspace.png" });
  await reload.click();
  await expect(reload).toBeDisabled();
  await expect(panel).toHaveCount(0);
  await expect(page.locator("textarea:visible")).toHaveValue(
    "Keep my Claude draft",
  );
  expect(
    (await page.evaluate(() => window.recoveryCalls)).map(
      (call) => call.command,
    ),
  ).toEqual(["dispose_claude_session", "verify_claude_model"]);
});

test("unknown provider failure reconnects without sending and preserves new draft", async ({
  page,
}) => {
  await setup(page);
  await page
    .locator("[data-chat-drawer-panel] textarea:visible")
    .fill("New unsent draft");
  await page.evaluate(() => {
    const state = window.chat.getState();
    window.retryCalls = [];
    window.chat.setState({
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId
          ? {
              ...tab,
              retryRequest: {
                prompt: "Original request",
                context: [],
                provider: state.selectedProvider,
              },
            }
          : tab,
      ),
      sendPrompt: async (...args) => {
        window.retryCalls.push(args);
        window.chat.getState()._setError(state.activeTabId, null);
      },
    });
    window.chat
      .getState()
      ._setError(state.activeTabId, "Exact provider failure text");
  });
  const panel = page.locator("[data-chat-error-composer]:visible");
  await expect(panel).toContainText("Exact provider failure text");
  await expect(
    panel.getByRole("button", { name: "Fix with chat" }),
  ).toHaveCount(0);
  await expect(panel.locator("..")).toHaveCSS(
    "background-color",
    "rgb(207, 69, 75)",
  );
  await page.screenshot({ path: "/tmp/claude-reconnect-panel.png" });
  await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
  expect(await page.evaluate(() => window.retryCalls)).toEqual([]);
  await expect(
    page.locator("[data-chat-drawer-panel] textarea:visible"),
  ).toHaveValue("New unsent draft");
});
