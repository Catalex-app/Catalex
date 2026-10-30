import { expect, test } from "@playwright/test";

test("forks a completed assistant response into an independent chat", async ({
  page,
}) => {
  await page.goto("/?debug=chat-branching");
  await expect(page.getByTestId("chat-branching-harness-shell")).toBeVisible();

  const forkActions = page.getByRole("button", {
    name: "Fork from this response",
  });
  await expect(forkActions).toHaveCount(2);
  await expect(page.getByText("Second question")).toBeVisible();

  await forkActions.first().click();

  await expect(page.getByTestId("active-chat-title")).toHaveText(
    "Original chat (fork)",
  );
  await expect(page.getByTestId("chat-tab-count")).toHaveText("2 chats");
  await expect(page.getByText("First question")).toBeVisible();
  await expect(
    page.getByText("First answer. This is a valid place to start a branch."),
  ).toBeVisible();
  await expect(page.getByText("Second question")).toHaveCount(0);
  await expect(forkActions).toHaveCount(1);
});
