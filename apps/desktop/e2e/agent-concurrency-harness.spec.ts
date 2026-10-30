import { expect, test } from "@playwright/test";

test("reviews A first, then asks B about its conflicting draft", async ({
  page,
}) => {
  await page.goto("/?debug=agent-concurrency");
  await expect(page.getByRole("img", { name: "Agent working" })).toHaveCount(2);
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await page.getByRole("button", { name: "Finish Agent B" }).click();
  await expect(page.getByTestId("review-queue")).toHaveText(
    "a: review · b: queued",
  );
  await expect(
    page.getByRole("img", { name: "Waiting for review" }),
  ).toBeVisible();
  await page.locator('[data-tab-id="b"]').click();
  await expect(
    page
      .locator("[data-agent-draft-notice]")
      .getByRole("button", { name: "Agent A", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await expect(page.locator("[data-agent-draft-notice]")).toHaveText(
    "Waiting for review of Agent A",
  );
  await page.screenshot({ path: "/tmp/catalex-inline-pending.png" });
  await page
    .locator("[data-agent-draft-notice]")
    .getByRole("button", { name: "Agent A", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Agent A", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("active-conversation")
      .getByRole("button", { name: "Review draft (1 change)", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Accept All/ }).click();
  await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
  await expect(
    page.getByRole("img", { name: "Awaiting your answer" }),
  ).toBeVisible();
  await page.locator('[data-tab-id="b"]').click();
  await expect(
    page.getByRole("region", { name: "Agent question" }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/catalex-concurrency-question.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Keep safe changes only", exact: true })
    .click();
  const submit = page.getByRole("button", {
    name: /Submit|Send answer|Confirm/,
  });
  if (await submit.count()) await submit.first().click();
  await expect(page.getByTestId("review-queue")).toHaveText("b: review");
  await expect(page.getByTestId("active-conversation")).toContainText(
    "references.tex",
  );
  await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
  await page.getByRole("button", { name: /Accept All/ }).click();
  await expect(page.getByTestId("source-content")).toHaveText("Accepted B");
  await expect(page.getByTestId("review-queue")).toHaveText("");
});

test("rejecting A allows B to review unchanged source", async ({ page }) => {
  await page.goto("/?debug=agent-concurrency");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await page.getByRole("button", { name: "Finish Agent B" }).click();
  await page.getByRole("button", { name: /Reject All/ }).click();
  await expect(page.getByTestId("review-queue")).toHaveText("b: review");
  await page.locator('[data-tab-id="b"]').click();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Agent question" }),
  ).toHaveCount(0);
  await expect(page.getByTestId("source-content")).toHaveText(
    "Original introduction",
  );
  await page.screenshot({
    path: "/tmp/catalex-concurrency-review.png",
    animations: "disabled",
  });
});

test("keeps A's review visible while focusing working agent B", async ({
  page,
}) => {
  await page.goto("/?debug=agent-concurrency");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await page.locator('[data-tab-id="b"]').click();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await expect(
    page.getByText("Agent A proposal", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/catalex-persistent-review.png" });
  await page.getByRole("button", { name: /Accept All/ }).click();
  await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
});

test("collapsed chat shares the review link without requesting drawer collapse", async ({
  page,
}) => {
  await page.goto("/?debug=agent-concurrency&compact=true");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  const link = page
    .getByTestId("collapsed-chat")
    .getByRole("button", { name: "Review draft (1 change)", exact: true });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("button", { name: /Accept All/ })).toBeVisible();
  await page.screenshot({ path: "/tmp/catalex-unified-review-link.png" });
});

test("collapsed pending link focuses the earlier review", async ({ page }) => {
  await page.goto("/?debug=agent-concurrency&compact=true");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await page.getByRole("button", { name: "Finish Agent B" }).click();
  await page.locator('[data-tab-id="b"]').click();
  const compact = page.getByTestId("collapsed-chat");
  const waiting = compact.getByRole("button", {
    name: "Agent A",
  });
  await expect(waiting).toBeVisible();
  await expect(
    compact.getByRole("button", { name: /Review draft/ }),
  ).toHaveCount(0);
  await page.screenshot({ path: "/tmp/catalex-purple-pending.png" });
  await waiting.click();
  await expect(
    compact.getByRole("button", {
      name: "Review draft (1 change)",
      exact: true,
    }),
  ).toBeVisible();
});

test("queue positions advance after the earlier review settles", async ({
  page,
}) => {
  await page.goto("/?debug=agent-concurrency&third=true&conflict=false");
  for (const agent of ["A", "B", "C"]) {
    await page.getByRole("button", { name: `Finish Agent ${agent}` }).click();
  }
  await page.locator('[data-tab-id="c"]').click();
  const notice = page.locator("[data-agent-draft-notice]");
  await expect(notice).toHaveText("Waiting for review of Agent A");
  await page.getByRole("button", { name: /Reject All/ }).click();
  await expect(notice).toHaveText("Waiting for review of Agent B");
  await notice.getByRole("button", { name: "Agent B", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agent B", exact: true }),
  ).toBeVisible();
});

test("vibe shows review and pending notices for the focused chat", async ({
  page,
}) => {
  await page.goto("/?debug=agent-concurrency&vibe=true");
  const pane = page.getByTestId("vibe-pane");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await expect(
    pane.getByRole("button", { name: "Review draft (1 change)", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/catalex-vibe-review.png" });
  await page.getByRole("button", { name: "Finish Agent B" }).click();
  await page.locator('[data-tab-id="b"]').click();
  await expect(pane.locator("[data-agent-draft-notice]")).toHaveText(
    "Waiting for review of Agent A",
  );
  await page.screenshot({ path: "/tmp/catalex-vibe-pending.png" });
  await pane.getByRole("button", { name: "Agent A", exact: true }).click();
  await expect(
    pane.getByRole("button", { name: "Review draft (1 change)", exact: true }),
  ).toBeVisible();
});

for (const provider of ["codex", "claude"]) {
  test(`${provider} Edit applies clean changes without showing review controls`, async ({
    page,
  }) => {
    await page.goto(
      `/?debug=agent-concurrency&mode=edit&conflict=false&provider=${provider}`,
    );
    await page.getByRole("button", { name: "Finish Agent A" }).click();
    await expect(page.getByTestId("review-queue")).toHaveText("a: applying");
    await expect(
      page.getByRole("button", { name: /Accept All|Reject All|Review draft/ }),
    ).toHaveCount(0);
    await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
    await expect(page.getByTestId("review-queue")).toHaveText("");
    await page.getByRole("button", { name: "Finish Agent B" }).click();
    await expect(page.getByTestId("source-content")).toHaveText("Accepted B");
    await expect(
      page.getByRole("button", { name: /Accept All|Reject All|Review draft/ }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `/tmp/catalex-edit-auto-${provider}.png`,
      animations: "disabled",
    });
  });
}

test("Edit pauses for conflicts and apply errors", async ({ page }) => {
  await page.goto("/?debug=agent-concurrency&mode=edit");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
  await page.getByRole("button", { name: "Finish Agent B" }).click();
  await page.locator('[data-tab-id="b"]').click();
  await expect(page.getByTestId("review-queue")).toHaveText("b: question");
  await expect(
    page.getByRole("region", { name: "Agent question" }),
  ).toBeVisible();
  await expect(page.getByTestId("source-content")).toHaveText("Accepted A");
  await page.screenshot({
    path: "/tmp/catalex-edit-conflict.png",
    animations: "disabled",
  });
  await page.goto("/?debug=agent-concurrency&mode=edit&applyError=true");
  await page.getByRole("button", { name: "Finish Agent A" }).click();
  await expect(page.getByTestId("review-queue")).toHaveText("a: question");
  await expect(
    page.getByRole("region", { name: "Agent question" }),
  ).toBeVisible();
  await expect(page.getByTestId("source-content")).toHaveText(
    "Original introduction",
  );
  await expect(
    page.getByRole("button", { name: /Accept All|Reject All/ }),
  ).toHaveCount(0);
});
