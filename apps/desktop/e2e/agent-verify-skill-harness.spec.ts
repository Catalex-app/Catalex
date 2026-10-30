import { expect, test } from "@playwright/test";

const scenarios = [
  {
    id: "success",
    status: "complete",
    attempts: 1,
    renders: 1,
    summary: "Compiled in 1/3 attempts",
  },
  {
    id: "compile-repair",
    status: "complete",
    attempts: 2,
    renders: 1,
    summary: "compiled in 2/3 attempts",
  },
  {
    id: "retry-exhausted",
    status: "failed",
    attempts: 3,
    renders: 0,
    summary: "failed after 3/3 attempts",
  },
  {
    id: "visual-repair",
    status: "complete",
    attempts: 2,
    renders: 2,
    summary: "Recompiled in 2/3 attempts",
  },
] as const;

for (const provider of ["codex", "claude"]) {
  test(`review-document is discoverable and inserts native ${provider} syntax`, async ({
    page,
  }) => {
    await page.goto(`/?debug=agent-verify-skill&provider=${provider}`);
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    const composer = page
      .locator('textarea[data-chat-composer-input="true"]')
      .first();
    await composer.fill("/review-document");
    const syntax =
      provider === "codex" ? "$review-document" : "/catalex:review-document";
    await expect(
      page.getByRole("heading", { name: "Catalex", exact: true }),
    ).toBeVisible();
    await page.getByText(syntax, { exact: true }).click();
    await expect(composer).toHaveValue(`${syntax} `);
  });
}

for (const scenario of scenarios) {
  test(`demonstrates the ${scenario.id} verification path`, async ({
    page,
  }) => {
    await page.goto(`/?debug=agent-verify-skill&scenario=${scenario.id}`, {
      waitUntil: "domcontentloaded",
    });

    const shell = page.getByTestId("agent-verify-skill-harness");
    await expect(shell).toHaveAttribute("data-scenario", scenario.id);
    await expect(page.getByTestId("verification-status")).toHaveText(
      scenario.status,
    );
    await expect(page.getByTestId("verification-summary")).toContainText(
      scenario.summary,
    );
    await expect(
      page.locator('[data-tool="mcp__catalex__compile"]'),
    ).toHaveCount(scenario.attempts);
    await expect(
      page.locator('[data-tool="mcp__catalex__render_page"]'),
    ).toHaveCount(scenario.renders);
  });
}

test("the built-in skill is discoverable and inserts a typed Codex marker", async ({
  page,
}) => {
  await page.goto("/?debug=agent-verify-skill&scenario=success", {
    waitUntil: "domcontentloaded",
  });

  const composer = page
    .locator('textarea[data-chat-composer-input="true"]')
    .first();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await composer.fill("/catalex");

  const skill = page.getByText("$catalex-verify-latex", { exact: true }).last();
  await expect(
    page.getByRole("heading", { name: "Catalex", exact: true }),
  ).toBeVisible();
  await expect(skill).toBeVisible();
  await page.screenshot({
    path: "test-results/agent-verify-skill-picker.png",
    fullPage: false,
  });
  await skill.click();
  await expect(composer).toHaveValue("$catalex-verify-latex ");

  await page.screenshot({
    path: "test-results/agent-verify-skill-harness.png",
    fullPage: false,
  });
});
