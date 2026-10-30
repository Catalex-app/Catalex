import { expect, test } from "@playwright/test";

test("credential demo supports host variants and simulated retry", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1000, height: 760 });
  await page.goto("/?debug=git-credentials");
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Update credentials");
  await expect(dialog.getByLabel("Username", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Save and retry" }),
  ).toBeDisabled();
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/git-credential-overleaf.png",
  });
  await dialog.getByRole("button", { name: "Show git command" }).click();
  await expect(dialog.getByTestId("git-command-preview")).toContainText(
    "git push origin main",
  );
  await dialog.getByLabel("Access token").fill("demo-token");
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Authentication failed",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "GitHub", exact: true }).click();
  await expect(dialog.getByLabel("Username", { exact: true })).toHaveValue(
    "alex",
  );
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/git-credential-github.png",
  });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Simulate rejected credentials").uncheck();
  await page.getByLabel("Dark appearance").check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "git.example.org", exact: true })
    .click();
  await dialog.getByLabel("Username", { exact: true }).fill("alex");
  await dialog.getByLabel("Access token").fill("demo-token");
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    animations: "disabled",
    path: "test-results/git-credential-dark-mobile.png",
  });
  await dialog.getByRole("button", { name: "Save and retry" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Demo complete");
});
