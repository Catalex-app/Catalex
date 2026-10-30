import { expect, test, type Page } from "@playwright/test";

async function settings(page: Page, values: Record<string, unknown>) {
  await page.evaluate(async (values) => {
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState(values);
  }, values);
}
const marks = (page: Page) => page.locator(".cm-spelling-error");

test("real Hunspell checks prose, corrects with undo, learns words, and toggles live", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?debug=editor-minimap&spelling");
  await expect(
    marks(page)
      .filter({ hasText: /^speling$/ })
      .first(),
  ).toBeVisible();
  const text = await marks(page).allTextContents();
  // Accepted by Overleaf's base dictionary, rejected by dictionary-en 4.0.0.
  await expect(page.locator(".cm-content")).toContainText("embeddings");
  expect(text).not.toContain("embeddings");
  expect(text).not.toContain("badcite");
  expect(text).not.toContain("badmath");
  expect(text).not.toContain("badfile");
  expect(text).not.toContain("badcode");
  await marks(page)
    .filter({ hasText: /^speling$/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText(
    "has a spelling mistake",
  );
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".cm-content")).toContainText(
    "has a speling mistake",
  );
  await expect(marks(page).filter({ hasText: /^sentnce$/ })).toBeVisible();
  await marks(page)
    .filter({ hasText: /^sentnce$/ })
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Add to Dictionary", exact: true })
    .click();
  await expect(marks(page).filter({ hasText: /^sentnce$/ })).toHaveCount(0);
  await settings(page, { spellCheck: false });
  await expect(marks(page)).toHaveCount(0);
  await settings(page, { spellCheck: true, spellingLanguage: "en-GB" });
  await expect(marks(page).filter({ hasText: /^color$/ })).toBeVisible();
  await expect(marks(page).filter({ hasText: /^Colour$/ })).toHaveCount(0);
  await page.screenshot({ path: "test-results/spelling-light.png" });
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.screenshot({ path: "test-results/spelling-dark.png" });
  await page.reload();
  await expect(marks(page).filter({ hasText: /^color$/ })).toBeVisible();
  await expect(marks(page).filter({ hasText: /^sentnce$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Markdown spelling excludes code and links, and a stale menu cannot change another document", async ({
  page,
}) => {
  await page.goto("/?debug=editor-minimap&spelling&markdown");
  await expect(marks(page).filter({ hasText: /^speling$/ })).toBeVisible();
  expect(await marks(page).allTextContents()).not.toContain("badcode");
  expect(await marks(page).allTextContents()).not.toContain("badurl");
  await marks(page)
    .filter({ hasText: /^speling$/ })
    .click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "spelling", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("short.md");
  });
  await page.getByRole("menuitem", { name: "spelling", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Short document.");
  await expect(page.locator(".cm-content")).not.toContainText("spelling");
});

test("settings reuse existing controls and persist across reloads", async ({
  page,
}) => {
  await page.goto("/?settings&onboarding-demo");
  await page.getByPlaceholder("Search settings").fill("spell");
  await page.getByText("Spell Check", { exact: true }).first().click();
  const toggle = page.getByRole("switch", { name: "Spell Check", exact: true });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page
    .locator('[data-settings-row-id="appearance-editor-spelling-language"]')
    .getByRole("combobox")
    .click();
  await page.getByRole("option", { name: "English (UK)", exact: true }).click();
  await page.screenshot({ path: "test-results/spelling-settings.png" });
  await page.reload();
  await page.getByPlaceholder("Search settings").fill("spell");
  await page.getByText("Spell Check", { exact: true }).first().click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(
    page.locator(
      '[data-settings-row-id="appearance-editor-spelling-language"]',
    ),
  ).toContainText("English (UK)");
});

test("large-document checks remain visible-only and continuous typing does not queue checks", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__spellingRequests = [];
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, ...args: unknown[]) {
        if ((message as { type?: string }).type === "check")
          window.__spellingRequests.push(message);
        super.postMessage(message, ...args);
      }
    };
  });
  await page.goto("/?debug=editor-minimap&spelling");
  await expect(
    marks(page)
      .filter({ hasText: /^speling$/ })
      .first(),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const { EditorView } = await import(
      "/node_modules/.vite/deps/@codemirror_view.js"
    );
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    const view = EditorView.findFromDOM(
      document.querySelector(".cm-content")!,
    )!;
    const doc = `${"A research paragraph with ordinary words.\n".repeat(6000)}Last speling mistake.`;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const timings: Record<string, number[]> = {};
    for (const enabled of [false, true]) {
      useSettingsStore.getState().setSpellCheck(enabled);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      const before = window.__spellingRequests.length;
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        const start = performance.now();
        view.dispatch({ changes: { from: 0, insert: "a" } });
        samples.push(performance.now() - start);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      timings[String(enabled)] = samples;
      if (enabled && window.__spellingRequests.length !== before)
        throw new Error("Checks ran during continuous typing");
    }
    view.dispatch({
      selection: { anchor: view.state.doc.length },
      effects: EditorView.scrollIntoView(view.state.doc.length),
    });
    return {
      length: view.state.doc.length,
      timings,
      largestBatch: Math.max(
        ...window.__spellingRequests.map(
          (request: { words: string[] }) => request.words.length,
        ),
      ),
    };
  });
  await expect(marks(page).filter({ hasText: /^speling$/ })).toBeVisible();
  expect(result.largestBatch).toBeLessThan(200);
  console.log("Spelling typing performance", JSON.stringify(result));
});

test("late worker replies cannot restore obsolete underlines or reopen a dismissed menu", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__heldSpellingReplies = [];
    window.__holdSpelling = true;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes("spelling.worker"))
          this.addEventListener("message", (event) => {
            if (!window.__holdSpelling) return;
            event.stopImmediatePropagation();
            window.__heldSpellingReplies.push(() =>
              this.onmessage?.call(this, event),
            );
          });
      }
    };
  });
  await page.goto("/?debug=editor-minimap&spelling");
  await page.waitForFunction(() => window.__heldSpellingReplies.length > 0);
  await page.evaluate(async () => {
    const { EditorView } = await import(
      "/node_modules/.vite/deps/@codemirror_view.js"
    );
    const view = EditorView.findFromDOM(
      document.querySelector(".cm-content")!,
    )!;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "Correct words." },
    });
    window.__heldSpellingReplies
      .splice(0)
      .forEach((reply: () => void) => reply());
  });
  await expect(marks(page)).toHaveCount(0);
  await page.waitForFunction(() => window.__heldSpellingReplies.length > 0);
  await settings(page, { spellCheck: false });
  await page.evaluate(() =>
    window.__heldSpellingReplies
      .splice(0)
      .forEach((reply: () => void) => reply()),
  );
  await expect(marks(page)).toHaveCount(0);
  await page.evaluate(() => {
    window.__holdSpelling = false;
  });
  await settings(page, { spellCheck: true });
  await page.evaluate(async () => {
    const { EditorView } = await import(
      "/node_modules/.vite/deps/@codemirror_view.js"
    );
    const view = EditorView.findFromDOM(
      document.querySelector(".cm-content")!,
    )!;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "speling" },
    });
  });
  await expect(marks(page)).toBeVisible();
  await page.evaluate(() => {
    window.__holdSpelling = true;
  });
  await marks(page).click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Checking spelling…", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__heldSpellingReplies.length > 0);
  await page.evaluate(() =>
    window.__heldSpellingReplies
      .splice(0)
      .forEach((reply: () => void) => reply()),
  );
  await expect(page.getByRole("menu")).toHaveCount(0);
});
