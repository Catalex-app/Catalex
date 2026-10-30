import { expect, test } from "@playwright/test";

for (const surface of ["vibe", "duet"] as const) {
  for (const paused of [false, true]) {
    test(`${surface} preserves a ${paused ? "paused" : "running"} agent when creating and switching chats`, async ({
      page,
    }) => {
      await page.goto(`/?debug=session-navigation&paused=${paused}`);
      const panel = page.getByTestId("vibe-sessions");
      const history = page.getByRole("button", { name: "Session history" });
      await expect(page.getByTestId("active-title")).toHaveText(
        "Background review",
      );
      if (surface === "duet") {
        await history.click();
        await expect(
          page.getByRole("menuitem", { name: "New Chat", exact: true }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
      await panel
        .getByRole("button", { name: "New chat", exact: true })
        .click();
      await expect(page.getByTestId("active-title")).toHaveText("New Chat");
      await expect(page.getByTestId("tab-count")).toHaveText("2 tabs");
      await expect(page.getByTestId("background-state")).toHaveText(
        paused ? "paused" : "running",
      );
      await expect(page.getByTestId("background-draft")).toHaveText(
        "working-draft",
      );
      await page
        .getByRole("button", { name: "Simulate background response" })
        .click();
      await expect(page.getByTestId("background-messages")).toHaveText(
        "2 messages",
      );
      await expect(page.getByTestId("visible-messages")).toHaveText(
        "0 messages",
      );

      if (surface === "vibe") {
        await panel.getByRole("button", { name: /Background review/ }).click();
      } else {
        await history.click();
        await expect(
          page.getByRole("img", { name: "Agent working" }),
        ).toHaveCount(paused ? 0 : 1);
        await page.screenshot({
          animations: "disabled",
          path: `/tmp/session-navigation-history-${paused ? "paused" : "running"}.png`,
        });
        await page.getByRole("menuitem", { name: /Background review/ }).click();
      }
      await expect(page.getByTestId("active-title")).toHaveText(
        "Background review",
      );
      await expect(page.getByTestId("visible-messages")).toHaveText(
        "2 messages",
      );
      await expect(page.getByTestId("tab-count")).toHaveText("1 tabs");
      await expect(page.getByTestId("native-calls")).toHaveText("");

      // Loading a saved chat while the original is active must only dispose the new tab's runtime.
      if (surface === "vibe") {
        await panel.getByRole("button", { name: /Saved conversation/ }).click();
      } else {
        await history.click();
        await page
          .getByRole("menuitem", { name: /Saved conversation/ })
          .click();
      }
      await expect(page.getByTestId("active-title")).toHaveText(
        "Saved conversation",
      );
      await expect(page.getByTestId("tab-count")).toHaveText("2 tabs");
      await expect(page.getByTestId("background-state")).toHaveText(
        paused ? "paused" : "running",
      );
      await expect(page.getByTestId("native-calls")).not.toContainText(
        ":working-tab",
      );
      await expect(page.getByTestId("native-calls")).toContainText(
        "load_shared_session:saved-session",
      );
      await page.screenshot({
        animations: "disabled",
        path: `/tmp/session-navigation-${surface}-${paused ? "paused" : "running"}.png`,
      });

      if (!paused && surface === "duet") {
        await page
          .getByRole("button", { name: "Finish background run" })
          .click();
        await history.click();
        await expect(
          page.getByRole("img", { name: "Agent working" }),
        ).toHaveCount(0);
      }
    });
  }
}

for (const surface of ["vibe", "duet"] as const) {
  test(`${surface} can open archived history during a run`, async ({
    page,
  }) => {
    await page.goto("/?debug=session-navigation");
    await expect(page.getByTestId("active-title")).toHaveText(
      "Background review",
    );
    if (surface === "vibe") {
      const panel = page.getByTestId("vibe-sessions");
      await panel.getByRole("button", { name: "Archived (1)" }).click();
      await panel
        .getByRole("button", { name: /Archived conversation/ })
        .click();
    } else {
      await page.getByRole("button", { name: "Session history" }).click();
      await page.getByRole("button", { name: "Archived (1)" }).click();
      await page
        .getByRole("menuitem", { name: /Archived conversation/ })
        .click();
    }
    await expect(page.getByTestId("active-title")).toHaveText(
      "Archived conversation",
    );
    await expect(page.getByTestId("background-state")).toHaveText("running");
    await expect(page.getByTestId("native-calls")).not.toContainText(
      ":working-tab",
    );
  });
}

test("history ages locally and refreshes an existing chat after saving", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/?debug=session-navigation&paused=true");
  const panel = page.getByTestId("vibe-sessions");
  const background = panel.getByRole("button", { name: /Background review/ });
  await expect(background).toContainText("just now");
  await page.clock.fastForward(120_000);
  await expect(background).toContainText("2m ago");
  await page.getByRole("button", { name: "Save background chat" }).click();
  await expect(background).toContainText("2m ago");
  await page.getByRole("button", { name: "Session history" }).click();
  const menuChat = page.getByRole("menuitem", { name: /Background review/ });
  await expect(menuChat).toContainText("2m ago");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Simulate background response" })
    .click();
  await page.getByRole("button", { name: "Save background chat" }).click();
  await expect(background).toContainText("just now");
  await expect(
    panel.getByRole("button", { name: /Saved conversation/ }),
  ).toContainText("2m ago");
  await page.getByRole("button", { name: "Session history" }).click();
  await expect(menuChat).toContainText("just now");
  await page.screenshot({
    path: "/tmp/session-timestamps.png",
    animations: "disabled",
  });
});
