import { expect, test } from "@playwright/test";

async function expectOriginalTextScale(
  cat: import("@playwright/test").Locator,
) {
  const scale = await cat
    .locator('[data-slot="tooltip-trigger"]')
    .evaluate((element) => {
      const values = getComputedStyle(element)
        .transform.match(/matrix\(([^)]+)\)/)![1]
        .split(",")
        .map(Number);
      return Math.hypot(values[0], values[1]);
    });
  expect(scale).toBeCloseTo(1, 5);
}

for (const failure of ["network", "missing-deadline"] as const) {
  test(`welcome cat stays in place when CCFDDL is unavailable: ${failure}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1120, height: 780 });
    await page.addInitScript(() => {
      localStorage.setItem(
        "catalex-onboarding",
        JSON.stringify({ state: { completed: true, step: 3 }, version: 0 }),
      );
      localStorage.setItem(
        "catalex-settings",
        JSON.stringify({
          version: 24,
          state: {
            catDisplayMode: "ccfddl",
            catSelectedCcfddlDeadline: {
              id: "test-deadline",
              title: "SIGMOD",
              displayTitle: "SIGMOD 2027",
              deadline: "2027-12-01 23:59:59",
              deadlineIso: "2027-12-01T23:59:59.000Z",
              sourceTimezone: "UTC+0",
            },
          },
        }),
      );
    });
    let releaseRequest!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    await page.route(
      "https://ccfddl.com/conference/allconf.yml",
      async (route) => {
        await ready;
        if (failure === "network") await route.abort("failed");
        else await route.fulfill({ body: "[]", contentType: "text/plain" });
      },
    );
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("#loading-screen").waitFor({ state: "detached" });
    await page.evaluate(() => document.fonts.ready);
    const cat = page.locator("[data-cat-companion]");
    await expect(cat).toContainText("SIGMOD");
    await expectOriginalTextScale(cat);
    const before = await cat.locator("img").boundingBox();
    const actionBefore = await page
      .getByTestId("welcome-new-project-menu-trigger")
      .boundingBox();
    await page.screenshot({ path: testInfo.outputPath("before.png") });
    releaseRequest();
    await expect(cat).toContainText(/CCFDDL\s+unavailable/);
    await expectOriginalTextScale(cat);
    const after = await cat.locator("img").boundingBox();
    const actionAfter = await page
      .getByTestId("welcome-new-project-menu-trigger")
      .boundingBox();
    const clipping = await cat.evaluate((element) => {
      const letters = [...element.querySelectorAll("span.inline-block")];
      const textTop = Math.min(
        ...letters.map((letter) => letter.getBoundingClientRect().top),
      );
      let clipTop = 0;
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        if (
          ["hidden", "clip", "auto", "scroll"].includes(
            getComputedStyle(parent).overflowY,
          )
        ) {
          clipTop = Math.max(clipTop, parent.getBoundingClientRect().top);
        }
      }
      return { textTop, clipTop };
    });
    await page.screenshot({ path: testInfo.outputPath("unavailable.png") });
    await testInfo.attach("geometry", {
      body: JSON.stringify(
        { before, after, actionBefore, actionAfter, clipping },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(after!.y).toBeCloseTo(before!.y, 1);
    expect(actionAfter!.y).toBeCloseTo(actionBefore!.y, 1);
    expect(clipping.textTop).toBeGreaterThanOrEqual(clipping.clipTop);

    if (failure === "network") {
      const unavailableStyle = await cat
        .locator('[data-slot="tooltip-trigger"]')
        .evaluate((element) => ({
          text: element.textContent,
          font: getComputedStyle(element).font,
          transform: getComputedStyle(element).transform,
        }));
      for (const [name, text] of [
        ["same-custom-message", "CCFDDL unavailable"],
        ["short-custom", "Hello"],
        ["long-custom", "Welcome to my research workspace"],
        ["wide-custom", "W".repeat(28)],
        [
          "chinese-custom",
          "欢迎来到我的研究空间祝你今天的论文写作顺利完成新的研究目标",
        ],
      ]) {
        await page.evaluate(async (customText) => {
          const { useSettingsStore } = await import(
            "/src/renderer/stores/settings-store.ts"
          );
          useSettingsStore.setState({
            catDisplayMode: "static",
            catStaticDisplay: "custom",
            catCustomText: customText,
          });
        }, text);
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(async () => {
            const geometry = await cat.evaluate((element) => {
              const slot = element.firstElementChild!.getBoundingClientRect();
              const letters = [
                ...element.querySelectorAll("span.inline-block"),
              ].map((letter) => letter.getBoundingClientRect());
              return letters.every(
                (letter) =>
                  letter.top >= slot.top &&
                  letter.bottom <= slot.bottom &&
                  letter.left >= slot.left &&
                  letter.right <= slot.right,
              );
            });
            return geometry;
          })
          .toBe(true);
        const customCat = await cat.locator("img").boundingBox();
        expect(customCat!.y).toBeCloseTo(before!.y, 1);
        if (name === "same-custom-message") {
          await expectOriginalTextScale(cat);
          const customStyle = await cat
            .locator('[data-slot="tooltip-trigger"]')
            .evaluate((element) => ({
              text: element.textContent,
              font: getComputedStyle(element).font,
              transform: getComputedStyle(element).transform,
            }));
          expect(customStyle).toEqual(unavailableStyle);
        }
        if (name === "short-custom") await expectOriginalTextScale(cat);
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
      }
    }
  });
}
