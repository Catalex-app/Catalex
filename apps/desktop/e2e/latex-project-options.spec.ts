import { expect, test } from "@playwright/test";

test("LaTeX project pickers show defaults, scope files, persist, and flag missing choices", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-preview");
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves application modules to this browser harness.
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const state = useDocumentStore.getState();
    const main = state.files[0];
    useDocumentStore.setState({
      folders: ["paper", "archive"],
      files: [
        ...state.files,
        ...["paper/main.tex", "paper/article.tex", "archive/old.tex"].map(
          (id) => ({
            ...main,
            id,
            relativePath: id,
            name: id.split("/").pop(),
            absolutePath: `${state.projectRoot}/${id}`,
          }),
        ),
      ],
    });
  });
  const open = async () => {
    const menu = page.getByRole("menu", { name: "Compilation options" });
    if (
      !(await menu.count()) ||
      (await menu.getAttribute("data-state")) !== "open"
    )
      await page.getByRole("button", { name: "Compilation options" }).click();
    await expect(menu).toHaveAttribute("data-state", "open");
  };
  await open();
  await expect(
    page.getByRole("menuitem", { name: "LaTeX root Project folder" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Main file Auto: main.tex" }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../output/playwright/latex-project-defaults.png",
  });
  await page.getByRole("menuitem", { name: /^LaTeX root/ }).hover();
  await page.getByRole("menuitemradio", { name: "paper", exact: true }).click();
  await expect(
    page.getByRole("menuitemradio", { name: "paper", exact: true }),
  ).toBeChecked();
  await page.getByRole("menuitem", { name: /^Main file/ }).hover();
  await expect(
    page.getByRole("menuitemradio", { name: "article.tex", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitemradio", { name: "archive/old.tex", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../output/playwright/latex-project-files.png",
  });
  await page
    .getByRole("menuitemradio", { name: "article.tex", exact: true })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "article.tex", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("menuitem", { name: "Main file paper/article.tex" }),
  ).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.waitForTimeout(350);
  await page.screenshot({
    path: "../../output/playwright/latex-project-dark.png",
  });
  await page.reload();
  await expect(page.getByTestId("pdf-preview-harness-shell")).toHaveAttribute(
    "data-compile-phase",
    "succeeded",
  );
  await open();
  await expect(
    page.getByRole("menuitem", { name: "LaTeX root paper (missing)" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", {
      name: "Main file paper/article.tex (missing)",
    }),
  ).toBeVisible();
});

for (const side of ["right", "left"] as const) {
  test(`dropdown submenus leave a gap when opening to the ${side}`, async ({
    page,
  }) => {
    await page.goto("/?debug=pdf-preview");
    const options = page.getByRole("button", { name: "Compilation options" });
    if (side === "left") {
      // Place the trigger near the viewport edge to exercise collision handling.
      await options.evaluate((button) =>
        Object.assign(button.style, {
          position: "fixed",
          top: "80px",
          right: "240px",
        }),
      );
    }
    await options.press("ArrowDown");
    const parent = page.getByRole("menu", { name: "Compilation options" });
    await parent.getByRole("menuitem", { name: /^Main file/ }).hover();
    const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]');
    await expect(submenu).toHaveAttribute("data-side", side);
    const outer = (await parent.boundingBox())!;
    const inner = (await submenu.boundingBox())!;
    const gap =
      side === "left"
        ? outer.x - (inner.x + inner.width)
        : inner.x - (outer.x + outer.width);
    expect(gap).toBeCloseTo(4, 0);
  });
}
