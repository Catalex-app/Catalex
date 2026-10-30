import { expect, test } from "@playwright/test";

test("shared editor styles preserve independent appearance and stop growing after warmup", async ({
  page,
}) => {
  await page.goto("/?debug=pdf-comments&performance");
  await expect(
    page.locator('[data-page-number="1"] .mupdf-text-layer'),
  ).toBeVisible();
  const result = await page.evaluate(async () => {
    const { EditorView } = await import(
      "/node_modules/.vite/deps/@codemirror_view.js"
    );
    const { EditorState, Compartment } = await import(
      "/node_modules/.vite/deps/@codemirror_state.js"
    );
    const appearance = await import(
      "/src/renderer/components/workspace/editor/editor-appearance.ts"
    );
    const { diagnosticChatMode } = await import(
      "/src/renderer/components/workspace/editor/diagnostic-chat.ts"
    );
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;inset:50px;z-index:9999;background:white;display:flex";
    document.body.append(host);
    const color = new Compartment(),
      size = new Compartment(),
      diagnostic = new Compartment();
    const doc = "\\section{Example}\n% Comment";
    const first = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          appearance.createEditorSurfaceExtensions(),
          appearance.createEditorLanguageExtension("main.tex"),
          color.of(
            appearance.createEditorColorSchemeExtensions("default", "light"),
          ),
          size.of(appearance.createEditorFontSizeTheme(14)),
          diagnostic.of(diagnosticChatMode(null)),
        ],
      }),
    });
    const second = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        extensions: [
          appearance.createEditorSurfaceExtensions(),
          appearance.createEditorFontSizeTheme(8),
        ],
      }),
    });
    const count = () =>
      [...document.styleSheets]
        .filter((sheet) => !sheet.href)
        .reduce((sum, sheet) => sum + sheet.cssRules.length, 0);
    const readings: {
      scheme: string;
      theme: string;
      font: number;
      actualFont: string;
      otherFont: string;
      commentColor: string;
    }[] = [];
    const counts: number[] = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const scheme of [
        "default",
        "ocean",
        "forest",
        "sunset",
        "mono",
      ] as const) {
        for (const theme of ["light", "dark"] as const) {
          for (const font of [8, 14, 22]) {
            first.dispatch({
              effects: [
                color.reconfigure(
                  appearance.createEditorColorSchemeExtensions(scheme, theme),
                ),
                size.reconfigure(appearance.createEditorFontSizeTheme(font)),
                diagnostic.reconfigure(
                  diagnosticChatMode(theme === "dark" ? () => {} : null),
                ),
              ],
            });
            readings.push({
              scheme,
              theme,
              font,
              actualFont: getComputedStyle(first.dom).fontSize,
              otherFont: getComputedStyle(second.dom).fontSize,
              commentColor: getComputedStyle(
                first.contentDOM
                  .querySelectorAll(".cm-line")[1]
                  .querySelector("span")!,
              ).color,
            });
          }
        }
      }
      counts.push(count());
    }
    first.destroy();
    second.destroy();
    host.remove();
    return { readings, counts };
  });
  expect(result.counts[1]).toBe(result.counts[0]);
  for (const reading of result.readings) {
    expect(reading.actualFont).toBe(`${reading.font}px`);
    expect(reading.otherFont).toBe("8px");
    if (reading.scheme === "ocean")
      expect(reading.commentColor).toBe(
        reading.theme === "light" ? "rgb(100, 116, 139)" : "rgb(148, 163, 184)",
      );
    if (reading.scheme === "forest")
      expect(reading.commentColor).toBe(
        reading.theme === "light" ? "rgb(107, 114, 128)" : "rgb(168, 162, 158)",
      );
  }
  expect(result.readings.slice(30)).toEqual(result.readings.slice(0, 30));
  await page.screenshot({ path: test.info().outputPath("editor.png") });
});
