import { expect, test } from "@playwright/test";

for (const surface of ["sidebar", "popup"]) {
  test(`${surface}: saved session context restores into a pop-out while the main agent keeps running`, async ({
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
    if (surface === "popup")
      await page.getByRole("button", { name: "Session history" }).click();
    const saved =
      surface === "sidebar"
        ? page
            .getByTestId("vibe-sessions")
            .getByRole("button", { name: /Saved conversation/ })
        : page.getByRole("menuitem", { name: /Saved conversation/ });
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
}

for (const surface of ["sidebar", "popup"]) {
  test(`${surface}: archive menu keeps selection and supports cancellation`, async ({
    page,
  }) => {
    await page.goto("/?debug=session-navigation");
    if (surface === "popup")
      await page.getByRole("button", { name: "Session history" }).click();
    const saved =
      surface === "sidebar"
        ? page
            .getByTestId("vibe-sessions")
            .getByRole("button", { name: /Saved conversation/ })
        : page.getByRole("menuitem", { name: /Saved conversation/ });
    await expect(
      page.getByRole("button", { name: "Archive chat", exact: true }),
    ).toHaveCount(0);
    await saved.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    const confirm = page.getByRole("menuitem", {
      name: "Confirm",
      exact: true,
    });
    await expect(confirm).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("session-archive-confirmation.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("active-title")).toHaveText(
      "Background review",
    );
    await expect(saved).toBeVisible();
    await saved.click({ button: "right" });
    await expect(
      page.getByRole("menuitem", { name: "Archive chat", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("menuitem", { name: "Archive chat", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Confirm", exact: true }).click();
    await expect(saved).toHaveCount(0);
    await expect(page.getByTestId("active-title")).toHaveText(
      "Background review",
    );
  });
}
