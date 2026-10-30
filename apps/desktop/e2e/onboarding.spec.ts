import { expect, test } from "@playwright/test";

const demo = process.env.CATALEX_ONBOARDING_DEMO_URL ?? "/?onboarding-demo";
test("fullscreen onboarding persists choices and enters the full app", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(demo);
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Welcome to Catalex." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/onboarding-welcome.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Let’s get started" }).click();
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.screenshot({
    path: "test-results/onboarding-theme.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("pdfTeX 3.141592653 (TeX Live 2025)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Installation folder" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("/Library/TeX/texbin");
  await page.screenshot({
    path: "test-results/onboarding-installation.png",
    fullPage: true,
  });
  await page.getByRole("combobox", { name: "LaTeX installation" }).click();
  await page.getByRole("option", { name: /MiKTeX/ }).click();
  await expect(page.getByText("MiKTeX demo", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "LaTeX installation" }),
  ).toContainText("MiKTeX");
  await page.getByRole("combobox", { name: "LaTeX installation" }).click();
  await page.getByRole("option", { name: /MacTeX/ }).click();
  await page.getByRole("tab", { name: /Tectonic/ }).click();
  await page.getByRole("switch", { name: "Default backend" }).click();
  await page.getByRole("tab", { name: /Claude/ }).click();
  await page.getByRole("switch", { name: "Default provider" }).click();
  await page
    .getByRole("combobox", { name: "Default model", exact: true })
    .click();
  await page.getByRole("option", { name: "Sonnet", exact: true }).click();
  await page.getByRole("combobox", { name: "Thinking level" }).click();
  await page.getByRole("option", { name: "High", exact: true }).click();
  await page.screenshot({
    path: "test-results/onboarding-dependencies.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Cat display", exact: true })
    .click();
  await page.getByRole("option", { name: "Static", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Cat’s message", exact: true })
    .click();
  await page.getByRole("option", { name: "Custom", exact: true }).click();
  await page
    .getByLabel("Your message", { exact: true })
    .pressSequentially("One idea at a time.");
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    "One idea at a time.",
  );
  await page.reload();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Ah, almost forgot." }),
  ).toBeVisible();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    "One idea at a time.",
  );
  await page.screenshot({
    path: "test-results/onboarding-cat.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Start writing", exact: true })
    .click();
  await expect(page.getByTestId("onboarding")).toHaveCount(0);
  await page.getByRole("button", { name: "Open sample project" }).click();
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page.screenshot({
    path: "test-results/onboarding-workspace.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("missing dependencies can be skipped and compact screens remain usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 700 });
  await page.goto(demo);
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await page.getByLabel("Dependency scenario").selectOption("missing");
  await page.getByRole("button", { name: "Let’s get started" }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: /^(Recheck|Check again)$/ })
    .first()
    .click();
  await expect(
    page.getByText(/Install LaTeX for broad package support/),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Default backend" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "Preferred engine" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/onboarding-missing.png",
    fullPage: true,
  });
  await page.getByRole("tab", { name: /Claude Code/ }).click();
  await expect(
    page.getByText("Claude CLI not found", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/onboarding-claude-missing.png",
    fullPage: true,
  });
  await expect(
    page.getByRole("link", { name: "Install Claude CLI" }),
  ).toHaveAttribute("href", "https://code.claude.com/docs/en/setup");
  await page.getByRole("tab", { name: /Codex/ }).click();
  await expect(
    page.getByRole("link", { name: "Install Codex CLI" }),
  ).toHaveAttribute("href", "https://developers.openai.com/codex/cli/");
  const continueWithoutAgent = page.getByRole("button", {
    name: "Continue (no agent available)",
    exact: true,
  });
  await continueWithoutAgent.scrollIntoViewIfNeeded();
  await expect(continueWithoutAgent).toHaveAttribute("data-variant", "outline");
  await page.screenshot({
    path: "test-results/onboarding-no-agent-footer.png",
    fullPage: true,
  });
  const installLink = page.getByRole("link", { name: /Install MacTeX/ });
  await page.route("https://tug.org/mactex/mactex-download.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Download destination</h1>",
    }),
  );
  await installLink.click();
  await expect(page).toHaveURL("https://tug.org/mactex/mactex-download.html");
  await page.goBack();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await page.reload();
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(page.getByTestId("onboarding")).toHaveCount(0);
});

test("appearance preview follows settings and switches example files", async ({
  page,
}) => {
  await page.goto(demo);
  await page.getByRole("button", { name: "Let’s get started" }).click();
  const editor = page.getByTestId("onboarding-preview-editor");
  await expect(editor).toContainText("documentclass");
  await page.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(editor).toContainText("Notes for our next paper");
  await expect(editor.locator(".cm-content")).toHaveAttribute(
    "aria-readonly",
    "true",
  );
  await page.getByRole("button", { name: "paper.tex", exact: true }).click();
  await expect(editor).toContainText("documentclass");
  await page.getByRole("combobox", { name: "Editor color scheme" }).click();
  await page.getByRole("option", { name: "Ocean", exact: true }).click();
  await page
    .locator('[data-settings-row-id="onboarding-font-size"]')
    .getByRole("button")
    .click();
  await page.getByRole("option", { name: "18px", exact: true }).click();
  await expect(editor.locator(".cm-editor")).toHaveCSS("font-size", "18px");
  await page
    .locator('[data-settings-row-id="onboarding-solarize"]')
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "Med", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/solar-mode/);
  await page.getByRole("button", { name: "paper.tex", exact: true }).click();
  await page.screenshot({ path: "test-results/onboarding-preview-light.png" });
  await page.getByRole("combobox", { name: "Appearance", exact: true }).click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  // Allow the shared controls' theme transitions to settle for visual inspection.
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/onboarding-preview-dark.png" });
});

test("large screens cap the preview without a breakpoint width jump", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(demo);
  await page.getByRole("button", { name: "Let’s get started" }).click();
  const preview = page.getByRole("region", {
    name: "Workspace preview",
    exact: true,
  });
  await expect(page.getByTestId("onboarding-frame")).toHaveCSS(
    "width",
    "1536px",
  );
  await expect(page.getByTestId("onboarding-frame")).toHaveCSS(
    "height",
    "720px",
  );
  await expect(preview).toHaveCSS("width", "1036px");
  await expect(preview).toHaveCSS("justify-self", "center");
  await page.screenshot({ path: "test-results/onboarding-large.png" });
  await page.setViewportSize({ width: 1535, height: 900 });
  await expect(preview).toHaveCSS("width", "1035px");
  await page.setViewportSize({ width: 1536, height: 900 });
  await expect(preview).toHaveCSS("width", "1036px");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(preview).toHaveCSS("width", "780px");
});
