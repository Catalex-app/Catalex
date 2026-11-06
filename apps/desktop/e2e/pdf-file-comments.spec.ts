import { expect, type Page, test } from "@playwright/test";

async function openStandalonePdf(page: Page) {
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible({
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    const { useDocumentStore: doc, getPdfBytes } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const bytes = getPdfBytes("sample.tex");
    const host = (window as any).__TAURI_INTERNALS__;
    const invoke = host.invoke.bind(host);
    host.invoke = (command: string, args: any, ...rest: any[]) =>
      command === "plugin:fs|read_file" && args.path.endsWith("/paper.pdf")
        ? Promise.resolve(bytes)
        : invoke(command, args, ...rest);
    const file = {
      ...doc.getState().files.find((file: any) => file.id === "sample.tex"),
      id: "paper.pdf",
      name: "paper.pdf",
      relativePath: "paper.pdf",
      absolutePath: "/demo/paper.pdf",
      type: "pdf",
      content: "",
    };
    doc.setState({ files: [...doc.getState().files, file] });
    doc.getState().setActiveFile(file.id);
  });
  await expect(page.getByTestId("pdf-scroll-container")).toHaveCount(1);
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page.waitForTimeout(700);
}

async function addComment(page: Page, text: string) {
  const line = page
    .locator(".mupdf-text-layer text")
    .filter({ hasText: "Your abstract here." })
    .first();
  await line.scrollIntoViewIfNeeded();
  await line.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
  await card
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill(text);
  await card.getByRole("button", { name: "Save comment", exact: true }).click();
  await expect(card.getByText(text, { exact: true })).toBeVisible();
  return card;
}

test("standalone PDF comments share saved geometry and edits across main and pop-out views", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openStandalonePdf(page);
  await addComment(page, "Clarify this PDF passage");
  await page.screenshot({
    path: test.info().outputPath("pdf-file-comment-main.png"),
    animations: "disabled",
  });
  const opened = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "More Editor view actions", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Pop out Editor", exact: true })
    .click();
  const child = await opened;
  await expect(child.locator(".mupdf-text-layer").first()).toBeVisible();
  const childCard = await addComment(child, "Added from the PDF pop-out");
  await child.screenshot({
    path: test.info().outputPath("pdf-file-comment-popout.png"),
    animations: "disabled",
  });
  await childCard
    .getByRole("button", { name: "Edit comment", exact: true })
    .click();
  await childCard
    .getByRole("textbox", { name: "Comment text", exact: true })
    .fill("Updated in pop-out");
  await childCard
    .getByRole("button", { name: "Save comment", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        JSON.stringify(
          Object.entries(localStorage).filter(([key]) =>
            key.startsWith("catalex-harness-comments:"),
          ),
        ),
      ),
    )
    .toContain("Updated in pop-out");
  await childCard
    .getByRole("button", { name: "Resolve comment", exact: true })
    .click();
  await childCard
    .getByRole("button", { name: "Confirm resolve comment", exact: true })
    .click();
  await expect(
    childCard.getByText("Updated in pop-out", { exact: true }),
  ).toHaveCount(0);
  await child.getByTestId("pdf-scroll-container").focus();
  await child.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const all = Object.entries(localStorage).filter(([key]) =>
          key.startsWith("catalex-harness-comments:"),
        );
        return all.some(([, value]) => {
          try {
            return Object.values(JSON.parse(value))
              .flat()
              .some(
                (comment: any) =>
                  comment.text === "Updated in pop-out" && !comment.resolved,
              );
          } catch {
            return false;
          }
        });
      }),
    )
    .toBe(true);
  await child.close();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Fit height", exact: true }).click();
  await page.getByRole("button", { name: "Fit width", exact: true }).click();
  await expect(page.getByTestId("pdf-comment-layer").first()).toBeVisible();
  for (const mode of [
    "Fit height",
    "Fit width",
    "manual",
    "expanded",
    "restored",
  ]) {
    if (mode === "manual") {
      const zoom = page.getByRole("textbox", { name: "Zoom percentage" });
      await zoom.fill("125%");
      await zoom.press("Enter");
    } else if (mode === "expanded") {
      await page
        .getByRole("button", { name: "More Editor view actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Expand Editor", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Editor expanded" }),
      ).not.toHaveAttribute("data-panel-expansion-motion");
    } else if (mode === "restored") {
      await page
        .getByRole("button", { name: "Restore Editor", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Editor expanded" }),
      ).toHaveCount(0);
    } else {
      await page.getByRole("button", { name: mode, exact: true }).click();
    }
    await page.getByRole("button", { name: /Go to comment/ }).click();
    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const text = [
            ...document.querySelectorAll(".mupdf-text-layer text"),
          ].find((el) => el.textContent?.startsWith("Your abstract here."));
          const highlight = document.querySelector(
            "[data-pdf-comment-highlight]",
          );
          if (!text || !highlight) return 1000;
          const a = text.getBoundingClientRect(),
            b = highlight.getBoundingClientRect();
          return Math.max(
            Math.abs(a.left - b.left),
            Math.abs(a.right - b.right),
            Math.abs(a.top - b.top),
            Math.abs(a.bottom - b.bottom),
          );
        });
      })
      .toBeLessThan(2);
  }
  await page.screenshot({
    path: test.info().outputPath("pdf-file-comments-scaled.png"),
    animations: "disabled",
  });
});
