import { expect, test } from "@playwright/test";

test("saved session context restores into a pop-out while the main agent keeps running", async ({
  page,
  context,
}) => {
  await page.goto("/?debug=session-navigation");
  await expect(page.getByTestId("active-title")).toHaveText(
    "Background review",
  );
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
    );
    useAgentChatStore.setState({
      chatProjectRoot: "/session-navigation-project",
    });
  });
  const saved = page
    .getByTestId("vibe-sessions")
    .getByRole("button", { name: /Saved conversation/ });
  await saved.click({ button: "right" });
  const action = page.getByRole("menuitem", {
    name: "Open in pop-out",
    exact: true,
  });
  await expect(action.locator(".lucide-app-window")).toHaveCount(1);
  await page.getByRole("menu").evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: test.info().outputPath("session-popout-menu.png"),
  });
  const opened = page.waitForEvent("popup");
  await action.click();
  const child = await opened;
  await expect(child.locator("[data-panel-window-title]")).toContainText(
    "Saved conversation",
  );
  await expect(
    child.getByText("Earlier conversation", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("active-title")).toHaveText(
    "Background review",
  );
  await expect(page.getByTestId("background-state")).toHaveText("running");
  await expect(page.getByTestId("background-draft")).toHaveText(
    "working-draft",
  );
  await expect(page.getByTestId("tab-count")).toHaveText("2 tabs");
  await saved.click({ button: "right" });
  await action.click();
  expect(context.pages()).toHaveLength(2);
  await expect(page.getByTestId("native-calls")).toHaveText(
    "load_shared_session:saved-session",
  );
  await child.close();
});
