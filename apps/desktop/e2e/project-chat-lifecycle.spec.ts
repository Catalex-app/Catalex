import { expect, test } from "@playwright/test";

for (const provider of ["codex", "claude"]) {
  test(`${provider} restores a paused conversation after welcome and reload`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/?debug=agent-pause&provider=${provider}`);
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    await page.getByRole("button", { name: "Back to welcome" }).click();
    await expect(
      page.getByRole("button", { name: "Pausing and saving…" }),
    ).toBeDisabled();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await expect(page.getByTestId("provider-calls")).toContainText(
      `cancel_${provider}_execution`,
    );
    await page.getByRole("button", { name: "Reopen project" }).click();
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await page.getByRole("textbox").fill("My next instruction");
    await page.getByRole("button", { name: "Back to welcome" }).click();
    await expect(page.getByTestId("welcome")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("pause-status")).toHaveText("paused");
    await expect(page.getByRole("textbox")).toHaveValue("My next instruction");
    await expect(
      page.getByText("Review the introduction and improve its clarity.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator("#loading-screen")).toHaveCount(0);
    await page.screenshot({ path: `/tmp/catalex-${provider}-restored.png` });
    await page.getByRole("textbox").fill("");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByTestId("provider-calls")).toContainText(
      `resume_${provider}_code (native-session)`,
    );
    await expect(page.getByTestId("pause-status")).toHaveText("working");
    expect(errors).toEqual([]);
  });
}
