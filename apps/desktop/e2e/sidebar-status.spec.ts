import { expect, test, type Page } from "@playwright/test";

async function setup(page: Page, interactive: boolean) {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(
    `/?debug=sidebar-animation${interactive ? "&trash-confirmation" : ""}`,
  );
  await page.locator('[data-sidebar-file-id="main.tex"]').waitFor();
  await page.evaluate(async () => {
    const mocksPath = "/src/renderer/dev/desktop-browser-mocks.ts";
    const { ensureDesktopBrowserMocks } = await import(mocksPath);
    ensureDesktopBrowserMocks();
    const storePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore: store } = await import(storePath);
    const note = (id: string, agent = false) => ({
      id,
      text: "Review this passage",
      from: 0,
      to: 1,
      createdAt: 1,
      ...(agent ? { origin: "agent" } : {}),
    });
    const projectRoot = "/tmp/sidebar-status-harness";
    localStorage.setItem(
      `catalex-harness-comments:${projectRoot}`,
      JSON.stringify({
        "main.tex": [
          note("human"),
          note("agent", true),
          { ...note("resolved"), resolved: true },
          { ...note("empty"), text: "" },
        ],
        "references.bib": [note("human-bib"), note("agent-bib", true)],
        "template.pdf": [note("agent-pdf", true)],
      }),
    );
    store.setState({
      projectRoot,
      activeFileId: "template.pdf",
      compileDiagnosticsCache: new Map([
        [
          "main.tex",
          [
            {
              file: "main.tex",
              severity: "warning",
              message: "Example warning",
            },
            { file: "main.tex", severity: "error", message: "Example error" },
          ],
        ],
      ]),
    });
  });
  await expect(
    page.locator('[data-sidebar-file-id="main.tex"]').getByRole("img"),
  ).toHaveCount(4);
}

async function activeFile(page: Page) {
  return page.evaluate(async () => {
    const storePath = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(storePath);
    return useDocumentStore.getState().activeFileId;
  });
}

async function setSidebarWidth(page: Page, width: number) {
  await page
    .locator('[data-sidebar-file-id="main.tex"]')
    .evaluate((row, width) => {
      const sidebar = row.closest<HTMLElement>(
        "[data-workspace-assistant-mode]",
      )!;
      sidebar.style.width = `${width}px`;
    }, width);
}

for (const interactive of [false, true]) {
  test(`${interactive ? "interactive" : "static"} file indicators follow the sidebar width`, async ({
    page,
  }, testInfo) => {
    await setup(page, interactive);
    const main = page.locator('[data-sidebar-file-id="main.tex"]');
    const pair = page.locator('[data-sidebar-file-id="references.bib"]');
    const single = page.locator('[data-sidebar-file-id="template.pdf"]');
    await expect(
      page.getByRole("button", { name: /file indicators/ }),
    ).toHaveCount(0);
    for (const width of [229, 230, 240, 200]) {
      await setSidebarWidth(page, width);
      const step = width >= 230 ? 16 : 8;
      await expect(main.locator(".file-status-strip")).toHaveCSS(
        "width",
        `${14 + step * 3}px`,
      );
      await expect(pair.locator(".file-status-strip")).toHaveCSS(
        "width",
        `${14 + step}px`,
      );
      await expect(single.locator(".file-status-strip")).toHaveCSS(
        "width",
        "14px",
      );
      const positions = await main
        .getByRole("img")
        .evaluateAll((icons) =>
          icons.map((icon) => icon.getBoundingClientRect().x),
        );
      expect(
        positions.slice(1).map((x, index) => x - positions[index]),
      ).toEqual([step, step, step]);
      const maskedIcon = main.locator(".file-status-masked-icon").first();
      const mask = await maskedIcon.evaluate(
        (icon) => getComputedStyle(icon).maskImage,
      );
      expect(mask === "none").toBe(width >= 230);
      await main.screenshot({
        path: testInfo.outputPath(`file-indicators-${width}.png`),
      });
    }
    expect(await activeFile(page)).toBe("template.pdf");
    await main.getByRole("button", { name: "main.tex", exact: true }).click();
    await expect.poll(() => activeFile(page)).toBe("main.tex");
  });
}

async function setMainDiagnostics(
  page: Page,
  severities: ("warning" | "error")[],
) {
  await page.evaluate(async (values) => {
    const path = "/src/renderer/stores/document-store.ts";
    const { useDocumentStore } = await import(path);
    useDocumentStore.setState({
      compileDiagnosticsCache: new Map([
        [
          "main.tex",
          values.map((severity) => ({
            file: "main.tex",
            severity,
            message: `Example ${severity}`,
          })),
        ],
      ]),
    });
  }, severities);
}

for (const mode of ["separate", "stacked", "reduced"] as const) {
  test(`indicator bubbles appear and burst cleanly in ${mode} mode`, async ({
    page,
  }) => {
    if (mode === "reduced")
      await page.emulateMedia({ reducedMotion: "reduce" });
    await setup(page, true);
    const main = page.locator('[data-sidebar-file-id="main.tex"]');
    await setSidebarWidth(page, mode === "stacked" ? 200 : 320);
    await page.mouse.move(800, 600);
    await page.waitForTimeout(350);
    for (const removing of [true, false]) {
      const sampling = main.evaluate(async (row, remove) => {
        const path = "/src/renderer/stores/document-store.ts";
        const { useDocumentStore } = await import(path);
        const icon = row.querySelector('[data-status-key="human"]')!;
        const positions = [icon.getBoundingClientRect().x];
        const severities = remove ? ["error"] : ["warning", "error"];
        useDocumentStore.setState({
          compileDiagnosticsCache: new Map([
            [
              "main.tex",
              severities.map((severity) => ({
                file: "main.tex",
                severity,
                message: severity,
              })),
            ],
          ]),
        });
        const started = performance.now();
        while (performance.now() - started < 500) {
          await new Promise(requestAnimationFrame);
          positions.push(icon.getBoundingClientRect().x);
        }
        return positions;
      }, removing);
      if (removing && mode !== "reduced") {
        await page.waitForTimeout(300);
        await page.screenshot({
          path: `../../output/playwright/sidebar-slide-${mode}.png`,
        });
      }
      const positions = await sampling;
      const start = positions[0];
      const finish = positions.at(-1)!;
      const distance = mode === "stacked" ? 8 : 16;
      expect(finish - start).toBeCloseTo(removing ? distance : -distance, 1);
      const intermediate = positions.filter(
        (x) => Math.abs(x - start) > 0.1 && Math.abs(x - finish) > 0.1,
      );
      if (mode === "reduced") expect(intermediate).toHaveLength(0);
      else expect(new Set(intermediate).size).toBeGreaterThan(2);
    }
    // Resolving comments exercises the same presence path as diagnostic updates.
    await page.evaluate(() => {
      const key = "catalex-harness-comments:/tmp/sidebar-status-harness";
      const comments = JSON.parse(localStorage.getItem(key) ?? "{}");
      comments["main.tex"] = comments["main.tex"].map((comment: object) => ({
        ...comment,
        resolved: true,
      }));
      localStorage.setItem(key, JSON.stringify(comments));
      window.dispatchEvent(
        new CustomEvent("catalex:project-comments-refresh", {
          detail: { projectRoot: "/tmp/sidebar-status-harness" },
        }),
      );
    });
    await expect(main.getByRole("img")).toHaveCount(2);
    await expect(main.locator('[data-exiting="true"]')).toHaveCount(0);
    await page.mouse.move(800, 600);
    await setMainDiagnostics(page, []);
    await expect(main.getByRole("img")).toHaveCount(0);
    await expect(
      main.getByRole("button", { name: /file indicators/ }),
    ).toHaveCount(0);
    if (mode !== "reduced") {
      await expect(main.locator('[data-exiting="true"]')).toHaveCount(2);
      await page.screenshot({
        path: `../../output/playwright/sidebar-burst-${mode}.png`,
      });
    }
    await expect(main.locator(".file-status-strip")).toHaveCount(0);
    await setMainDiagnostics(page, ["warning"]);
    await expect(main.getByRole("img")).toHaveCount(1);
    await expect(
      main.getByRole("button", { name: /file indicators/ }),
    ).toHaveCount(0);
    const frames = await main
      .locator(".file-status-glyph")
      .evaluate(async (glyph) => {
        const samples: { scale: number; opacity: number }[] = [];
        const start = performance.now();
        while (performance.now() - start < 360) {
          const style = getComputedStyle(glyph);
          samples.push({
            scale: new DOMMatrixReadOnly(style.transform).a,
            opacity: Number(style.opacity),
          });
          await new Promise(requestAnimationFrame);
        }
        return samples;
      });
    if (mode === "reduced") {
      expect(
        frames.every((frame) => frame.scale === 1 && frame.opacity === 1),
      ).toBe(true);
    } else {
      expect(Math.min(...frames.map((frame) => frame.scale))).toBeLessThan(1);
      expect(Math.max(...frames.map((frame) => frame.scale))).toBeGreaterThan(
        1.1,
      );
      expect(frames.at(-1)?.scale).toBe(1);
    }
    // Reappearing during an exit must cancel removal, without replaying neighbors.
    await setMainDiagnostics(page, ["warning", "error"]);
    await expect(main.getByRole("img")).toHaveCount(2);
    await setMainDiagnostics(page, ["warning"]);
    await setMainDiagnostics(page, ["warning", "error"]);
    await page.waitForTimeout(350);
    await expect(main.getByRole("img")).toHaveCount(2);
    await expect(main.locator('[data-exiting="true"]')).toHaveCount(0);
    await expect(main.locator(".file-status-strip")).toHaveCSS(
      "width",
      mode === "stacked" ? "22px" : "30px",
    );
    expect(await activeFile(page)).toBe("template.pdf");
  });
}
