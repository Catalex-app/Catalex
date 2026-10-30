import { expect, test } from "@playwright/test";

test.describe("new project flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.goto("/?debug=new-project", {
      waitUntil: "domcontentloaded",
    });
  });

  test("renders the template PDF preview through the shared worker", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByRole("menuitem", { name: "Choose Template" }).click();
    await page
      .getByRole("button", { name: "Research Paper", exact: true })
      .click();
    const canvas = page.getByRole("dialog").locator("canvas");
    await expect(canvas).toBeVisible();
    await expect
      .poll(() =>
        canvas.evaluate((element: HTMLCanvasElement) => {
          const pixels = element
            .getContext("2d")!
            .getImageData(0, 0, element.width, element.height).data;
          let ink = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i + 3] > 0 && pixels[i] < 200) ink++;
          }
          return ink;
        }),
      )
      .toBeGreaterThan(500);
    await page.screenshot({
      path: "test-results/template-pdf-preview.png",
      fullPage: true,
      animations: "disabled",
    });
  });

  test("shows trusted template sources and both Overleaf transfer paths", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New Project" }).click();

    await page.getByRole("menuitem", { name: "Choose Template" }).click();
    await page.getByRole("button", { name: "Publisher & Overleaf" }).click();

    const discoveryDialog = page.getByRole("dialog", {
      name: "Publisher templates and Overleaf projects",
    });
    await expect(discoveryDialog).toBeVisible();
    await expect(
      discoveryDialog.getByRole("button", {
        name: "Open CTAN Conference Formats in your browser",
      }),
    ).toBeVisible();
    await expect(
      discoveryDialog.getByRole("button", {
        name: "Open IEEE Template Selector in your browser",
      }),
    ).toBeVisible();
    await expect(discoveryDialog.getByText("Free plan")).toBeVisible();
    await expect(discoveryDialog.getByText("Overleaf Premium")).toBeVisible();
    await expect(
      discoveryDialog.getByText(/never requests or stores your token/),
    ).toBeVisible();
    await expect(
      discoveryDialog.getByText(
        /links are omitted pending the linking permission/,
      ),
    ).toBeVisible();

    await discoveryDialog
      .getByRole("button", {
        name: "Open CTAN Conference Formats in your browser",
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__newProjectHarness?.openedUrls ?? []),
      )
      .toContain("https://ctan.org/topic/confproc");
    await expect(discoveryDialog).toBeVisible();

    const bounds = await discoveryDialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(780);
    await page.waitForTimeout(250);

    await page.screenshot({
      path: "test-results/new-project-template-discovery.png",
      fullPage: true,
    });

    await discoveryDialog.getByText("Clone with Git").scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await page.screenshot({
      path: "test-results/new-project-overleaf-transfer.png",
      fullPage: true,
    });

    await discoveryDialog.getByRole("button", { name: "Open Folder" }).click();
    await expect(discoveryDialog).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() => window.__newProjectHarness?.openFolderCount),
      )
      .toBe(1);
  });

  test("keeps trusted sources available from gallery search", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByRole("menuitem", { name: "Choose Template" }).click();

    await expect(page.getByText("Choose a Template")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publisher & Overleaf" }),
    ).toBeVisible();

    const search = page.getByPlaceholder(/Search Catalex templates/);
    await search.fill("venue-with-no-built-in-template");
    await expect(page.getByText("No Catalex templates found")).toBeVisible();
    await page.waitForTimeout(250);

    await page.screenshot({
      path: "test-results/new-project-gallery-empty-state.png",
      fullPage: true,
    });

    await page.getByRole("button", { name: "Browse trusted sources" }).click();
    await expect(
      page.getByRole("dialog", {
        name: "Publisher templates and Overleaf projects",
      }),
    ).toBeVisible();
  });

  test("keeps the discovery guide usable in a compact window", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 640 });
    await page.getByRole("button", { name: "New Project" }).click();
    await page.getByRole("menuitem", { name: "Choose Template" }).click();
    await page.getByRole("button", { name: "Sources" }).click();

    const discoveryDialog = page.getByRole("dialog", {
      name: "Publisher templates and Overleaf projects",
    });
    await expect(discoveryDialog).toBeVisible();

    const hasHorizontalOverflow = await discoveryDialog.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(hasHorizontalOverflow).toBe(false);

    const openFolderButton = discoveryDialog.getByRole("button", {
      name: "Open Folder",
    });
    await openFolderButton.scrollIntoViewIfNeeded();
    await expect(openFolderButton).toBeVisible();
    await page.waitForTimeout(250);

    await page.screenshot({
      path: "test-results/new-project-template-discovery-compact.png",
      fullPage: true,
    });
  });
});
