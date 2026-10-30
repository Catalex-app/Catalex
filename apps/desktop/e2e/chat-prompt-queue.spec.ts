import { expect, test } from "@playwright/test";

const state = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    const path = "/src/renderer/lib/desktop/bridge.ts";
    return (await import(path)).browserHarness().invoke("demo_state");
  });

test("queue prompts with Enter, drag to reorder, edit, remove, and dispatch in order", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/?debug=agent-file-review&textReview&queueDemo");
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  const rows = queue.locator("li");
  await expect(rows).toHaveCount(2);
  const input = page
    .locator(
      '[data-chat-drawer-panel="true"] textarea[data-chat-composer-input="true"]:visible',
    )
    .last();
  await input.fill("Check citations last.");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(rows).toHaveCount(3);
  expect((await state(page)).submittedPrompts).toEqual([]);

  const handle = await rows
    .nth(2)
    .getByRole("button", { name: "Move queued prompt 3", exact: true })
    .boundingBox();
  const destination = await rows.first().boundingBox();
  await page.mouse.move(handle.x + 12, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(handle.x + 12, handle.y - 4);
  await page.mouse.move(handle.x + 12, destination.y + 8, { steps: 8 });
  await page.mouse.up();
  await expect(rows.first()).toContainText("Check citations last.");
  await rows.first().hover();
  await rows
    .first()
    .getByRole("button", { name: "Edit queued prompt", exact: true })
    .click();
  await expect(input).toHaveValue("Check citations last.");
  await input.fill("Check citations first.");
  await input.press("Enter");
  await expect(rows.last()).toContainText("Check citations first.");
  await rows.nth(1).hover();
  await rows
    .nth(1)
    .getByRole("button", { name: "Remove queued prompt", exact: true })
    .click();
  await expect(rows).toHaveCount(2);
  await page.screenshot({ path: test.info().outputPath("prompt-queue.png") });

  await page
    .getByRole("button", { name: "Finish first turn", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).submittedPrompts.length)
    .toBe(1);
  expect((await state(page)).submittedPrompts[0]).toContain(
    "Summarize the main findings.",
  );
  await expect(rows).toHaveCount(1);
  await expect
    .poll(async () => (await state(page)).submittedPrompts.length)
    .toBe(2);
  expect((await state(page)).submittedPrompts[1]).toContain(
    "Check citations first.",
  );
  await expect(queue).toHaveCount(0);
});

test("queue rows sort vertically with a live gap, cancellation, and edge scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/?onboarding-demo&project");
  await page
    .getByRole("button", { name: "Start prompt queue", exact: true })
    .click();
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  const list = queue.locator("ol");
  const rows = list.locator("li");
  const firstId = await rows.first().getAttribute("data-queued-prompt-id");
  const first = rows.first();
  const before = await first.boundingBox();
  const next = await rows.nth(1).boundingBox();
  await page.mouse.move(before.x + 14, before.y + 14);
  await page.mouse.down();
  await page.mouse.move(before.x + 14, before.y + 20);
  await page.mouse.move(before.x + 140, next.y + 14, { steps: 8 });
  await expect(first).toHaveAttribute("data-queue-dragging", "true");
  await expect.poll(async () => (await first.boundingBox()).x).toBe(before.x);
  await expect
    .poll(async () => (await rows.nth(1).boundingBox()).y)
    .toBeLessThan(next.y - 20);
  await expect(rows.first()).toHaveAttribute("data-queued-prompt-id", firstId);
  await queue.screenshot({
    path: test.info().outputPath("queue-drag-preview.png"),
  });
  await page.mouse.up();
  await expect(rows.last()).toHaveAttribute("data-queued-prompt-id", firstId);

  // Escape cancels without saving the preview order.
  const order = await rows.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("data-queued-prompt-id")),
  );
  const handle = await rows
    .first()
    .getByRole("button", { name: "Move queued prompt 1", exact: true })
    .boundingBox();
  await page.mouse.move(handle.x + 12, handle.y + 12);
  await page.mouse.down();
  await page.mouse.move(handle.x + 12, handle.y + 40, { steps: 8 });
  await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(0);
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("data-queued-prompt-id")),
    ),
  ).toEqual(order);

  // Losing window focus must not leave a live drag behind.
  const blurHandle = await rows
    .first()
    .getByRole("button", { name: "Move queued prompt 1", exact: true })
    .boundingBox();
  await page.mouse.move(blurHandle.x + 12, blurHandle.y + 12);
  await page.mouse.down();
  await page.mouse.move(blurHandle.x + 12, blurHandle.y + 40, { steps: 8 });
  await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.mouse.up();
  await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(0);
  expect(
    await rows.evaluateAll((elements) =>
      elements.map((el) => el.getAttribute("data-queued-prompt-id")),
    ),
  ).toEqual(order);

  await page.setViewportSize({ width: 1280, height: 600 });
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBe(44);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    for (let i = 3; i <= 8; i++)
      store.enqueuePrompt(store.activeTabId, `Follow-up ${i}`, []);
  });
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  const scrollStart = await rows.first().boundingBox();
  const listBox = await list.boundingBox();
  const scrollingId = await rows.first().getAttribute("data-queued-prompt-id");
  await page.mouse.move(scrollStart.x + 14, scrollStart.y + 14);
  await page.mouse.down();
  await page.mouse.move(scrollStart.x + 14, scrollStart.y + 20);
  await page.mouse.move(scrollStart.x + 14, listBox.y + listBox.height - 2, {
    steps: 8,
  });
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(30);
  await page.mouse.up();
  await expect
    .poll(async () =>
      rows.evaluateAll(
        (elements, id) =>
          elements.findIndex(
            (el) => el.getAttribute("data-queued-prompt-id") === id,
          ),
        scrollingId,
      ),
    )
    .toBeGreaterThan(1);
  await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(0);
});

test("dragging beyond the queue keeps its natural scroll bounds and inset outline", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto("/?onboarding-demo&project");
  await page
    .getByRole("button", { name: "Start prompt queue", exact: true })
    .click();
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  const list = queue.locator("ol");
  for (const count of [2, 8]) {
    if (count === 8)
      await page.evaluate(async () => {
        const path = "/src/renderer/stores/agent-chat-store.ts";
        const store = (await import(path)).useAgentChatStore.getState();
        for (let i = 3; i <= 8; i++)
          store.enqueuePrompt(store.activeTabId, `Follow-up ${i}`, []);
      });
    await expect(list.locator("li")).toHaveCount(count);
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    const natural = await list.evaluate((el) => ({
      height: el.scrollHeight,
      viewport: el.clientHeight,
    }));
    const row = list.locator("li").first();
    const box = await row.boundingBox();
    const listBox = await list.boundingBox();
    await page.mouse.move(box.x + 14, box.y + 14);
    await page.mouse.down();
    await page.mouse.move(box.x + 14, box.y + 20);
    await page.mouse.move(box.x + 14, listBox.y + listBox.height + 80, {
      steps: 8,
    });
    await expect(row).toHaveAttribute("data-queue-dragging", "true");
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThanOrEqual(natural.height - natural.viewport - 1);
    const samples = await list.evaluate(async (el) => {
      const values = [];
      for (let i = 0; i < 20; i++) {
        await new Promise(requestAnimationFrame);
        values.push({ height: el.scrollHeight, top: el.scrollTop });
      }
      return values;
    });
    for (const sample of samples) {
      expect(sample.height).toBeLessThanOrEqual(natural.height);
      expect(sample.top).toBeLessThanOrEqual(natural.height - natural.viewport);
    }
    expect(
      await row.evaluate((el) => getComputedStyle(el).boxShadow),
    ).toContain("inset");
    await queue.screenshot({
      path: test.info().outputPath(`queue-bottom-drag-${count}.png`),
    });
    await page.mouse.up();
    await expect(queue.locator('[data-queue-dragging="true"]')).toHaveCount(0);
  }
});

test("withdrawing a prompt leaves the remaining queue running and sending requeues it", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview&queueDemo");
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  const rows = queue.locator("li");
  await expect(rows).toHaveCount(2);
  await rows
    .last()
    .getByRole("button", { name: "Move queued prompt 2", exact: true })
    .press("ArrowUp");
  await expect(rows.first()).toContainText("Check the limitations section.");
  await rows.first().hover();
  await rows
    .first()
    .getByRole("button", { name: "Edit queued prompt", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Summarize the main findings.");
  const input = page
    .locator(
      '[data-chat-drawer-panel="true"] textarea[data-chat-composer-input="true"]:visible',
    )
    .last();
  await input.fill("Still editing");
  await page
    .getByRole("button", { name: "Finish first turn", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).submittedPrompts.length)
    .toBe(1);
  expect((await state(page)).submittedPrompts[0]).toContain(
    "Summarize the main findings.",
  );
  await expect(queue).toHaveCount(0);
  await expect(input).toHaveValue("Still editing");
  await input.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Still editing");
  await expect(input).toHaveValue("");
});

test("an error holds pending prompts until recovery and explicit queue resume", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview&queueDemo");
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  await expect(queue.locator("li")).toHaveCount(2);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    store._setError(store.activeTabId, "Connection lost");
  });
  await page
    .getByRole("button", { name: "Finish first turn", exact: true })
    .click();
  await expect(queue).toContainText("Queue paused");
  expect((await state(page)).submittedPrompts).toEqual([]);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    store._setError(store.activeTabId, null);
  });
  await queue
    .getByRole("button", { name: "Resume queue", exact: true })
    .click();
  await expect
    .poll(async () => (await state(page)).submittedPrompts.length)
    .toBe(1);
});

test("edit replaces the normal composer draft without a cancel mode or previous draft restoration", async ({
  page,
}) => {
  await page.goto("/?debug=agent-file-review&textReview&queueDemo");
  const queue = page.locator(
    '[data-chat-drawer-panel="true"] [data-chat-prompt-queue="true"]',
  );
  await expect(queue.locator("li")).toHaveCount(2);
  const input = page
    .locator(
      '[data-chat-drawer-panel="true"] textarea[data-chat-composer-input="true"]:visible',
    )
    .last();
  await input.fill("My unfinished draft");
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    store.addPendingAttachment({
      label: "@draft.md",
      filePath: "draft.md",
      selectedText: "Draft attachment",
    });
  });
  const snapshot = () =>
    page.evaluate(async () => {
      const path = "/src/renderer/stores/agent-chat-store.ts";
      const store = (await import(path)).useAgentChatStore.getState();
      return store.tabs.find((tab) => tab.id === store.activeTabId);
    });
  await expect
    .poll(async () => (await snapshot()).draft.pinnedContexts.length)
    .toBe(1);
  await queue.locator("li").first().hover();
  await queue
    .locator("li")
    .first()
    .getByRole("button", { name: "Edit queued prompt", exact: true })
    .click();
  await expect(input).toHaveValue("Summarize the main findings.");
  await expect(queue.locator("li")).toHaveCount(1);
  await expect(queue).not.toContainText("Summarize the main findings.");
  await expect(input).toBeFocused();
  await expect
    .poll(async () => (await snapshot()).draft.pinnedContexts)
    .toEqual([]);
  await expect(
    page.getByRole("button", {
      name: "Cancel editing queued prompt",
      exact: true,
    }),
  ).toHaveCount(0);
  await input.fill("Edited findings");
  await page.screenshot({
    path: test.info().outputPath("editing-in-composer.png"),
  });
  await input.press("Enter");
  await expect(queue.locator("li").last()).toContainText("Edited findings");
  await expect(input).toHaveValue("");
  await expect
    .poll(async () => (await snapshot()).draft)
    .toEqual({ input: "", pinnedContexts: [] });
  expect((await snapshot()).queuedPrompts.at(-1).context).toEqual([]);
  await queue.locator("li").first().hover();
  await queue
    .locator("li")
    .first()
    .getByRole("button", { name: "Edit queued prompt", exact: true })
    .click();
  await expect(input).toHaveValue("Check the limitations section.");
  // Editing another item replaces the input directly; Escape does not restore it.
  await queue.locator("li").first().hover();
  await queue
    .locator("li")
    .first()
    .getByRole("button", { name: "Edit queued prompt", exact: true })
    .click();
  await expect(queue).toHaveCount(0);
  await expect(input).toHaveValue("Edited findings");
  await input.press("Escape");
  await expect(input).toHaveValue("Edited findings");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(queue.locator("li")).toHaveCount(1);
  expect((await state(page)).submittedPrompts).toEqual([]);
});

test("the normal dummy project can start and finish a prompt queue demo in place", async ({
  page,
}) => {
  await page.goto("/?onboarding-demo&project");
  const panel = page.locator('[data-chat-drawer-panel="true"]');
  const queue = panel.locator('[data-chat-prompt-queue="true"]');
  await page
    .getByRole("button", { name: "Start prompt queue", exact: true })
    .click();
  await expect(queue.locator("li")).toHaveCount(2);
  await expect(page).toHaveURL(/onboarding-demo&project$/);
  const input = panel
    .locator('textarea[data-chat-composer-input="true"]:visible')
    .last();
  await input.fill("Check citations too.");
  await input.press("Enter");
  await expect(queue.locator("li")).toHaveCount(3);
  await page.screenshot({
    path: test.info().outputPath("normal-demo-prompt-queue.png"),
  });
  await page
    .getByRole("button", { name: "Finish demo turn", exact: true })
    .click();
  await expect(queue.locator("li")).toHaveCount(2);
  await expect(queue).not.toContainText("Summarize the main findings.");
  await expect(queue).toHaveCount(0, { timeout: 15000 });
  const turns = await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    return store.tabs
      .find((tab) => tab.id === store.activeTabId)
      .messages.filter((message) => message.type === "user")
      .map((message) => message.message.content[0].text);
  });
  expect(turns).toEqual([
    "Polish the introduction.",
    "Summarize the main findings.",
    "Check the limitations section.",
    "Check citations too.",
  ]);
});

test("queue uses two-and-a-half or one-and-a-half rows based only on window height", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/?onboarding-demo&project");
  await page
    .getByRole("button", { name: "Start prompt queue", exact: true })
    .click();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    for (let i = 3; i <= 8; i++)
      store.enqueuePrompt(store.activeTabId, `Follow-up ${i}`, []);
  });
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const list = drawer.locator('[data-chat-prompt-queue="true"] ol');
  await expect(list.locator("li")).toHaveCount(8);
  const geometry = (locator: import("@playwright/test").Locator) =>
    locator.evaluate((el) => ({
      height: el.clientHeight,
      scrollHeight: el.scrollHeight,
      rowHeight: el.querySelector("li").getBoundingClientRect().height,
    }));
  await expect.poll(async () => (await geometry(list)).height).toBe(74);
  const normal = await geometry(list);
  expect(normal.scrollHeight).toBeGreaterThan(normal.height);
  expect(normal.height).toBeGreaterThan(normal.rowHeight);
  await page.setViewportSize({ width: 1280, height: 651 });
  await expect.poll(async () => (await geometry(list)).height).toBe(74);
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect.poll(async () => (await geometry(list)).height).toBe(44);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForTimeout(350);
  await expect.poll(async () => (await geometry(list)).height).toBe(44);
  const small = await geometry(list);
  expect(small.height).toBeGreaterThan(small.rowHeight);
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(list.locator("li").last()).toBeInViewport({ ratio: 0.98 });
  const toolbar = drawer.locator("[data-chat-composer-toolbar]");
  const panelBox = await drawer.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(
    panelBox.y + panelBox.height,
  );
  await page.screenshot({
    path: test.info().outputPath("small-half-queue.png"),
  });
  await page
    .getByRole("button", { name: "Toggle drawer", exact: true })
    .locator("..")
    .hover();
  await page.getByRole("button", { name: "Full", exact: true }).click();
  const fullList = page.locator(
    '[data-workspace-panel-screen="true"] [data-chat-prompt-queue="true"] ol',
  );
  await expect(fullList).toBeVisible();
  await expect.poll(async () => (await geometry(fullList)).height).toBe(44);
  await page.getByRole("button", { name: "Mini", exact: true }).click();
  await page.mouse.move(100, 100);
  await expect(list).toBeHidden();
  await drawer.getByRole("button", { name: "Queued · 8", exact: true }).click();
  await expect(list).toBeVisible();
  await expect.poll(async () => (await geometry(list)).height).toBe(44);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await expect.poll(async () => (await geometry(list)).height).toBe(74);
});

test("queue folding is remembered independently per mode and shared across chats", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.goto("/?onboarding-demo&project");
  await page
    .getByRole("button", { name: "Start prompt queue", exact: true })
    .click();
  const drawer = page.locator('[data-chat-drawer-panel="true"]');
  const halfHeader = drawer.getByRole("button", {
    name: "Queued · 2",
    exact: true,
  });
  const drawerList = drawer.locator('[data-chat-prompt-queue="true"] ol');
  const mode = async (name: "Mini" | "Half" | "Full") => {
    if (
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .isVisible()
    )
      await page
        .getByRole("button", { name: "Toggle drawer", exact: true })
        .locator("..")
        .hover();
    const button = page.getByRole("button", { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(button).toBeEnabled();
    await page.mouse.move(100, 100);
    if (name === "Full")
      await expect(
        page
          .locator('[data-workspace-panel-screen="true"]')
          .filter({ has: page.locator('[data-chat-prompt-queue="true"]') }),
      ).toBeVisible();
  };
  await expect(halfHeader).toHaveAttribute("aria-expanded", "true");
  await halfHeader.click();
  await expect(drawerList).toBeHidden();
  await mode("Mini");
  await expect(halfHeader).toHaveAttribute("aria-expanded", "false");
  await halfHeader.click();
  await expect(drawerList).toBeVisible();
  await mode("Half");
  await expect(drawerList).toBeHidden();
  await mode("Full");
  const panel = page.locator('[data-workspace-panel-screen="true"]');
  const fullHeader = panel.getByRole("button", {
    name: "Queued · 2",
    exact: true,
  });
  await expect(fullHeader).toHaveAttribute("aria-expanded", "true");
  await fullHeader.click();
  await expect(
    panel.locator('[data-chat-prompt-queue="true"] ol'),
  ).toBeHidden();
  await mode("Mini");
  await expect(drawerList).toBeVisible();
  await mode("Full");
  await expect(fullHeader).toHaveAttribute("aria-expanded", "false");
  await expect(
    panel.locator('[data-chat-composer-shell="true"]'),
  ).toHaveAttribute("data-composer-transfer-phase", "idle");
  await expect(fullHeader).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath("folded-queue.png") });
  await fullHeader.focus();
  await expect(fullHeader).toBeFocused();
  await fullHeader.press("Enter");
  await expect(fullHeader).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({ path: test.info().outputPath("expanded-queue.png") });
  await mode("Mini");
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore.getState();
    const id = store.createTab();
    store.enqueuePrompt(id, "Another chat's queued prompt", []);
  });
  const newHeader = drawer.getByRole("button", {
    name: "Queued · 1",
    exact: true,
  });
  await expect(newHeader).toHaveAttribute("aria-expanded", "true");
});
