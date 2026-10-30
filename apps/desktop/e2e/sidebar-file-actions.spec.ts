import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page) {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("/?debug=sidebar-animation&trash-confirmation");
  await expect(page.locator('[data-sidebar-file-id="main.tex"]')).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(modulePath);
    const makeFile = (path: string) => ({
      id: path,
      relativePath: path,
      absolutePath: `/tmp/harness/${path}`,
      name: path.split("/").pop(),
      type: "tex",
      content: "Unsaved draft",
      isDirty: true,
    });
    useDocumentStore.setState({
      files: [makeFile("main.tex"), makeFile("chapters/nested/intro.tex")],
      folders: ["chapters", "chapters/nested", "empty"],
      moveFile: async (id: string, folder: string | null) => {
        const path = `${folder ? `${folder}/` : ""}main (1).tex`;
        useDocumentStore.setState((state: { files: { id: string }[] }) => ({
          files: state.files.map((file) =>
            file.id === id ? makeFile(path) : file,
          ),
        }));
        return path;
      },
    });
  });
}

async function drag(
  page: Page,
  source: string,
  target: string,
  release = true,
) {
  await page.locator(target).click({ trial: true });
  await page.locator(source).click({ trial: true });
  const from = (await page.locator(source).boundingBox())!;
  const to = (await page.locator(target).boundingBox())!;
  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 70, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + 65, to.y + to.height / 2, { steps: 15 });
  if (release) await page.mouse.up();
}

test("expanded nested folder wins drop and confirmed move reveals the actual destination", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-sidebar-folder-id="chapters"]').click();
  await page.locator('[data-sidebar-folder-id="chapters%2Fnested"]').click();
  await drag(
    page,
    '[data-sidebar-file-id="main.tex"]',
    '[data-sidebar-folder-id="chapters%2Fnested"]',
  );
  await expect(page.getByRole("dialog")).toContainText(
    "into 'chapters/nested'",
  );
  await page.getByRole("button", { name: "Move", exact: true }).click();
  const moved = page.locator(
    '[data-sidebar-file-id="chapters%2Fnested%2Fmain%20(1).tex"]',
  );
  await expect(moved).toBeInViewport();
  await expect(page.locator('[data-sidebar-file-id="main.tex"]')).toHaveCount(
    0,
  );
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await page.screenshot({
    path: "test-results/sidebar-file-move.png",
    animations: "disabled",
  });
});

test("collapsed destination opens after confirmation and cancellation leaves the file unchanged", async ({
  page,
}) => {
  await setup(page);
  await drag(
    page,
    '[data-sidebar-file-id="main.tex"]',
    '[data-sidebar-folder-id="empty"]',
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0);
  await expect(page.locator('[data-sidebar-file-id="main.tex"]')).toBeVisible();
  await drag(
    page,
    '[data-sidebar-file-id="main.tex"]',
    '[data-sidebar-folder-id="empty"]',
  );
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(
    page.locator('[data-sidebar-folder-id="empty"]'),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.locator('[data-sidebar-file-id="empty%2Fmain%20(1).tex"]'),
  ).toBeInViewport();
});

test("file context menu exposes file actions", async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => {
    const modulePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(modulePath);
    useDocumentStore.setState({ activeFileId: "chapters/nested/intro.tex" });
  });
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy file path" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: /Open in Finder|Open in file manager/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Send to chat" }),
  ).toBeVisible();
  await page.getByRole("menu").evaluate(async (menu) => {
    await Promise.all(
      menu
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: "test-results/sidebar-file-context-menu.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.locator('[data-sidebar-file-id="main.tex"]').click();
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy file path" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Send to chat" }),
  ).toHaveCount(0);
  await page.getByRole("menu").evaluate(async (menu) => {
    await Promise.all(
      menu
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
  });
  await page.screenshot({
    path: "test-results/sidebar-focused-file-menu.png",
    animations: "disabled",
  });
});

test("drop highlight stays inside the tree and right-click cancels an active drag", async ({
  page,
}) => {
  await setup(page);
  await page.locator('[data-sidebar-folder-id="chapters"]').click();
  await page.locator('[data-sidebar-folder-id="chapters%2Fnested"]').click();
  const target = page.locator('[data-drop-folder="chapters/nested"]');
  await drag(
    page,
    '[data-sidebar-file-id="main.tex"]',
    '[data-sidebar-folder-id="chapters%2Fnested"]',
    false,
  );
  await expect(target).toHaveClass(/ring-inset/);
  await expect
    .poll(() => target.evaluate((el) => getComputedStyle(el).boxShadow))
    .toContain("inset");
  await page.screenshot({
    path: "test-results/sidebar-drop-highlight.png",
    animations: "disabled",
  });
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.mouse.up();
  await expect(target).not.toHaveClass(/ring-inset/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('[data-sidebar-file-id="main.tex"]')).toBeVisible();
  // Cancellation resets the sensor, and normal right-click menus remain usable.
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Copy file path" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await drag(
    page,
    '[data-sidebar-file-id="main.tex"]',
    '[data-sidebar-folder-id="chapters%2Fnested"]',
  );
  await expect(page.getByRole("dialog")).toContainText(
    "into 'chapters/nested'",
  );
});

test("mouse wheel scrolls the tree through the drag preview without ending the drag", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(async () => {
    const modulePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(modulePath);
    useDocumentStore.setState({
      folders: Array.from(
        { length: 40 },
        (_, i) => `folder-${String(i).padStart(2, "0")}`,
      ),
    });
  });
  const source = '[data-sidebar-folder-id="folder-00"]';
  await drag(page, source, '[data-sidebar-folder-id="folder-01"]', false);
  const scroller = page.locator('[data-drop-folder="__root__"]');
  const before = await scroller.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before + 100);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/sidebar-drag-wheel.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-drop-folder].ring-inset")).toHaveCount(0);
});
