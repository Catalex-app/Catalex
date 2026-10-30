import { expect, test } from "@playwright/test";

test("PDF search scans all pages, navigates, validates queries and closes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const text = page.locator('[data-page-number="1"] .mupdf-text-layer').first();
  await expect(text).toBeVisible();
  await text.click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("evaluation");
  await expect(panel).toContainText(/1 of \d+/);
  expect(
    await page.locator("[data-pdf-search-highlights]").count(),
  ).toBeGreaterThan(1);
  await input.press("Enter");
  await expect(panel).toContainText(/2 of \d+/);
  await input.press("Shift+Enter");
  await expect(panel).toContainText(/1 of \d+/);
  await panel.getByRole("button", { name: "Use Regex", exact: true }).click();
  await input.fill("[");
  await expect(panel).toContainText("Invalid regex");
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.screenshot({
    path: test.info().outputPath("pdf-search-narrow.png"),
  });
  await input.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-pdf-search-highlights]")).toHaveCount(0);
  await page.locator(".cm-content").click({ position: { x: 30, y: 20 } });
  await page.keyboard.press("Control+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("Markdown iframe routes search to preview and highlights rendered text", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  const frame = page.frameLocator('iframe[title$=" preview"]');
  await frame.locator("#write").click({ position: { x: 40, y: 30 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("the");
  await expect(panel).toContainText(/1 of \d+/);
  await expect
    .poll(() =>
      frame
        .locator("#write")
        .evaluate(
          (el) =>
            el.ownerDocument.defaultView!.CSS.highlights.get("catalex-search")
              ?.size,
        ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      frame.locator("#write").evaluate((el) =>
        Array.from(
          el.ownerDocument.defaultView!.CSS.highlights.get("catalex-search") ??
            [],
        )
          .map((range) => range.toString())
          .join("|"),
      ),
    )
    .toMatch(/the/i);
  await input.press("Enter");
  await expect(panel).toContainText(/2 of \d+/);
  await page.screenshot({
    path: test.info().outputPath("markdown-search.png"),
  });
  await input.press("Escape");
  await expect
    .poll(() =>
      frame
        .locator("#write")
        .evaluate((el) => el.ownerDocument.defaultView!.CSS.highlights.size),
    )
    .toBe(0);
});

for (const pdf of [false, true]) {
  test(`comment search defaults on and reveals ${pdf ? "PDF" : "Markdown"} comments`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?debug=comment-workspace" + (pdf ? "&pdf" : ""));
    await page
      .getByRole("tablist", { name: "Workspace view mode" })
      .getByRole("tab", { name: pdf ? "PDF" : "Preview", exact: true })
      .click();
    if (pdf) {
      await page
        .locator('[data-page-number="1"] .mupdf-text-layer')
        .first()
        .click({ position: { x: 30, y: 30 } });
    } else {
      await page
        .frameLocator('iframe[title$=" preview"]')
        .getByRole("heading", {
          name: "Learning with limited data",
          exact: true,
        })
        .click();
    }
    await page.keyboard.press("Control+f");
    const panel = page.getByTestId("preview-search-panel");
    const toggle = panel.getByRole("button", {
      name: "Include Comments",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await panel
      .getByRole("textbox", { name: "Search", exact: true })
      .fill(pdf ? "Describe" : "clarify");
    const result = panel.getByRole("button", { name: /Open comment:/ }).first();
    await expect(result).toBeVisible();
    await expect(result.locator("mark")).toHaveText(
      pdf ? "Describe" : "clarify",
    );
    await toggle.click();
    await expect(result).toHaveCount(0);
    await expect(panel).toContainText("No results");
    await toggle.click();
    await result.click();
    const card = page.getByRole("dialog", { name: "PDF comment", exact: true });
    await expect(card).toContainText(
      pdf ? "Describe the problem" : "Please clarify the baseline",
    );
    await page.screenshot({
      path: test
        .info()
        .outputPath(
          pdf ? "pdf-comment-search.png" : "markdown-comment-search.png",
        ),
    });
  });
}

test("editor comment toggle placement ignores obsolete replies and supports keyboard navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("editor-search-panel");
  const toggle = panel.getByRole("button", {
    name: "Include Comments",
    exact: true,
  });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const buttons = await panel
    .getByRole("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")),
    );
  expect(buttons.indexOf("Include Comments")).toBe(
    buttons.indexOf("Find in Selection") + 1,
  );
  expect(buttons.indexOf("Close")).toBe(
    buttons.indexOf("Include Comments") + 1,
  );
  await page.evaluate(() => {
    const projectRoot = "/browser-demo/Comment Review";
    const key = `catalex-harness-comments:${projectRoot}`;
    const comments = JSON.parse(localStorage.getItem(key)!);
    comments["manuscript.md"][0].replies = [
      {
        id: "search-reply",
        text: "ReplySearchFixture",
        createdAt: new Date().toISOString(),
      },
    ];
    localStorage.setItem(key, JSON.stringify(comments));
    window.dispatchEvent(
      new CustomEvent("catalex:project-comments-refresh", {
        detail: { projectRoot },
      }),
    );
  });
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await input.fill("ReplySearchFixture");
  await expect(
    panel.getByRole("button", { name: "Open reply: ReplySearchFixture" }),
  ).toHaveCount(0);
  await input.fill("clarify");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights)
          .filter(([name]) => name.startsWith("comment-search-"))
          .flatMap(([, highlight]) =>
            Array.from(highlight).map((range) => range.toString()),
          )
          .join("|"),
      ),
    )
    .toMatch(/clarify/i);
  await toggle.click();
  await expect(
    panel.getByRole("group", { name: "Comment search results" }),
  ).toHaveCount(0);
});

test("chat shortcuts do not open hidden editor search across Duet workspace and Duet", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const chat = page.locator(
    '[data-workspace-panel-screen="true"] textarea:visible',
  );
  await chat.click();
  await page.keyboard.press("Meta+f");
  await page.keyboard.press("Control+f");
  await page.keyboard.press("Control+h");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .click();
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toHaveCount(0);
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Meta+f");
  await expect(page.getByTestId("editor-search-panel")).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("editor-focus-search.png"),
  });
});

test("comment IDs match case-insensitively only when comments are included", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace");
  await page.locator(".cm-content").click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("editor-search-panel");
  const input = panel.getByRole("textbox", { name: "Search", exact: true });
  await panel.getByRole("button", { name: "Match Case", exact: true }).click();
  for (const [id, expected] of [
    ["h-1", "H-1"],
    ["H1", "H-1"],
    ["h1", "H-1"],
    ["h 1", "H-1"],
    ["a-7", "A-7"],
    ["a7", "A-7"],
    ["A 7", "A-7"],
  ]) {
    await input.fill(id);
    const result = panel.getByRole("button", {
      name: new RegExp("Open comment: " + expected),
    });
    await expect(result).toBeVisible();
    await expect(result.locator("mark")).toHaveText(expected);
    await result.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Array.from(CSS.highlights)
            .filter(([name]) => name.startsWith("comment-search-"))
            .flatMap(([, highlight]) =>
              Array.from(highlight).map((range) => range.toString()),
            )
            .join("|"),
        ),
      )
      .toContain(expected);
  }
  await panel
    .getByRole("button", { name: "Include Comments", exact: true })
    .click();
  await expect(
    panel.getByRole("group", { name: "Comment search results" }),
  ).toHaveCount(0);
  await expect(panel).toContainText("No results");
  await page.screenshot({
    path: test.info().outputPath("comment-id-search.png"),
  });
});

test("Escape closes only focused search, consumes the event, and preserves chat, modal and IME handling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?debug=comment-workspace&pdf");
  const editor = page.locator(".cm-content");
  await editor.click({ position: { x: 40, y: 20 } });
  await page.keyboard.press("Control+f");
  const left = page.getByTestId("editor-search-panel");
  await expect(left).toBeVisible();
  await page
    .locator('[data-page-number="1"] .mupdf-text-layer')
    .first()
    .click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Control+f");
  const right = page.getByTestId("preview-search-panel");
  await expect(right).toBeVisible();
  await expect(left).toBeVisible();
  await page.evaluate(() => {
    (window as any).__escapeCount = 0;
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") (window as any).__escapeCount++;
    });
  });
  const input = right.getByRole("textbox", { name: "Search", exact: true });
  await input.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
  });
  await expect(right).toBeVisible();
  await right
    .getByRole("button", { name: "Include Comments", exact: true })
    .focus();
  const count = await page.evaluate(() => (window as any).__escapeCount);
  await page.keyboard.press("Escape");
  await expect(right).toHaveCount(0);
  await expect(left).toBeVisible();
  expect(await page.evaluate(() => (window as any).__escapeCount)).toBe(count);
  await expect(
    page.locator("[data-preview-search-scope]").first(),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).__escapeCount)).toBe(
    count + 1,
  );
  await page
    .locator('[data-chat-drawer-panel="true"] textarea:visible')
    .click();
  await page.keyboard.press("Escape");
  await expect(left).toBeVisible();
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "search-test-dialog";
    dialog.textContent = "Modal";
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-test-dialog")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(left).toBeVisible();
  await page.locator("#search-test-dialog").evaluate((node) => node.remove());
  await editor.focus();
  const before = await page.evaluate(() => (window as any).__escapeCount);
  await page.keyboard.press("Escape");
  await expect(left).toHaveCount(0);
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => (window as any).__escapeCount)).toBe(before);
});

test("Escape from Markdown iframe closes its search and restores preview focus", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace");
  const frame = page.frameLocator('iframe[title$=" preview"]');
  const heading = frame.getByRole("heading", {
    name: "Learning with limited data",
    exact: true,
  });
  await heading.click();
  await page.keyboard.press("Control+f");
  const panel = page.getByTestId("preview-search-panel");
  await expect(panel).toBeVisible();
  await heading.click();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("markdown-preview")).toBeFocused();
});

test("a context menu owns Escape before the search behind it", async ({
  page,
}) => {
  await page.goto("/?debug=comment-workspace&pdf");
  const editor = page.locator(".cm-content");
  await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Control+f");
  const search = page.getByTestId("editor-search-panel");
  await expect(search).toBeVisible();
  await editor.click({ button: "right", position: { x: 80, y: 170 } });
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  await menu.dispatchEvent("keydown", {
    key: "Escape",
    isComposing: true,
    bubbles: true,
    cancelable: true,
  });
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(search).toBeVisible();
  await editor.focus();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
});

for (const surface of ["editor", "PDF", "Markdown"] as const) {
  test(`repeated Find focuses and selects the existing ${surface} query`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      surface === "Markdown"
        ? "/?debug=comment-workspace"
        : "/?debug=comment-workspace&pdf",
    );
    if (surface !== "Markdown")
      await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    const focusContent = async () => {
      if (surface === "editor") await page.locator(".cm-content").focus();
      else if (surface === "PDF")
        await page.locator("[data-preview-search-scope]").first().focus();
      else
        await page
          .frameLocator('iframe[title$=" preview"]')
          .locator("#write")
          .evaluate((node) => {
            node.tabIndex = -1;
            node.focus();
          });
    };
    await focusContent();
    await page.keyboard.press("Control+f");
    const panel = page.getByTestId(
      surface === "editor" ? "editor-search-panel" : "preview-search-panel",
    );
    const input = panel.getByRole("textbox", { name: "Search", exact: true });
    await input.fill("evaluation");
    const toggle = panel.getByRole("button", {
      name: "Match Case",
      exact: true,
    });
    await toggle.click();
    for (const shortcut of ["Control+f", "Meta+f"]) {
      await focusContent();
      await page.keyboard.press(shortcut);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("evaluation");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      expect(
        await input.evaluate((node: HTMLInputElement) => [
          node.selectionStart,
          node.selectionEnd,
        ]),
      ).toEqual([0, 10]);
    }
  });
}
