import { expect, test } from "@playwright/test";
test("expanding a long chat starts at the bottom without a scroll animation", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review");
  const toggle = page.getByRole("button", {
    name: "Toggle drawer",
    exact: true,
  });
  await toggle.waitFor();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      );
    const { useAgentChatStore } = await import(resource!.name);
    const messages = Array.from({ length: 100 }, (_, i) => ({
      type: "user",
      message: {
        content: [
          {
            type: "text",
            text: `Message ${i}: ${"Long conversation content. ".repeat(10)}`,
          },
        ],
      },
    }));
    useAgentChatStore.setState({ messages, isStreaming: false });
  });
  const viewport = page.locator(
    "[data-chat-drawer-panel] [data-chat-messages] > div",
  );
  if (await viewport.count()) {
    await page.getByRole("button", { name: "Mini", exact: true }).click();
    await expect(viewport).toHaveCount(0);
  }
  await page.waitForTimeout(400);
  await toggle.click();
  await expect(viewport).toBeVisible();
  const gaps = await viewport.evaluate(async (element) => {
    const result = [];
    for (let i = 0; i < 15; i++) {
      await new Promise(requestAnimationFrame);
      result.push(
        element.scrollHeight - element.clientHeight - element.scrollTop,
      );
    }
    return result;
  });
  expect(Math.max(...gaps)).toBeLessThan(3);
  await page.screenshot({ path: "/tmp/chat-expand-scroll.png" });
});
