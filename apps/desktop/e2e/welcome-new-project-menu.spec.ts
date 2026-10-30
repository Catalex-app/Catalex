import { expect, test } from "@playwright/test";

// These tests cover returning-user creation flows, not first-run onboarding.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "catalex-onboarding",
      JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
    );
  });
});

async function enableProjectActions(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const [{ useClaudeSetupStore }, { useCodexSetupStore }] = await Promise.all(
      [
        import("/src/renderer/stores/claude-setup-store.ts"),
        import("/src/renderer/stores/codex-setup-store.ts"),
      ],
    );
    useClaudeSetupStore.setState({
      status: "ready",
      version: "test",
      accountEmail: "test@example.com",
    });
    useCodexSetupStore.setState({
      status: "ready",
      version: "test",
      accountLabel: "test",
    });
  });
}

async function setWelcomeAnimationTime(
  page: import("@playwright/test").Page,
  currentTime: number,
) {
  await page.evaluate((time) => {
    for (const animation of document.getAnimations()) {
      const animationName =
        "animationName" in animation ? String(animation.animationName) : "";
      if (!animationName.startsWith("welcome-empty-")) continue;
      animation.pause();
      animation.currentTime = time;
    }
  }, currentTime);
}

test("shows the consolidated new-project menu below the welcome cat", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#loading-screen").waitFor({ state: "detached" });
  await enableProjectActions(page);

  const trigger = page.getByTestId("welcome-new-project-menu-trigger");
  await expect(trigger).toBeEnabled();
  await expect(page.getByTestId("welcome-empty-projects")).toBeVisible();
  await expect(page.getByTestId("welcome-empty-project-arrow")).toBeVisible();
  await expect(page.getByTestId("welcome-empty-project-note")).toHaveText(
    "Start a new projectfrom here",
  );
  const animationDelays = await page.evaluate(() => {
    const selectors = [
      '[data-testid="welcome-empty-project-arrow-stroke"]',
      '[data-testid="welcome-empty-project-arrow-head-upper"]',
      '[data-testid="welcome-empty-project-arrow-head-lower"]',
      '[data-testid="welcome-empty-project-note-line-first"]',
      '[data-testid="welcome-empty-project-note-line-second"]',
    ];

    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing animated element: ${selector}`);
      return getComputedStyle(element).animationDelay;
    });
  });
  expect(animationDelays).toEqual([
    "0.35s",
    "1.05s",
    "1.11s",
    "1.37s, 1.99s",
    "2.03s, 2.39s",
  ]);

  await setWelcomeAnimationTime(page, 300);
  await expect(
    page.getByTestId("welcome-empty-project-arrow-stroke"),
  ).toHaveCSS("opacity", "0");

  await setWelcomeAnimationTime(page, 400);
  await expect(
    page.getByTestId("welcome-empty-project-arrow-stroke"),
  ).toHaveCSS("opacity", "1");

  await setWelcomeAnimationTime(page, 400);
  await expect(
    page.getByTestId("welcome-empty-project-arrow-head-upper"),
  ).toHaveCSS("opacity", "0");
  await expect(
    page.getByTestId("welcome-empty-project-arrow-head-lower"),
  ).toHaveCSS("opacity", "0");

  await setWelcomeAnimationTime(page, 1080);
  await expect(
    page.getByTestId("welcome-empty-project-arrow-head-upper"),
  ).toHaveCSS("opacity", "1");
  await expect(
    page.getByTestId("welcome-empty-project-arrow-head-lower"),
  ).toHaveCSS("opacity", "0");

  await setWelcomeAnimationTime(page, 2500);
  await expect(
    page.getByTestId("welcome-empty-project-arrow-head-lower"),
  ).toHaveCSS("opacity", "1");
  await expect(page.getByRole("columnheader", { name: "Title" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("columnheader", { name: "Last Modified" }),
  ).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Actions" })).toHaveCount(
    0,
  );
  await trigger.click();

  await expect(
    page.getByRole("menuitem", { name: "Open Folder" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Choose Template" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Blank Document" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Import from Overleaf" }),
  ).toBeVisible();
  await expect(page.getByRole("menuitem")).toHaveText([
    "Open Folder",
    "Import from Overleaf",
    "Blank Document",
    "Choose Template",
  ]);
  const menu = page.getByRole("menu");
  const separators = menu.getByRole("separator");
  await expect(separators).toHaveCount(3);
  const separatorInsets = await menu.evaluate((menuElement) => {
    const menuBounds = menuElement.getBoundingClientRect();
    return Array.from(
      menuElement.querySelectorAll('[role="separator"]'),
      (separator) => {
        const bounds = separator.getBoundingClientRect();
        return {
          left: bounds.left - menuBounds.left,
          right: menuBounds.right - bounds.right,
        };
      },
    );
  });
  expect(
    separatorInsets.every(({ left, right }) => left >= 8 && right >= 8),
  ).toBe(true);
  const menuRowGaps = await page.getByRole("menuitem").evaluateAll((items) =>
    items.slice(1).map((item, index) => {
      const previousBounds = items[index].getBoundingClientRect();
      const bounds = item.getBoundingClientRect();
      return bounds.top - previousBounds.bottom;
    }),
  );
  expect(menuRowGaps.every((gap) => gap >= 3)).toBe(true);

  await page.evaluate(async () => {
    const { ensureDesktopBrowserMocks } = await import(
      "/src/renderer/dev/desktop-browser-mocks.ts"
    );
    ensureDesktopBrowserMocks();

    type TauriInternals = {
      invoke: (
        command: string,
        args?: unknown,
        options?: unknown,
      ) => Promise<unknown>;
    };
    const internals = (
      window as Window & { __TAURI_INTERNALS__: TauriInternals }
    ).__TAURI_INTERNALS__;
    const originalInvoke = internals.invoke;
    internals.invoke = async (command, args, options) => {
      const record = (args ?? {}) as Record<string, unknown>;
      if (command === "plugin:path|resolve_directory") return "/Users/test";
      if (command === "plugin:path|join") {
        return (record.paths as string[]).join("/").replace(/\/+/g, "/");
      }
      return originalInvoke(command, args, options);
    };
  });
  await page.getByRole("menuitem", { name: "Blank Document" }).click();
  const blankProjectDialog = page.getByRole("dialog", {
    name: "Blank project",
  });
  await expect(blankProjectDialog).toBeVisible();
  await expect(page.getByTestId("welcome-empty-projects")).toBeVisible();
  await expect(
    blankProjectDialog.getByRole("checkbox", { name: "Initialize Git" }),
  ).toBeChecked();
  await expect(
    blankProjectDialog.getByRole("button", { name: "Choose" }),
  ).toBeVisible();
  await expect(blankProjectDialog.getByLabel("Name")).toHaveValue(
    /New Project \d{8}/,
  );
  await expect(blankProjectDialog.getByLabel("Local Path")).toHaveValue(
    "/Users/test/Documents/Catalex",
  );
  await expect(
    blankProjectDialog.getByText(/The project will be created at/),
  ).toContainText("/Users/test/Documents/Catalex/New Project");
  await expect(
    blankProjectDialog.getByText("Create a blank document"),
  ).toHaveCount(0);
  await expect(
    blankProjectDialog.getByText(
      "The folder will contain only the new main.tex file.",
    ),
  ).toHaveCount(0);
  const controlRadii = await Promise.all([
    blankProjectDialog
      .getByLabel("Local Path")
      .evaluate((element) => getComputedStyle(element).borderRadius),
    blankProjectDialog
      .getByRole("button", { name: "Choose" })
      .evaluate((element) => getComputedStyle(element).borderRadius),
  ]);
  expect(controlRadii[0]).toBe(controlRadii[1]);
  await expect(blankProjectDialog).toHaveCSS("border-radius", "20px");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/blank-project-dialog.png",
    fullPage: true,
  });
  await page
    .locator('[data-slot="dialog-overlay"]')
    .click({ position: { x: 10, y: 10 }, force: true });
  await expect(blankProjectDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(blankProjectDialog).toBeHidden();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Blank Document" }).click();
  await expect(blankProjectDialog).toBeVisible();
  await blankProjectDialog.getByRole("button", { name: "Close" }).click();
  await expect(blankProjectDialog).toBeHidden();
  await expect(page.getByTestId("welcome-empty-projects")).toBeVisible();

  await trigger.click();
  await page.getByRole("menuitem", { name: "Import from Overleaf" }).click();
  const overleafDialog = page.getByRole("dialog", {
    name: "Import from Overleaf",
  });
  await expect(overleafDialog).toBeVisible();
  await expect(overleafDialog.getByLabel("Access Token")).toHaveValue("");
  await expect(overleafDialog.getByLabel("Access Token")).toHaveAttribute(
    "placeholder",
    "Paste your Overleaf access token",
  );
  await page.keyboard.press("Escape");
  await expect(overleafDialog).toBeHidden();

  await setWelcomeAnimationTime(page, 2500);
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();

  await expect
    .poll(() =>
      page
        .getByTestId("welcome-empty-project-note-line-second")
        .evaluate((element) => getComputedStyle(element).clipPath),
    )
    .toBe("none");
  await page.waitForTimeout(250);
  const catBounds = await page.getByAltText("Catalex cat leaf").boundingBox();
  const triggerBounds = await trigger.boundingBox();
  const menuBounds = await page.getByRole("menu").boundingBox();
  expect(catBounds).not.toBeNull();
  expect(triggerBounds).not.toBeNull();
  expect(menuBounds).not.toBeNull();
  expect(
    Math.abs(menuBounds!.width - triggerBounds!.width),
  ).toBeLessThanOrEqual(1);
  expect(triggerBounds!.y).toBeGreaterThanOrEqual(
    catBounds!.y + catBounds!.height,
  );

  await page.screenshot({
    path: "test-results/welcome-new-project-menu.png",
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const { useProjectStore } = await import(
      "/src/renderer/stores/project-store.ts"
    );
    useProjectStore.getState().addRecentProject("/tmp/Welcome Test Project");
  });
  await expect(page.getByTestId("welcome-empty-projects")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Title" })).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Last Modified" }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Actions" }),
  ).toBeVisible();
});

test("creates only main.tex and initializes Git for a blank project", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#loading-screen").waitFor({ state: "detached" });
  await enableProjectActions(page);

  await page.evaluate(async () => {
    const { ensureDesktopBrowserMocks } = await import(
      "/src/renderer/dev/desktop-browser-mocks.ts"
    );
    ensureDesktopBrowserMocks();

    type Harness = {
      gitRoots: string[];
      madeDirectories: string[];
      writtenFiles: Array<{ path: string; content: string }>;
    };
    type TauriInternals = {
      invoke: (
        command: string,
        args?: unknown,
        options?: { headers?: Record<string, string> },
      ) => Promise<unknown>;
    };

    const win = window as Window & {
      __TAURI_INTERNALS__: TauriInternals;
      __blankProjectHarness?: Harness;
    };
    const originalInvoke = win.__TAURI_INTERNALS__.invoke;
    const harness: Harness = {
      gitRoots: [],
      madeDirectories: [],
      writtenFiles: [],
    };
    win.__blankProjectHarness = harness;

    win.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      const record = (args ?? {}) as Record<string, unknown>;

      if (command === "plugin:path|resolve_directory") return "/Users/test";
      if (command === "plugin:path|join") {
        return (record.paths as string[]).join("/").replace(/\/+/g, "/");
      }
      if (command === "plugin:dialog|open") {
        return "/tmp/finder-picked-project";
      }
      if (command === "plugin:fs|mkdir") {
        harness.madeDirectories.push(String(record.path));
        return null;
      }
      if (command === "plugin:fs|exists") return false;
      if (command === "git_project_init") {
        harness.gitRoots.push(String(record.projectRoot));
        return null;
      }
      if (command === "plugin:fs|write_text_file") {
        const encodedPath = options?.headers?.path ?? "";
        harness.writtenFiles.push({
          path: decodeURIComponent(encodedPath),
          content: new TextDecoder().decode(args as Uint8Array),
        });
        return null;
      }
      if (command === "prepare_project_storage") return null;
      if (command === "plugin:fs|read_dir") {
        return [
          {
            name: "main.tex",
            isDirectory: false,
            isFile: true,
            isSymlink: false,
          },
        ];
      }
      if (command === "plugin:fs|read_text_file") {
        return "\\documentclass{article}\n\\begin{document}\n\\end{document}\n";
      }
      return originalInvoke(command, args, options);
    };
  });

  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Blank Document" }).click();

  const dialog = page.getByRole("dialog", {
    name: "Blank project",
  });
  const name = dialog.getByLabel("Name");
  const localPath = dialog.getByLabel("Local Path");
  const initializeGit = dialog.getByRole("checkbox", {
    name: "Initialize Git",
  });

  await expect(name).toHaveValue(/New Project \d{8}/);
  await expect(localPath).toHaveValue("/Users/test/Documents/Catalex");
  await expect(initializeGit).toBeChecked();
  await initializeGit.click();
  await expect(initializeGit).not.toBeChecked();
  await initializeGit.click();
  await expect(initializeGit).toBeChecked();

  await dialog.getByRole("button", { name: "Choose" }).click();
  await expect(localPath).toHaveValue("/tmp/finder-picked-project");
  await name.fill("Typed Blank Project");
  await localPath.fill("/tmp/typed-projects");
  await expect(
    dialog.getByText(/The project will be created at/),
  ).toContainText("/tmp/typed-projects/Typed Blank Project");
  await dialog.getByRole("button", { name: "Create Project" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __blankProjectHarness?: { gitRoots: string[] };
            }
          ).__blankProjectHarness?.gitRoots ?? [],
      ),
    )
    .toContain("/tmp/typed-projects/Typed Blank Project");

  const creation = await page.evaluate(
    () =>
      (
        window as Window & {
          __blankProjectHarness?: {
            madeDirectories: string[];
            writtenFiles: Array<{ path: string; content: string }>;
          };
        }
      ).__blankProjectHarness,
  );
  expect(creation?.madeDirectories).toContain(
    "/tmp/typed-projects/Typed Blank Project",
  );
  expect(creation?.writtenFiles).toHaveLength(1);
  expect(creation?.writtenFiles[0].path).toBe(
    "/tmp/typed-projects/Typed Blank Project/main.tex",
  );
  expect(creation?.writtenFiles[0].content).toContain(
    "\\documentclass[12pt]{article}",
  );
});

test("clones an Overleaf Git project from the redesigned dialog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1120, height: 780 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator("#loading-screen").waitFor({ state: "detached" });
  await enableProjectActions(page);

  await page.evaluate(async () => {
    const { ensureDesktopBrowserMocks } = await import(
      "/src/renderer/dev/desktop-browser-mocks.ts"
    );
    ensureDesktopBrowserMocks();

    type CloneRequest = {
      cloneCommand: string;
      accessToken: string;
      localName: string;
      localPath: string;
    };
    type TauriInternals = {
      invoke: (
        command: string,
        args?: unknown,
        options?: unknown,
      ) => Promise<unknown>;
    };
    const win = window as Window & {
      __TAURI_INTERNALS__: TauriInternals;
      __overleafCloneRequests?: CloneRequest[];
    };
    const originalInvoke = win.__TAURI_INTERNALS__.invoke;
    win.__overleafCloneRequests = [];
    win.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      const record = (args ?? {}) as Record<string, unknown>;
      if (command === "plugin:path|resolve_directory") return "/Users/test";
      if (command === "plugin:path|join") {
        return (record.paths as string[]).join("/").replace(/\/+/g, "/");
      }
      if (command === "plugin:dialog|open") return "/tmp/overleaf-projects";
      if (command === "git_overleaf_token_detect") return "saved-token";
      if (command === "git_overleaf_clone") {
        win.__overleafCloneRequests?.push(record as CloneRequest);
        return {
          projectPath: "/tmp/typed-overleaf/Overleaf Paper",
          credentialWarning: null,
        };
      }
      if (command === "prepare_project_storage") return null;
      if (command === "plugin:fs|read_dir") {
        return [
          {
            name: "main.tex",
            isDirectory: false,
            isFile: true,
            isSymlink: false,
          },
        ];
      }
      if (command === "plugin:fs|read_text_file") {
        return "\\documentclass{article}\n\\begin{document}\n\\end{document}\n";
      }
      return originalInvoke(command, args, options);
    };
  });

  await page.getByTestId("welcome-new-project-menu-trigger").click();
  await page.getByRole("menuitem", { name: "Import from Overleaf" }).click();

  const dialog = page.getByRole("dialog", { name: "Import from Overleaf" });
  const cloneCommand = dialog.getByLabel("Git Clone Command");
  const accessToken = dialog.getByLabel("Access Token");
  const localName = dialog.getByLabel("Local Name");
  const localPath = dialog.getByLabel("Local Path");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("border-radius", "20px");
  await expect(cloneCommand).toHaveAttribute(
    "placeholder",
    "git clone https://git@git.overleaf.com/....",
  );
  await expect(accessToken).toHaveValue("saved-token");
  await expect(dialog.getByText("Existing token found")).toBeVisible();
  await expect(localPath).toHaveValue("/Users/test/Documents/Catalex");
  await expect(dialog.getByText(/The project will be cloned to/)).toContainText(
    "—",
  );

  await cloneCommand.fill(
    "git clone https://git@git.overleaf.com/6a60d23e3849ddde7938c854",
  );
  await expect(localName).toHaveValue("6a60d23e3849ddde7938c854");
  await expect(dialog.getByText(/The project will be cloned to/)).toContainText(
    "/Users/test/Documents/Catalex/6a60d23e3849ddde7938c854",
  );
  await localName.fill("Overleaf Paper");
  await expect(dialog.getByText(/The project will be cloned to/)).toContainText(
    "/Users/test/Documents/Catalex/Overleaf Paper",
  );
  await dialog.getByRole("button", { name: "Choose" }).click();
  await expect(localPath).toHaveValue("/tmp/overleaf-projects");
  await localPath.fill("/tmp/typed-overleaf");
  await page.waitForTimeout(250);
  await page.screenshot({
    path: "test-results/overleaf-clone-dialog.png",
    fullPage: true,
  });

  await page
    .locator('[data-slot="dialog-overlay"]')
    .click({ position: { x: 10, y: 10 }, force: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clone Project" }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __overleafCloneRequests?: Array<Record<string, string>>;
            }
          ).__overleafCloneRequests ?? [],
      ),
    )
    .toEqual([
      {
        cloneCommand:
          "git clone https://git@git.overleaf.com/6a60d23e3849ddde7938c854",
        accessToken: "saved-token",
        localName: "Overleaf Paper",
        localPath: "/tmp/typed-overleaf",
      },
    ]);
  await expect(dialog).toBeHidden();
});
