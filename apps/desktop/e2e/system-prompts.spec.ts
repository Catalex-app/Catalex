import { expect, test, type Page } from "@playwright/test";

const editor = (page: Page) =>
  page.locator(".cm-content[contenteditable=true]").first();

async function promptsSection(page: Page) {
  await page.goto("/?onboarding-demo&project");
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  const section = page.locator('[data-sidebar-section="system-prompts"]');
  const toggle = section.getByRole("button", {
    name: "System Prompts",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  return section;
}

test("instruction rows follow enabled providers without Global controls", async ({
  page,
}) => {
  const section = await promptsSection(page);
  for (const providers of [
    { claude: true, codex: false, pi: false },
    { claude: false, codex: true, pi: false },
    { claude: false, codex: false, pi: true },
    { claude: true, codex: true, pi: true },
    { claude: false, codex: false, pi: false },
  ]) {
    await page.evaluate(async (enabledProviders) => {
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      useSettingsStore.setState({ enabledProviders });
    }, providers);
    await expect(
      section.getByRole("button", { name: "Create AGENTS.md", exact: true }),
    ).toHaveCount(providers.codex || providers.pi ? 1 : 0);
    await expect(
      section.getByRole("button", { name: "Create CLAUDE.md", exact: true }),
    ).toHaveCount(providers.claude ? 1 : 0);
    await expect(section.getByRole("switch")).toHaveCount(0);
    if (providers.claude && providers.codex && providers.pi) {
      await expect(
        section.getByRole("button", { name: "Create AGENTS.md", exact: true }),
      ).toBeVisible();
      await expect(
        section.getByRole("button", { name: "Create CLAUDE.md", exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(250); // Capture after the section expansion settles.
      await page.screenshot({ path: "test-results/system-prompts-create.png" });
    }
  }
  await expect(section.locator("[data-sidebar-header-actions]")).toHaveCount(0);
  await expect(section.getByText("Global", { exact: true })).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Edit Global prompt", exact: true }),
  ).toHaveCount(0);
});

test("Create and Edit open root instruction files in the ordinary Markdown editor", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const section = await promptsSection(page);
  for (const fileName of ["AGENTS.md", "CLAUDE.md"]) {
    await section
      .getByRole("button", { name: `Create ${fileName}`, exact: true })
      .click();
    await expect(
      section.getByRole("button", { name: `Create ${fileName}`, exact: true }),
    ).toHaveCount(0);
    await expect(
      section.getByRole("button", { name: `Edit ${fileName}`, exact: true }),
    ).toBeVisible();
    await expect(
      page.locator('[data-editor-file-tab][data-active="true"]'),
    ).toContainText(fileName);
    await expect(page.getByTestId("markdown-editor-toolbar")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Reset", exact: true }),
    ).toHaveCount(0);
    await editor(page).fill(
      `# ${fileName}\n\nKeep these project instructions.`,
    );
    await editor(page).press("ControlOrMeta+s");
    await expect(
      page.frameLocator(`iframe[title="${fileName} preview"]`).locator("body"),
    ).toContainText("Keep these project instructions.");
    await section
      .getByRole("button", { name: `Edit ${fileName}`, exact: true })
      .click();
    await expect(editor(page)).toContainText(
      "Keep these project instructions.",
    );
    await expect(
      page.getByRole("button", { name: "Reset", exact: true }),
    ).toHaveCount(0);
  }
  const fileTree = page.locator('[data-sidebar-section="files"]');
  await fileTree.getByText("AGENTS.md", { exact: true }).click();
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("AGENTS.md");
  await expect(editor(page)).toContainText("Keep these project instructions.");
  await expect(section.getByRole("switch")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/system-prompts-instruction-files.png",
  });
  expect(errors).toEqual([]);
});

test("Global instructions require Edit and Save, preserve drafts, and synchronize saved changes", async ({
  page,
  context,
}) => {
  const openSettings = async (target: Page) => {
    await target.goto("/?debug=markdown-settings&section=agent");
    await expect(target.getByLabel("Global agent instructions")).toBeVisible();
  };
  await openSettings(page);
  const instructions = page.getByLabel("Global agent instructions");
  const section = page
    .locator('[data-settings-row-id="agent-global-instructions"]')
    .locator("../..");
  await expect(
    section.getByText("Global Instructions", { exact: true }),
  ).toBeVisible();
  const help = section.getByRole("button", {
    name: "About global instructions",
    exact: true,
  });
  await help.hover();
  await expect(page.getByRole("tooltip")).toHaveText(
    "Applied when a new chat starts.",
  );
  const headingBounds = await section
    .getByText("Global Instructions", { exact: true })
    .boundingBox();
  const helpBounds = await help.boundingBox();
  expect(
    helpBounds!.x - headingBounds!.x - headingBounds!.width,
  ).toBeGreaterThanOrEqual(0);
  expect(
    helpBounds!.x - headingBounds!.x - headingBounds!.width,
  ).toBeLessThanOrEqual(8);
  await page.screenshot({ path: "test-results/global-instructions-help.png" });
  await instructions.hover();
  await expect(instructions).toHaveJSProperty("readOnly", true);
  await expect(instructions).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  expect(
    await instructions.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--tw-shadow").trim(),
    ),
  ).toBe("0 0 #0000");
  await expect(section.getByText("Global", { exact: true })).toHaveCount(0);
  await expect(
    section.getByRole("button", { name: "Reset", exact: true }),
  ).toHaveCount(0);
  const rowBounds = await page
    .locator('[data-settings-row-id="agent-global-instructions"]')
    .boundingBox();
  const boxBounds = await instructions.boundingBox();
  expect(boxBounds!.width).toBeCloseTo(rowBounds!.width, 0);
  const initial = await instructions.inputValue();
  const saved = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("catalex-settings") ?? "{}").state
          .globalAgentPrompt,
    );
  const other = await context.newPage();
  await openSettings(other);
  await page
    .getByRole("button", { name: "Edit global instructions", exact: true })
    .click();
  await expect(instructions).toHaveJSProperty("readOnly", false);
  // Keyboard focus uses the app's shared inset line, without the old 3px halo.
  await page.keyboard.press("Shift+Tab");
  const saveButton = page.getByRole("button", {
    name: "Save global instructions",
    exact: true,
  });
  await expect(saveButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(instructions).toBeFocused();
  await expect(instructions).toHaveCSS("outline-style", "solid");
  await expect(instructions).toHaveCSS("outline-offset", "-3px");
  expect(
    await instructions.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--tw-ring-shadow").trim(),
    ),
  ).toBe("0 0 #0000");
  await instructions.fill("Unsaved instructions in the first window.");
  expect(await saved()).toBe(initial);
  await expect(other.getByLabel("Global agent instructions")).toHaveValue(
    initial,
  );
  await page.screenshot({ path: "test-results/global-instructions-edit.png" });

  await other
    .getByRole("button", { name: "Edit global instructions", exact: true })
    .click();
  await other
    .getByLabel("Global agent instructions")
    .fill("Saved by the second window.");
  await other
    .getByRole("button", { name: "Save global instructions", exact: true })
    .click();
  await expect.poll(saved).toBe("Saved by the second window.");
  await expect(instructions).toHaveValue(
    "Unsaved instructions in the first window.",
  );
  await page
    .getByRole("button", { name: "Save global instructions", exact: true })
    .click();
  await expect(instructions).toHaveJSProperty("readOnly", true);
  await expect(other.getByLabel("Global agent instructions")).toHaveValue(
    "Unsaved instructions in the first window.",
  );

  await page
    .getByRole("button", { name: "Edit global instructions", exact: true })
    .click();
  await section.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(instructions).toHaveValue(/Project Guidelines/);
  expect(await saved()).toBe("Unsaved instructions in the first window.");
  await page
    .getByRole("button", { name: "Save global instructions", exact: true })
    .click();
  await expect(instructions).toHaveJSProperty("readOnly", true);
  await expect(other.getByLabel("Global agent instructions")).toHaveValue(
    /Project Guidelines/,
  );
  await instructions.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/global-instructions-readonly.png",
  });
  await page
    .getByRole("button", { name: "Edit global instructions", exact: true })
    .click();
  await instructions.fill("Never saved.");
  await page.reload();
  await expect(page.getByLabel("Global agent instructions")).toHaveJSProperty(
    "readOnly",
    true,
  );
  await expect(page.getByLabel("Global agent instructions")).toHaveValue(
    /Project Guidelines/,
  );
  await other.close();
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await expect(instructions).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await instructions.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/global-instructions-readonly-dark.png",
  });
  await page
    .getByRole("button", { name: "Edit global instructions", exact: true })
    .click();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(instructions).toHaveCSS("outline-style", "solid");
  await page.screenshot({
    path: "test-results/global-instructions-edit-dark.png",
  });
});
