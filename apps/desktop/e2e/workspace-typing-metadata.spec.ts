import { expect, test } from "@playwright/test";

test("typing preserves dirty indicators, file switching, and tab close actions", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const state = useDocumentStore.getState();
    const main = state.files.find((file) => file.id === "main.tex")!;
    useDocumentStore.setState({
      files: [
        ...state.files,
        {
          ...main,
          id: "chapter.tex",
          name: "chapter.tex",
          relativePath: "chapter.tex",
          absolutePath: "/tmp/chapter.tex",
          content: "Chapter",
          isDirty: false,
        },
      ],
      openFileIds: ["main.tex", "chapter.tex"],
    });
  });
  const tabs = page.locator("[data-editor-toolbar]");
  await expect(
    tabs.getByRole("button", { name: "main.tex", exact: true }),
  ).toBeVisible();
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type("% typing test\n", { delay: 20 });
  await expect(
    tabs.getByRole("button", { name: "main.tex", exact: true }),
  ).toContainText("*");
  const sync = page.locator("[data-scroll-sync-muted]");
  await expect(sync).toHaveAttribute("data-scroll-sync-muted", "false");
  for (const include of [true, false]) {
    await page.evaluate(async (include) => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useDocumentStore.setState((state) => ({
        files: state.files.map((file) =>
          file.id === "main.tex"
            ? {
                ...file,
                content: include
                  ? `${file.content}\n\\input{chapter}`
                  : file.content!.replace("\n\\input{chapter}", ""),
              }
            : file,
        ),
      }));
    }, include);
    await expect(sync).toHaveAttribute(
      "data-scroll-sync-muted",
      String(include),
    );
  }
  await tabs.getByRole("button", { name: "chapter.tex", exact: true }).click();
  await expect(page.locator(".cm-content").first()).toContainText("Chapter");
  await tabs.getByRole("button", { name: "main.tex", exact: true }).click();
  await expect(page.locator(".cm-content").first()).toContainText(
    "typing test",
  );
  await tabs
    .getByRole("button", { name: "Close chapter.tex", exact: true })
    .click();
  await expect(
    tabs.getByRole("button", { name: "chapter.tex", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("workspace-tabs.png") });
});
