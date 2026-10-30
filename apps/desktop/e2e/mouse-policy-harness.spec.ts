import { expect, test, type Locator, type Page } from "@playwright/test";

async function mouseClick(
  page: Page,
  target: Locator,
  button: "left" | "middle" | "right" | "back" | "forward",
) {
  await expect(page.locator("#loading-screen")).toHaveCount(0);
  await target.scrollIntoViewIfNeeded();
  await target.click({ trial: true });
  const box = await target.boundingBox();
  if (!box) throw new Error("Mouse target is not visible");
  const session = await page.context().newCDPSession(page);
  try {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await session.send("Input.dispatchMouseEvent", {
        type,
        button,
        buttons:
          type === "mousePressed"
            ? { left: 1, middle: 4, right: 2, back: 8, forward: 16 }[button]
            : 0,
        clickCount: 1,
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
    }
  } finally {
    await session.detach();
  }
}

test("non-primary buttons preserve focus without activating controls or browser history", async ({
  page,
}) => {
  await page.goto("/?debug=focus");
  const input = page.getByRole("textbox", { name: "Project name" });
  await input.fill("Project draft");
  await page.evaluate(() => {
    history.pushState(null, "", "#previous");
    history.pushState(null, "", "#current");
  });
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.evaluate((element) => {
    element.dataset.activations = "0";
    element.addEventListener("click", () => {
      element.dataset.activations = String(
        Number(element.dataset.activations) + 1,
      );
    });
  });
  for (const button of ["middle", "right", "back", "forward"] as const) {
    for (const target of [
      save,
      page.getByRole("button", { name: "Actions", exact: true }),
      page.getByRole("combobox", { name: "Format" }),
    ]) {
      await input.focus();
      await mouseClick(page, target, button);
      await expect(input).toBeFocused();
      await expect(save).toHaveAttribute("data-activations", "0");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page).toHaveURL(/#current$/);
    }
  }
  await save.click();
  await expect(save).toHaveAttribute("data-activations", "1");
  await save.press("Enter");
  await expect(save).toHaveAttribute("data-activations", "2");
  await page.screenshot({
    path: test.info().outputPath("controls.png"),
    animations: "disabled",
  });
});

test("mention rows accept primary clicks while other buttons leave the draft intact", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const input = page.locator(
    '[data-chat-drawer-panel="true"] textarea:visible',
  );
  await input.fill("@");
  const mention = page
    .getByRole("button")
    .filter({ has: page.getByText("main.tex", { exact: true }) })
    .last();
  await expect(mention).toBeVisible();
  for (const button of ["middle", "right", "back", "forward"] as const) {
    await mouseClick(page, mention, button);
    await expect(input).toHaveValue("@");
    await expect(input).toBeFocused();
    await expect(page.getByText("@main.tex", { exact: true })).toHaveCount(0);
  }
  await mention.click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByText("@main.tex", { exact: true }).first(),
  ).toBeVisible();
});

test("CodeMirror selection survives auxiliary buttons and context menu copy still works", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?debug=context-menu");
  const editor = page.locator(".cm-content");
  await editor.click();
  await editor.press("Home");
  for (let i = 0; i < 5; i++) await editor.press("Shift+ArrowRight");
  const selection = () =>
    page.evaluate(() => window.getSelection()?.toString());
  await expect.poll(selection).toBe("alpha");
  for (const button of ["middle", "back", "forward"] as const) {
    await mouseClick(page, editor, button);
    await expect(editor).toBeFocused();
    await expect.poll(selection).toBe("alpha");
  }
  await mouseClick(page, editor, "right");
  const copy = page.getByRole("menuitem", { name: "Copy", exact: true });
  await expect(copy).toBeEnabled();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "alpha",
  );
});

test("middle clicks open project files in background tabs and close file tabs", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-workspace");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const linkedFile = preview.getByRole("link", { name: "a local link" });
  const notesTab = page.locator(
    '[data-editor-file-tab] button[aria-label="notes.md"]',
  );
  await expect(linkedFile).toBeVisible();
  const editor = page.locator(".cm-content");
  await editor.focus();
  const sidebarFile = page.locator('[data-sidebar-file-id="notes.md"]');
  await mouseClick(page, sidebarFile, "middle");
  await expect(notesTab).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("README.md");
  await mouseClick(page, notesTab, "middle");
  await expect(notesTab).toHaveCount(0);
  await mouseClick(page, linkedFile, "middle");
  await expect(notesTab).toBeVisible();
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("README.md");
  await expect(editor).toBeFocused();
  await page.screenshot({
    path: test.info().outputPath("background-tab.png"),
    animations: "disabled",
  });
  await notesTab.click();
  await expect(
    page.locator('[data-editor-file-tab][data-active="true"]'),
  ).toContainText("notes.md");
});

test("Markdown iframe auxiliary presses preserve source focus and right-click menus", async ({
  page,
}) => {
  await page.goto("/?debug=markdown-preview");
  const preview = page.frameLocator('iframe[title="README.md preview"]');
  const heading = preview.getByRole("heading", {
    name: "Markdown Preview",
    exact: true,
  });
  const editor = page.locator(".cm-content");
  await expect(heading).toBeVisible();
  for (const button of ["middle", "back", "forward"] as const) {
    await editor.focus();
    await mouseClick(page, heading, button);
    await expect(editor).toBeFocused();
  }
  const link = preview.getByRole("link", { name: "a local link" });
  await mouseClick(page, link, "right");
  await expect(
    page.getByRole("menuitem", { name: "Open Link", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("middle-clicking an external link opens a separate browser tab", async ({
  page,
  context,
}) => {
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ body: "Reference" }),
  );
  await page.goto("/?debug=context-menu");
  const popup = context.waitForEvent("page");
  await mouseClick(
    page,
    page.getByRole("link", { name: "Reference link" }),
    "middle",
  );
  const opened = await popup;
  await expect(opened).toHaveURL("https://example.com/reference");
  await expect(page.getByLabel("Opened links")).toHaveText("0");
  await expect(page).toHaveURL(/debug=context-menu/);
  await opened.close();
});
