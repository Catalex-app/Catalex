import { expect, test, type Page } from "@playwright/test";

const names = ["A.md", "B.md", "C.md", "D.md", "E.md", "F.md", "G.md", "H.md"];

async function seedFiles(page: Page) {
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  await page.evaluate(async (names) => {
    const url = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore: store } = await import(/* @vite-ignore */ url);
    store.setState({
      files: names.toReversed().map((name: string) => ({
        id: name,
        name,
        relativePath: name,
        absolutePath: `/tmp/harness/${name}`,
        type: "other",
        content: `# ${name}\n`,
        isDirty: false,
      })),
      activeFileId: "H.md",
      openFileIds: ["H.md"],
    });
  }, names);
}

async function select(page: Page, name: string) {
  await page.getByRole("combobox", { name: "Choose file" }).click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Choose file" }),
  ).toContainText(name);
}

test("keeps recent slots stable, evicts the least used file, and persists across reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=input-transfer");
  await page.addStyleTag({
    content: "[data-input-transfer-harness-overlay] { display: none; }",
  });
  await seedFiles(page);
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const trigger = page.getByRole("combobox", { name: "Choose file" });
  await trigger.click();
  await expect(page.getByRole("option")).toHaveText(names);
  await expect(page.locator('[data-slot="select-separator"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  for (const name of ["E.md", "B.md", "D.md", "A.md", "C.md", "B.md"])
    await select(page, name);
  await trigger.click();
  await expect(
    page.getByRole("group", { name: "Recent files" }).getByRole("option"),
  ).toHaveText(["E.md", "B.md", "D.md", "A.md", "C.md"]);
  await page.keyboard.press("Escape");
  await select(page, "F.md");
  await trigger.click();
  const recent = page
    .getByRole("group", { name: "Recent files" })
    .getByRole("option");
  await expect(recent).toHaveText(["B.md", "D.md", "A.md", "C.md", "F.md"]);
  await expect(
    page.getByRole("group", { name: "Other files" }).getByRole("option"),
  ).toHaveText(["E.md", "G.md", "H.md"]);
  await expect(page.locator('[data-slot="select-separator"]')).toHaveCount(1);
  await expect(page.getByRole("listbox")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "../../output/playwright/recent-files-light.png",
  });
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await page.screenshot({
    path: "../../output/playwright/recent-files-dark.png",
  });
  // Arrow navigation traverses the recent group and separator into other files.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toContainText("G.md");
  await trigger.click();
  await expect(recent).toHaveText(["B.md", "A.md", "C.md", "F.md", "G.md"]);
  await page.keyboard.press("Escape");

  await page.reload();
  await page.addStyleTag({
    content: "[data-input-transfer-harness-overlay] { display: none; }",
  });
  await seedFiles(page);
  await trigger.click();
  await expect(recent).toHaveText(["B.md", "A.md", "C.md", "F.md", "G.md"]);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 900, height: 750 });
  await trigger.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("listbox")).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: "../../output/playwright/recent-files-narrow.png",
  });
  await page.keyboard.press("Escape");

  // A removed file is omitted immediately without leaving a stale option.
  await page.evaluate(async () => {
    const url = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore: store } = await import(/* @vite-ignore */ url);
    store.setState((state: any) => ({
      files: state.files.filter((file: any) => file.id !== "B.md"),
    }));
  });
  await trigger.click();
  await expect(recent).toHaveText(["A.md", "C.md", "F.md", "G.md"]);
  await expect(
    page.getByRole("option", { name: "B.md", exact: true }),
  ).toHaveCount(0);
});
