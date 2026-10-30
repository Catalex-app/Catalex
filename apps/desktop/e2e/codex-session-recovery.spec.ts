// @ts-nocheck
import { test, expect } from "@playwright/test";

test("session recovery requires confirmation and sends the verified owner token", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review");
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .waitFor();
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const { useAgentChatStore: store } = await import(
      performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((p) => p.includes("/stores/agent-chat-store.ts"))
    );
    const state = store.getState();
    const original = window.__TAURI_INTERNALS__.invoke;
    window.recoveryCalls = [];
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (cmd === "check_codex_session_owner")
        return { ownerToken: "exact-owner" };
      if (cmd === "reconnect_codex_session") {
        window.recoveryCalls.push(args);
        if (args.ownerToken !== "exact-owner")
          throw new Error("Session remains busy");
        return null;
      }
      return original(cmd, args);
    };
    store.setState({
      selectedProvider: "codex",
      tabs: state.tabs.map((t) =>
        t.id === state.activeTabId
          ? {
              ...t,
              provider: "codex",
              providerSessionIds: {
                ...t.providerSessionIds,
                codex: "busy-thread",
              },
              error: "Could not resume Codex session: session writer busy",
            }
          : t,
      ),
      error: "Could not resume Codex session: session writer busy",
    });
  });
  const panel = page
    .locator("[data-chat-error-composer]")
    .filter({ visible: true });
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Take over", exact: true }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(panel).toContainText("Session remains busy");
  await panel.getByRole("button", { name: "Take over", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  if ((await page.evaluate(() => window.recoveryCalls)).length !== 1)
    throw Error("Cancel sent recovery");
  await panel.getByRole("button", { name: "Take over", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Take over", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  const calls = await page.evaluate(() => window.recoveryCalls);
  if (calls[1].ownerToken !== "exact-owner") throw Error("Wrong capability");
});
