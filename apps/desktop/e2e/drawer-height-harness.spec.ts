import { expect, test, type Page } from "@playwright/test";

async function openDrawer(page: Page) {
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  await expect(drawer.locator("textarea:visible")).toBeVisible();
  await drawer.getByRole("button", { name: "Toggle drawer" }).click();
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  await page.waitForTimeout(350);
  return drawer;
}

async function resize(page: Page, amount: number) {
  const handle = page.getByRole("button", { name: "Toggle drawer" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2,
    box.y + box.height / 2 + amount,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.mouse.move(1000, 10);
  await page.waitForTimeout(350);
}

async function revealDisplay(page: Page) {
  // Let the previous height/hover transition finish before locating the handle.
  await page.mouse.move(1000, 10);
  await page.waitForTimeout(350);
  const handle = page.getByRole("button", { name: "Toggle drawer" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(
    page.getByRole("button", { name: "Half", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(250);
}

async function baseHeight(page: Page) {
  return page.locator('[data-chat-drawer-panel="true"]').evaluate((panel) => {
    const handle = panel.querySelector<HTMLElement>(
      '[aria-label="Toggle drawer"]',
    )!.parentElement!;
    return (
      parseFloat((panel as HTMLElement).style.height) -
      (parseFloat(handle.style.height) - 16)
    );
  });
}

async function dragHalf(page: Page, amount: number, release = true) {
  await revealDisplay(page);
  const box = (await page
    .getByRole("button", { name: "Half", exact: true })
    .boundingBox())!;
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + amount, { steps: 10 });
  if (release) await page.mouse.up();
  await page.waitForTimeout(250);
  return { x, y: y + amount };
}

test("Half collapses only after releasing the drag", async ({ page }) => {
  const drawer = await openDrawer(page);
  await dragHalf(page, 260, false);
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(1);
  await expect(
    drawer.locator('[data-chat-display="Expanded"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath("collapsed-after-release.png"),
    animations: "disabled",
  });
});

test("Half follows the pointer into the Mini snap zone and preserves its saved height", async ({
  page,
}) => {
  const drawer = await openDrawer(page);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const state = useAgentChatStore.getState();
    state._appendMessage(state.activeTabId, {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "A message to preview while resizing." },
        ],
      },
    });
  });
  await expect(
    drawer.getByText("A message to preview while resizing."),
  ).toBeVisible();
  await dragHalf(page, 40);
  const preferred = await baseHeight(page);
  await revealDisplay(page);
  const panelBox = (await drawer.boundingBox())!;
  const contentHeight = await drawer.evaluate((panel) => {
    const chrome = panel.firstElementChild as HTMLElement;
    const composer = panel.querySelector<HTMLElement>(
      "[data-chat-composer-shell]",
    )!;
    return chrome.getBoundingClientRect().height + composer.scrollHeight + 2;
  });
  const buttonBox = (await page
    .getByRole("button", { name: "Half", exact: true })
    .boundingBox())!;
  const x = Math.round(buttonBox.x + buttonBox.width / 2);
  const y = Math.round(buttonBox.y + buttonBox.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  const heights: number[] = [];
  const opacities: number[] = [];
  const mini = drawer.locator('[data-chat-display="Collapsed"]');
  const preview = drawer.locator('[data-drag-snap-target="mini"]');
  const idleColor = await mini.evaluate(
    (button) => getComputedStyle(button).backgroundColor,
  );
  for (const remaining of [36, 16, 8]) {
    await page.mouse.move(x, y + panelBox.height - contentHeight - remaining, {
      steps: 5,
    });
    heights.push((await drawer.boundingBox())!.height);
    opacities.push(
      await drawer
        .locator("[data-chat-messages]")
        .evaluate((messages) => Number(getComputedStyle(messages).opacity)),
    );
    if (remaining === 36) await expect(preview).toHaveCount(0);
    if (remaining === 8) {
      await expect(preview).toHaveCount(1);
      await expect(mini).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(() =>
          mini.evaluate((button) => getComputedStyle(button).backgroundColor),
        )
        .not.toBe(idleColor);
      await page.screenshot({
        path: test.info().outputPath("mini-highlight-before-release.png"),
        animations: "disabled",
      });
    }
  }
  expect(heights[0] - heights[1]).toBeCloseTo(20, 0);
  expect(heights[1] - heights[2]).toBeCloseTo(8, 0);
  expect(opacities[0]).toBeGreaterThan(opacities[1]);
  expect(opacities[1]).toBeGreaterThan(opacities[2]);
  // The preview follows the pending outcome, including reversing the gesture.
  await page.mouse.move(x, y + panelBox.height - contentHeight - 40, {
    steps: 5,
  });
  await expect(preview).toHaveCount(0);
  await expect(mini).toHaveCSS("background-color", idleColor);
  await page.mouse.move(x, y + panelBox.height - contentHeight - 8, {
    steps: 5,
  });
  await expect(preview).toHaveCount(1);
  await expect(
    drawer.locator('[data-chat-display="Expanded"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await page.mouse.up();
  await expect(preview).toHaveCount(0);
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
  await revealDisplay(page);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect.poll(() => baseHeight(page)).toBeCloseTo(preferred, 0);
  await expect(drawer.locator("[data-chat-messages]")).toHaveCSS(
    "opacity",
    "1",
  );
});

for (const interruption of ["lost release", "window blur"] as const) {
  test(`Half stops dragging after ${interruption}`, async ({ page }) => {
    const drawer = await openDrawer(page);
    const pointer = await dragHalf(page, 260, false);
    await expect(drawer.locator("[data-chat-messages]")).toHaveCount(1);
    if (interruption === "lost release") {
      // Return from an outside release without delivering a DOM mouseup.
      const session = await page.context().newCDPSession(page);
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: pointer.x,
        y: pointer.y - 120,
        button: "none",
        buttons: 0,
      });
      await session.detach();
    } else {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    }
    await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
    await expect(drawer.locator('[data-drag-snap-target="mini"]')).toHaveCount(
      0,
    );
    await page.mouse.move(pointer.x, pointer.y - 180, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
    await expect(
      drawer.locator('[data-chat-display="Collapsed"]'),
    ).toHaveAttribute("aria-pressed", "true");
  });
}

test("dragging Half upward from Mini opens and sizes the drawer", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  await expect(drawer.locator("textarea:visible")).toBeVisible();
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
  await dragHalf(page, -130);
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  expect(await baseHeight(page)).toBeGreaterThan(150);
  expect(await baseHeight(page)).toBeLessThan(360);
  await page.screenshot({
    path: test.info().outputPath("mini-drag-to-half.png"),
    animations: "disabled",
  });
});

test("Full and Mini round trips retain the chosen Half height", async ({
  page,
}) => {
  await openDrawer(page);
  await dragHalf(page, 80);
  const chosen = await baseHeight(page);
  await revealDisplay(page);
  await page.getByRole("button", { name: "Full", exact: true }).click();
  await expect(page.locator('[data-chat-drawer-panel="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect.poll(() => baseHeight(page)).toBeCloseTo(chosen, 0);
  await revealDisplay(page);
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await expect(
    page.locator('[data-chat-drawer-panel="true"] [data-chat-messages]'),
  ).toHaveCount(0);
  await revealDisplay(page);
  await page.getByRole("button", { name: "Half", exact: true }).click();
  await expect.poll(() => baseHeight(page)).toBeCloseTo(chosen, 0);
  await page.screenshot({
    path: test.info().outputPath("restored-half-height.png"),
    animations: "disabled",
  });
});

test("agent updates during a drag cannot replace the chosen height", async ({
  page,
}) => {
  const drawer = await openDrawer(page);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const state = useAgentChatStore.getState();
    state._setStreaming(state.activeTabId, true);
  });
  await dragHalf(page, 65, false);
  const dragged = await baseHeight(page);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async (i) => {
      const path = "/src/renderer/stores/agent-chat-store.ts";
      const { useAgentChatStore } = await import(path);
      const state = useAgentChatStore.getState();
      state._appendMessage(state.activeTabId, {
        type: "assistant",
        message: { content: [{ type: "text", text: `Progress ${i}` }] },
      });
    }, i);
    await expect(
      drawer.getByText(`Progress ${i}`, { exact: true }),
    ).toBeVisible();
    expect(await baseHeight(page)).toBeCloseTo(dragged, 0);
  }
  await page.mouse.up();
  await page.waitForTimeout(250);
  expect(await baseHeight(page)).toBeCloseTo(dragged, 0);
});

test("temporary viewport limits do not overwrite the preferred Half height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDrawer(page);
  await dragHalf(page, -25);
  const chosen = await baseHeight(page);
  await page.setViewportSize({ width: 1440, height: 550 });
  await expect.poll(() => baseHeight(page)).toBeLessThan(chosen - 50);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => baseHeight(page)).toBeCloseTo(chosen, 0);
});

test("resizing an expanded drawer down keeps it open until dragged below its minimum", async ({
  page,
}) => {
  const drawer = await openDrawer(page);
  const before = await baseHeight(page);
  await resize(page, 75);
  await expect(drawer.locator("[data-chat-messages]")).toBeVisible();
  expect(await baseHeight(page)).toBeCloseTo(before - 75, 0);
  await page.screenshot({
    path: test.info().outputPath("resized-drawer.png"),
    animations: "disabled",
  });
  await resize(page, 300);
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
});

test("switching between history and New Chat does not accumulate drawer height", async ({
  page,
}) => {
  const drawer = await openDrawer(page);
  await resize(page, 40);
  await resize(page, 40);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const { useAgentChatStore } = await import(path);
    const state = useAgentChatStore.getState();
    const draft = state.tabs.find(
      (tab: { id: string }) => tab.id === state.activeTabId,
    );
    useAgentChatStore.setState({
      tabs: [
        {
          ...draft,
          id: "history-height",
          sharedSessionId: "history-height",
          title: "History chat",
          draft: {
            input: "Line one\nLine two\nLine three",
            pinnedContexts: [],
          },
        },
        draft,
      ],
    });
  });
  const before = (await drawer.boundingBox())!.height;
  for (let i = 0; i < 5; i++) {
    await drawer.getByText("History chat", { exact: true }).click();
    await expect(drawer.locator("textarea:visible")).toHaveValue(
      "Line one\nLine two\nLine three",
    );
    await drawer.getByRole("button", { name: "New tab", exact: true }).click();
    await expect(drawer.locator("textarea:visible")).toHaveValue("");
    await page.waitForTimeout(180);
    expect((await drawer.boundingBox())!.height).toBeCloseTo(before, 0);
  }
});

test("rewind scaling cannot leave the drawer with scaled layout coordinates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openDrawer(page);
  const shell = page.locator('[data-chat-drawer-transition-shell="true"]');
  const before = (await shell.boundingBox())!;
  for (const scale of [0.86, 0.93]) {
    await page.evaluate((scale) => {
      const root = document.querySelector(
        "[data-input-transfer-harness-overlay]",
      )!.parentElement!;
      root.style.transform = `translateY(24px) scale(${scale})`;
      root.style.transformOrigin = "44% 60%";
    }, scale);
    // Force a real ResizeObserver measurement during rewind's ancestor transform.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(150);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(
        "[data-input-transfer-harness-overlay]",
      )!.parentElement!.style.transform = "none";
    });
    // Do not focus/click the editor or resize after returning to the present.
    await page.waitForTimeout(350);
    const after = (await shell.boundingBox())!;
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(Math.abs(after[key] - before[key])).toBeLessThan(1);
    }
  }
  await page.screenshot({
    path: test.info().outputPath("drawer-after-rewind.png"),
  });
});

for (const viewport of [
  { width: 1024, height: 640 },
  { width: 1440, height: 900 },
]) {
  test(`drawer animates both height directions at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/?debug=input-transfer");
    const drawer = page.locator('[data-chat-drawer-panel="true"]');
    await expect(drawer.locator("textarea:visible")).toBeVisible();
    await drawer.locator("textarea:visible").fill("Hello");
    await page.waitForTimeout(500);
    const collapsedHeight = (await drawer.boundingBox())!.height;
    for (const opening of [true, false]) {
      const frames = await drawer.evaluate(async (element) => {
        const samples: { height: number; bottom: number }[] = [];
        const sample = () => {
          const rect = element.getBoundingClientRect();
          samples.push({ height: rect.height, bottom: rect.bottom });
        };
        sample();
        element
          .querySelector<HTMLButtonElement>('[aria-label="Toggle drawer"]')!
          .click();
        const start = performance.now();
        while (performance.now() - start < 350) {
          await new Promise(requestAnimationFrame);
          sample();
        }
        return samples;
      });
      const first = frames[0];
      const last = frames[frames.length - 1];
      expect(
        opening ? last.height - first.height : first.height - last.height,
      ).toBeGreaterThan(40);
      const lower = Math.min(first.height, last.height);
      const upper = Math.max(first.height, last.height);
      expect(
        frames.filter(
          (frame) => frame.height > lower + 2 && frame.height < upper - 2,
        ).length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        Math.max(
          ...frames.map((frame) => Math.abs(frame.bottom - last.bottom)),
        ),
      ).toBeLessThan(1);
      if (!opening) expect(last.height).toBeCloseTo(collapsedHeight, 0);
    }
  });
}

test("sending a file adds context without expanding the drawer", async ({
  page,
}) => {
  await page.goto("/?debug=input-transfer");
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  await expect(drawer.locator("textarea:visible")).toBeVisible();
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
  await page.evaluate(async () => {
    const modulePath =
      "/src/renderer/components/workspace/sidebar-file-context-actions.tsx";
    const { sendSidebarFileToChat } = await import(modulePath);
    sendSidebarFileToChat({
      id: "notes.md",
      name: "notes.md",
      relativePath: "notes.md",
      absolutePath: "/tmp/notes.md",
      type: "other",
      content: "Notes",
      isDirty: false,
    });
  });
  await expect(
    drawer
      .locator('[data-context-label="true"]')
      .filter({ hasText: "@notes.md" })
      .first(),
  ).toBeVisible();
  await expect(drawer.locator("[data-chat-messages]")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/send-file-compact-drawer.png",
    animations: "disabled",
  });
});
