import { expect, test } from "@playwright/test";

test("normal-demo PDFs scale with both panel transitions using existing pixels", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?onboarding-demo&project");
  await page
    .locator('[data-sidebar-section="files"]')
    .getByText("demo-paper.tex", { exact: true })
    .click();
  const recompile = page.getByRole("button", {
    name: "Recompile",
    exact: true,
  });
  await recompile.click();
  await expect(recompile).toBeEnabled();
  await expect(
    page
      .locator('[data-testid="pdf-scroll-container"]:visible .mupdf-text-layer')
      .first(),
  ).toBeVisible();
  await page.waitForTimeout(400);
  for (const [name, kind] of [
    ["PDF", "view"],
    ["Full", "chat"],
    ["Half", "chat"],
    ["Split", "view"],
  ] as const) {
    const recording = page.evaluate(
      () =>
        new Promise<
          {
            width: number;
            viewport: number;
            raster: number;
            moving: boolean;
            top: number;
          }[]
        >((resolve) => {
          const frames: {
            width: number;
            viewport: number;
            raster: number;
            moving: boolean;
            top: number;
          }[] = [];
          const start = performance.now();
          const sample = () => {
            const scroller = Array.from(
              document.querySelectorAll<HTMLElement>(
                '[data-testid="pdf-scroll-container"]',
              ),
            ).find((el) => el.clientWidth > 1)!;
            const page = scroller.querySelector<HTMLElement>(".mupdf-page")!;
            frames.push({
              width: page.getBoundingClientRect().width,
              viewport: scroller.clientWidth,
              raster: page.querySelector("canvas")!.width / devicePixelRatio,
              moving:
                document
                  .querySelector("[data-workspace-layout-animating]")
                  ?.getAttribute("data-workspace-layout-animating") === "true",
              top: scroller.scrollTop,
            });
            if (performance.now() - start < 1200)
              requestAnimationFrame(() => setTimeout(sample, 0));
            else resolve(frames);
          };
          sample();
        }),
    );
    if (kind === "view")
      await page
        .getByRole("tablist", { name: "Workspace view mode" })
        .getByRole("tab", { name, exact: true })
        .click();
    else await page.getByRole("button", { name, exact: true }).click();
    const frames = await recording;
    const moving = frames.filter((frame) => frame.moving);
    await test.info().attach(`${kind}-${name}-frames`, {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
    expect(
      new Set(moving.map((frame) => Math.round(frame.width))).size,
      name,
    ).toBeGreaterThan(4);
    // The 8px divider appears/disappears at the layout boundary. Check the
    // actual morph separately, once both endpoint gutters have been crossed.
    const initialWidth = frames[0].width;
    const finalWidth = frames.at(-1)!.width;
    const morphing = moving.filter(
      (frame) =>
        Math.abs(frame.width - initialWidth) > 8 &&
        Math.abs(frame.width - finalWidth) > 8,
    );
    expect(morphing.length, name).toBeGreaterThan(3);
    expect(
      Math.max(
        ...morphing.map((frame) => Math.abs(frame.viewport - 32 - frame.width)),
      ),
      name,
    ).toBeLessThanOrEqual(1);
    expect(
      new Set(
        moving.filter((frame) => frame.raster > 0).map((frame) => frame.raster),
      ).size,
      name,
    ).toBe(1);
    expect(
      Math.max(...frames.map((frame) => frame.top)),
      name,
    ).toBeLessThanOrEqual(1);
    const final = frames.at(-1)!;
    expect(Math.abs(final.raster - final.width), name).toBeLessThan(2);
    await expect(
      page.locator("[data-pdf-fit-crossfade], [data-pdf-fit-concealed]"),
    ).toHaveCount(0);
    await expect(page.locator("[data-pdf-scroll-content]")).toHaveCSS(
      "filter",
      "none",
    );
  }
});

test("the normal demo compiles portrait, landscape, and letter sources and their edits", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?onboarding-demo&project");
  const files = page.locator('[data-sidebar-section="files"]');
  const compiledFiles: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/__demo/compile") &&
      request.method() === "POST"
    )
      compiledFiles.push(request.postDataJSON().file);
  });
  for (const [name, title, pages] of [
    ["demo-paper.tex", "A Small Study of Writing Workflows", 3],
    ["landscape-notes.tex", "Workspace Comparison: Landscape Notes", 2],
    ["short-letter.tex", "Dear reader", 1],
  ] as const) {
    await files.getByText(name, { exact: true }).click();
    await page.getByRole("button", { name: "Recompile", exact: true }).click();
    const preview = page.locator(
      '[data-testid="pdf-scroll-container"]:visible',
    );
    await expect(preview.locator(".mupdf-page")).toHaveCount(pages);
    await expect(preview.locator(".mupdf-text-layer").first()).toContainText(
      title,
    );
    const dimensions = await preview
      .locator(".mupdf-page")
      .first()
      .boundingBox();
    expect(dimensions!.width > dimensions!.height).toBe(
      name === "landscape-notes.tex",
    );
  }
  await files.getByText("demo-paper.tex", { exact: true }).click();
  const inputs = await page.evaluate(async () => {
    const map = await (window as any).__TAURI_INTERNALS__.invoke(
      "get_synctex_source_map",
      { projectDir: "/browser-demo/My first project" },
    );
    return Object.values(map.inputs);
  });
  expect(inputs).toContain("demo-paper.tex");
  await files.getByText("short-letter.tex", { exact: true }).click();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (item) =>
          new URL(item.name).pathname ===
          "/src/renderer/stores/document-store.ts",
      )!;
    const { useDocumentStore } = await import(resource.name);
    const state = useDocumentStore.getState();
    const file = state.files.find(
      (item: { id: string }) => item.id === "short-letter.tex",
    );
    state.updateFileContent(
      file.id,
      file.content.replace("Dear reader", "Animation review revision"),
    );
  });
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await expect(
    page
      .locator('[data-testid="pdf-scroll-container"]:visible .mupdf-text-layer')
      .first(),
  ).toContainText("Animation review revision");
  expect(compiledFiles).toEqual(
    expect.arrayContaining([
      "demo-paper.tex",
      "landscape-notes.tex",
      "short-letter.tex",
    ]),
  );
  await page.screenshot({
    path: test.info().outputPath("normal-demo-latex-pdf.png"),
  });
});
