import { expect, test, type Page } from "@playwright/test";

async function workspace(page: Page) {
  await page.addInitScript(() => {
    window.addEventListener(
      "app-visibility-restored",
      () => {
        document.documentElement.dataset.startupRecovered = "true";
      },
      { once: true },
    );
  });
  await page.goto("/?debug=input-transfer");
  await expect(
    page.locator("[data-chat-drawer-panel] [data-chat-composer-input]:visible"),
  ).toHaveCount(1);
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-startup-recovered",
    "true",
  );
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
}

async function activeTab(page: Page) {
  return page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const state = (await import(path)).useAgentChatStore.getState();
    return state.tabs.find(
      (tab: { id: string }) => tab.id === state.activeTabId,
    );
  });
}

test("Fix issues follows editor diagnostics and selection scope, preserving the draft on send", async ({
  page,
}) => {
  await workspace(page);
  const suggestions = page.locator('[data-prompt-suggestions="compact"]');
  const fix = suggestions.getByRole("button", {
    name: "Fix issues",
    exact: true,
  });
  await expect(suggestions.locator("[data-prompt-scroll] button")).toHaveText([
    "Improve writing",
    "Fix issues",
    "Review & comment",
    "Tighten layout",
  ]);
  // Supply compiler results through the normal document cache. The editor must
  // map them into CodeMirror before the prompt bar can see them.
  // The browser harness has no compiler; let its initial attempt settle first.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/renderer/stores/document-store.ts";
        const state = (await import(path)).useDocumentStore.getState();
        return !state.isCompiling && state.compileErrorCache.has("main.tex");
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/settings-store.ts";
    (await import(path)).useSettingsStore
      .getState()
      .setProjectAutoCompile("/tmp/harness", false);
  });
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const store = (await import(path)).useDocumentStore;
    store.setState({
      compileDiagnosticsCache: new Map([
        [
          "main.tex",
          [
            {
              file: "main.tex",
              line: 5,
              severity: "error",
              message: "Selected diagnostic",
            },
            {
              file: "main.tex",
              line: 2,
              severity: "warning",
              message: "Unrelated diagnostic",
            },
          ],
        ],
      ]),
      compileErrorCache: new Map(),
    });
  });
  await expect(fix).toBeEnabled();
  // An external same-length edit can leave every diagnostic range unchanged.
  // Its snapshot still needs the new content after the editor synchronizes.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/renderer/stores/document-store.ts";
        return (await import(path)).useDocumentStore
          .getState()
          .promptDiagnostics?.issues.some(
            (issue: { message: string }) =>
              issue.message === "Selected diagnostic",
          );
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    const state = (await import(path)).useDocumentStore.getState();
    const file = state.files.find(
      (file: { id: string }) => file.id === "main.tex",
    );
    state.updateFileContent(
      "main.tex",
      file.content.replace("Harness sample", "Harness update"),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/renderer/stores/document-store.ts";
        return (await import(path)).useDocumentStore
          .getState()
          .promptDiagnostics?.content.includes("Harness update");
      }),
    )
    .toBe(true);
  await expect(fix).toBeEnabled();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Harness update"),
  );
  await expect(fix).toBeDisabled();
  await suggestions
    .getByRole("button", { name: "All prompts", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Fix issues", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  await expect(fix).toBeEnabled();
  const input = page.locator(
    "[data-chat-drawer-panel] [data-chat-composer-input]:visible",
  );
  await input.fill("Keep my draft question");
  await page
    .locator("[data-chat-drawer-panel]")
    .screenshot({ path: test.info().outputPath("fix-issues-mini.png") });
  const before = await activeTab(page);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const send = store.getState().sendPrompt;
    store.setState({
      sendPrompt: (prompt: string, context: unknown) =>
        send(prompt, context, false, () => {
          const state = store.getState();
          state.pauseExecution(state.activeTabId);
        }),
    });
  });
  await fix.click();
  await expect
    .poll(
      async () =>
        (await activeTab(page)).pausedRequest?.context?.[0]?.diagnostics,
    )
    .toEqual([{ line: 5, severity: "error", message: "Selected diagnostic" }]);
  const after = await activeTab(page);
  expect(after.id).toBe(before.id);
  expect(after.messages.slice(0, before.messages.length)).toEqual(
    before.messages,
  );
  expect(after.pausedRequest.context[0].selectedText).toBe("Hello harness");
  expect(after.draft).toEqual(before.draft);
  await expect(input).toHaveValue("Keep my draft question");
  await suggestions
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/document-store.ts";
    (await import(path)).useDocumentStore.setState({
      compileDiagnosticsCache: new Map(),
      compileErrorCache: new Map(),
    });
  });
  await expect(fix).toBeDisabled();
});

test("mini prompts toggle explicitly, retain drafts/history, and fold after sending", async ({
  page,
}) => {
  await workspace(page);
  const suggestions = page.locator('[data-prompt-suggestions="compact"]');
  const input = page.locator(
    "[data-chat-drawer-panel] [data-chat-composer-input]:visible",
  );
  await expect(suggestions).toBeVisible();
  await expect(
    suggestions
      .getByRole("button", { name: "Improve writing", exact: true })
      .locator("svg.lucide-spell-check"),
  ).toHaveCount(1);
  const selector = page
    .locator("[data-chat-drawer-panel]")
    .getByRole("button", { name: "Session history", exact: true });
  expect((await suggestions.boundingBox())!.height).toBe(
    (await selector.boundingBox())!.height,
  );
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const state = (await import(path)).useAgentChatStore.getState();
    state._setError(state.activeTabId, "Send was rejected");
  });
  await expect(suggestions.locator("[data-prompt-scroll]")).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const state = (await import(path)).useAgentChatStore.getState();
    state._setError(state.activeTabId, null);
  });
  await suggestions
    .getByRole("button", { name: "Hide prompts", exact: true })
    .click();
  await input.fill("Keep this draft");
  await expect(suggestions.locator("[data-prompt-scroll]")).toBeHidden();
  await suggestions
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  const drawer = page.locator("[data-chat-drawer-panel]");
  const scroll = suggestions.locator("[data-prompt-scroll]");
  await expect(scroll.getByRole("button")).toHaveCount(4);
  const originalStyle = await drawer.getAttribute("style");
  const originalViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 2400, height: 900 });
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true);
  await drawer.screenshot({
    path: test.info().outputPath("grouped-strip-wide.png"),
  });
  await page.setViewportSize(originalViewport);
  await drawer.evaluate((element) => {
    element.style.width = "300px";
    element.style.minWidth = "300px";
  });
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollWidth > element.clientWidth),
    )
    .toBe(true);
  await scroll.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await page.mouse.wheel(0, -600);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBe(0);
  await page.mouse.wheel(600, 0);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  const lastPrompt = scroll.getByRole("button", {
    name: "Tighten layout",
    exact: true,
  });
  await expect(lastPrompt).toBeInViewport();
  await drawer.screenshot({
    path: test.info().outputPath("grouped-strip-narrow-scrolled.png"),
  });
  await drawer.evaluate((element, style) => {
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
  }, originalStyle);
  await scroll.evaluate((element) => {
    element.scrollLeft = 0;
  });
  await page
    .locator("[data-chat-drawer-panel]")
    .screenshot({ path: test.info().outputPath("grouped-strip-light.png") });
  await input.fill("");
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const messages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Existing answer" }] },
      },
    ];
    store.setState((state: any) => ({
      messages,
      tabs: state.tabs.map((tab: any) => ({
        ...tab,
        messages,
        miniPromptsExpanded: undefined,
      })),
    }));
  });
  await expect(scroll).toBeHidden();
  await expect(
    suggestions.getByRole("button", { name: "All prompts", exact: true }),
  ).toHaveCount(0);
  await expect(suggestions.getByRole("button")).toHaveCount(1);
  await expect(page.getByTestId("collapsed-chat-status")).toBeVisible();
  await input.fill("Keep my unfinished question");
  await expect(scroll).toBeHidden();
  await page.evaluate(() =>
    window.__selectInputTransferHarnessText?.("Hello harness"),
  );
  await expect(scroll).toBeHidden();
  await drawer.screenshot({
    path: test.info().outputPath("mini-prompts-folded.png"),
    animations: "disabled",
  });
  await suggestions
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  await expect(scroll).toBeVisible();
  await suggestions
    .getByRole("button", { name: "Hide prompts", exact: true })
    .click();
  await expect(scroll).toBeHidden();
  await suggestions
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  await expect(scroll).toBeVisible();

  await suggestions
    .getByRole("button", { name: "All prompts", exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Review & comment", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(input).toHaveAttribute(
    "placeholder",
    "Ask about this selection…",
  );
  const before = await activeTab(page);
  // Retain the real send path, while pausing after request acceptance before any native preparation.
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const send = store.getState().sendPrompt;
    store.setState({
      sendPrompt: (prompt: string, context: unknown) =>
        send(prompt, context, false, () => {
          const state = store.getState();
          state.pauseExecution(state.activeTabId);
        }),
    });
  });
  await suggestions
    .getByRole("button", { name: "All prompts", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Review & comment", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await activeTab(page)).messages.filter(
          (message: { type: string }) => message.type === "user",
        ).length,
    )
    .toBe(1);
  const after = await activeTab(page);
  expect(after.id).toBe(before.id);
  expect(after.messages[0]).toEqual(before.messages[0]);
  const sent = after.messages.find(
    (message: { type: string }) => message.type === "user",
  );
  expect(sent.message.content[0].text).toContain("Use the create_comment tool");
  expect(sent.message.content[0].text).not.toContain(
    "Keep my unfinished question",
  );
  expect(after.pausedRequest.context[0].selectedText).toBe("Hello harness");
  await expect(input).toHaveValue("Keep my unfinished question");
  expect(after.draft).toEqual(before.draft);
  await expect(scroll).toBeHidden();
  await expect(
    suggestions.getByRole("button", { name: "Show prompts", exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("collapsed-chat-status")).toBeVisible();
  await suggestions
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  await expect(scroll).toBeVisible();
  await expect(
    suggestions.getByRole("button", { name: "All prompts", exact: true }),
  ).toBeVisible();
});

test("Mini pin overrides sends and chat defaults, persists, and unpins in one click", async ({
  page,
  context,
}) => {
  await workspace(page);
  const drawer = page.locator("[data-chat-drawer-panel]");
  const strip = drawer.locator('[data-prompt-suggestions="compact"]');
  await drawer
    .locator("[data-chat-composer-input]:visible")
    .fill("Preserve this empty chat");
  await expect(drawer.locator("[data-mini-status-icon]")).toHaveCount(0);
  const newId = (await activeTab(page)).id;
  const switchTo = (id: string) =>
    page.evaluate(async (id) => {
      const path = "/src/renderer/stores/agent-chat-store.ts";
      (await import(path)).useAgentChatStore.getState().setActiveTab(id);
    }, id);
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const state = store.getState();
    const source = state.tabs.find((tab: any) => tab.id === state.activeTabId);
    store.setState({
      tabs: [
        ...state.tabs,
        {
          ...source,
          id: "existing-prompt-test",
          runtimeSessionKey: "existing-prompt-test",
          title: "Polish the introduction",
          miniPromptsExpanded: undefined,
          draft: { input: "", pinnedContexts: [] },
          messages: [
            {
              type: "assistant",
              message: { content: [{ type: "text", text: "Existing reply" }] },
            },
          ],
        },
      ],
    });
  });
  await strip
    .getByRole("button", { name: "Hide prompts", exact: true })
    .click();
  await switchTo("existing-prompt-test");
  await strip
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  await switchTo(newId);
  await expect(
    strip.getByRole("button", { name: "Hide prompts", exact: true }),
  ).toBeVisible();
  await switchTo("existing-prompt-test");
  await expect(
    strip.getByRole("button", { name: "Show prompts", exact: true }),
  ).toBeVisible();
  await strip
    .getByRole("button", { name: "Show prompts", exact: true })
    .click();
  const statusIcon = drawer.locator("[data-mini-status-icon]");
  await expect(statusIcon).toBeVisible();
  await expect(drawer.getByTestId("collapsed-chat-status")).toBeHidden();
  await statusIcon.hover();
  await expect(
    page.getByRole("tooltip", { name: "Existing reply" }),
  ).toBeVisible();
  const iconBox = (await statusIcon.boundingBox())!;
  const stripBox = (await strip.boundingBox())!;
  expect(iconBox.x + iconBox.width).toBeLessThan(stripBox.x);
  await page.mouse.move(0, 0);
  await drawer.screenshot({
    path: test.info().outputPath("mini-expanded-status.png"),
    animations: "disabled",
  });
  const originalDrawerStyle = await drawer.getAttribute("style");
  for (const width of [420, 300, 640]) {
    if (width === 640) await page.setViewportSize({ width: 1800, height: 900 });
    await drawer.evaluate((element, width) => {
      element.style.width = `${width}px`;
      element.style.minWidth = `${width}px`;
    }, width);
    const selector = drawer.getByRole("button", {
      name: "Session history",
      exact: true,
    });
    const selectorBox = (await selector.boundingBox())!;
    const statusBox = (await statusIcon.boundingBox())!;
    const promptBox = (await strip.boundingBox())!;
    expect(selectorBox.width).toBeLessThanOrEqual(Math.min(190, width * 0.32));
    expect(statusBox.x + statusBox.width).toBeLessThan(promptBox.x);
    expect(promptBox.width).toBeGreaterThan(width * 0.4);
    await drawer.screenshot({
      path: test.info().outputPath(`mini-compact-${width}.png`),
      animations: "disabled",
    });
  }
  await drawer.evaluate((element, style) => {
    if (style === null) element.removeAttribute("style");
    else element.setAttribute("style", style);
  }, originalDrawerStyle);

  await strip.getByRole("button", { name: "All prompts", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }).click();
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const send = store.getState().sendPrompt;
    store.setState({
      sendPrompt: (prompt: string, context: unknown) =>
        send(prompt, context, false, () => {
          const state = store.getState();
          state.pauseExecution(state.activeTabId);
        }),
    });
  });
  await strip
    .getByRole("button", { name: "Improve writing", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await activeTab(page)).messages.filter(
          (message: any) => message.type === "user",
        ).length,
    )
    .toBe(1);
  await expect(strip.locator("[data-prompt-scroll]")).toBeVisible();
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await expect(statusIcon).toBeVisible();
  await expect(drawer.getByTestId("collapsed-chat-status")).toBeHidden();
  await drawer.screenshot({
    path: test.info().outputPath("mini-pinned-status.png"),
    animations: "disabled",
  });
  await switchTo(newId);
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await strip.getByRole("button", { name: "All prompts", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }),
  ).toBeChecked();
  await page.screenshot({
    path: test.info().outputPath("mini-pin-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await drawer.screenshot({
    path: test.info().outputPath("mini-pinned.png"),
    animations: "disabled",
  });
  await page.reload();
  await page.locator("#loading-screen").waitFor({ state: "hidden" });
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  const other = await context.newPage();
  await workspace(other);
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await page
    .locator("[data-input-transfer-harness-overlay]")
    .evaluate((element) => element.remove());
  await strip.getByRole("button", { name: "Unpin and collapse" }).click();
  await expect(strip.locator("[data-prompt-scroll]")).toBeHidden();
  await expect(
    strip.getByRole("button", { name: "Show prompts", exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole("button", { name: "Unpin and collapse" }),
  ).toHaveCount(0);
});

test("Mini presentation fades consistently across chat and prompt states", async ({
  page,
}) => {
  await workspace(page);
  const drawer = page.locator("[data-chat-drawer-panel]");
  await drawer
    .locator("[data-chat-composer-input]:visible")
    .fill("Keep my new draft");
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const state = store.getState();
    const draft = state.tabs.find((tab: any) => tab.id === state.activeTabId);
    store.setState({
      tabs: [
        ...state.tabs,
        {
          ...draft,
          id: "motion-existing",
          title: "Polish the introduction",
          sharedSessionId: "motion-existing",
          draft: { input: "Keep my new draft", pinnedContexts: [] },
          messages: [
            {
              type: "assistant",
              message: {
                content: [{ type: "text", text: "Ready for another edit" }],
              },
            },
          ],
        },
      ],
    });
  });
  const sample = (action: string) =>
    page.evaluate(async (action) => {
      const chatPath = "/src/renderer/stores/agent-chat-store.ts";
      const settingsPath = "/src/renderer/stores/settings-store.ts";
      const chat = (await import(chatPath)).useAgentChatStore.getState();
      const settings = (await import(settingsPath)).useSettingsStore.getState();
      const bar = document.querySelector<HTMLElement>("[data-mini-chat-bar]")!;
      const input = document.querySelector<HTMLElement>(
        "[data-chat-drawer-panel] [data-chat-composer-input]",
      )!;
      const inputTop = input.getBoundingClientRect().top;
      if (action === "existing") chat.setActiveTab("motion-existing");
      else if (action === "new") {
        const button = bar.querySelector<HTMLButtonElement>(
          '[aria-label="New chat"]',
        );
        if (button) button.click();
        else chat.requestNewChat();
      } else if (action === "open")
        chat.setMiniPromptsExpanded(chat.activeTabId, true);
      else if (action === "close")
        chat.setMiniPromptsExpanded(chat.activeTabId, false);
      else if (action === "pin") settings.setKeepMiniPromptsOpen(true);
      else if (action === "unpin")
        bar
          .querySelector<HTMLButtonElement>(
            '[aria-label="Unpin and collapse"]',
          )!
          .click();
      const frames: { opacity: number; inputTop: number }[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const read = () => {
          frames.push({
            opacity: Number(getComputedStyle(bar).opacity),
            inputTop: input.getBoundingClientRect().top,
          });
          const elapsed = performance.now() - start;
          if (
            elapsed < 260 ||
            (bar.getAnimations().length > 0 && elapsed < 1000)
          )
            requestAnimationFrame(read);
          else resolve();
        };
        requestAnimationFrame(read);
      });
      return { frames, inputTop };
    }, action);
  // The same fade covers both directions, including new chats reopening automatically.
  for (const action of [
    "existing",
    "new",
    "close",
    "new",
    "existing",
    "open",
    "new",
    "pin",
    "existing",
    "new",
    "unpin",
  ]) {
    const { frames, inputTop } = await sample(action);
    expect(
      frames.some((frame) => frame.opacity > 0.65 && frame.opacity < 0.99),
      action,
    ).toBe(true);
    expect(frames.at(-1)!.opacity, action).toBe(1);
    expect(
      Math.max(...frames.map((frame) => Math.abs(frame.inputTop - inputTop))),
      action,
    ).toBeLessThan(1);
  }
  await drawer
    .locator("[data-chat-composer-input]:visible")
    .fill("Typing does not fade the header");
  expect(
    await drawer
      .locator("[data-mini-chat-bar]")
      .evaluate((el) => el.getAnimations().length),
  ).toBe(0);
  // Inspect a held intermediate frame without remounting the row or composer.
  await sample("existing");
  await page.evaluate(async () => {
    const bar = document.querySelector<HTMLElement>("[data-mini-chat-bar]")!;
    bar.querySelector<HTMLButtonElement>('[aria-label="New chat"]')!.click();
    await new Promise(requestAnimationFrame);
    for (const animation of bar.getAnimations()) {
      animation.pause();
      animation.currentTime = 80;
    }
  });
  await drawer.screenshot({
    path: test.info().outputPath("mini-new-chat-fade.png"),
    animations: "allow",
  });
  await page.evaluate(() =>
    document
      .querySelector("[data-mini-chat-bar]")!
      .getAnimations()
      .forEach((animation) => animation.finish()),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const action of ["existing", "pin", "new", "unpin"]) {
    const { frames } = await sample(action);
    expect(
      frames.every((frame) => frame.opacity === 1),
      action,
    ).toBe(true);
  }
});

test("Mini prompt animation keeps the input steady and supports reduced motion", async ({
  page,
}) => {
  await workspace(page);
  const strip = page.locator('[data-prompt-suggestions="compact"]');
  const drawer = page.locator("[data-chat-drawer-panel]");
  const sample = (expanded: boolean) =>
    page.evaluate(async (expanded) => {
      const element = document.querySelector<HTMLElement>(
        '[data-prompt-suggestions="compact"]',
      )!;
      const input = document.querySelector<HTMLElement>(
        "[data-chat-drawer-panel] [data-chat-composer-input]",
      )!;
      const path = "/src/renderer/stores/agent-chat-store.ts";
      const store = (await import(path)).useAgentChatStore.getState();
      const samples: Array<{ width: number; right: number; inputTop: number }> =
        [];
      const read = () => {
        const box = element.getBoundingClientRect();
        samples.push({
          width: box.width,
          right: box.right,
          inputTop: input.getBoundingClientRect().top,
        });
      };
      read();
      store.setMiniPromptsExpanded(store.activeTabId, expanded);
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const frame = () => {
          read();
          if (performance.now() - start < 300) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      return samples;
    }, expanded);
  for (const expanded of [false, true]) {
    const frames = await sample(expanded);
    const widths = frames.map((frame) => frame.width);
    const low = Math.min(...widths),
      high = Math.max(...widths);
    expect(low).toBeCloseTo(23, 0);
    expect(high).toBeGreaterThan(150);
    expect(widths.some((width) => width > low + 5 && width < high - 5)).toBe(
      true,
    );
    expect(
      Math.max(...frames.map((frame) => frame.right)) -
        Math.min(...frames.map((frame) => frame.right)),
    ).toBeLessThan(1);
    expect(
      Math.max(...frames.map((frame) => frame.inputTop)) -
        Math.min(...frames.map((frame) => frame.inputTop)),
    ).toBeLessThan(1);
    await test.info().attach(expanded ? "opening-frames" : "closing-frames", {
      body: JSON.stringify(frames),
      contentType: "application/json",
    });
  }
  // Capture the real in-between state, then reverse the animation before it finishes.
  await strip
    .getByRole("button", { name: "Hide prompts", exact: true })
    .click();
  await page.waitForTimeout(70);
  await drawer.screenshot({
    path: test.info().outputPath("mini-closing.png"),
    animations: "allow",
  });
  await strip
    .getByRole("button", { name: "Show prompts", exact: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(
    strip.getByRole("button", { name: "Hide prompts", exact: true }),
  ).toBeVisible();
  await expect(strip.locator("[data-prompt-scroll]")).toBeVisible();
  await drawer.screenshot({
    path: test.info().outputPath("mini-expanded.png"),
    animations: "disabled",
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await strip.evaluate(
      (element) => getComputedStyle(element).transitionProperty,
    ),
  ).toBe("none");
  await strip
    .getByRole("button", { name: "Hide prompts", exact: true })
    .click();
  await expect(strip.locator("[data-prompt-scroll]")).toBeHidden();
  expect((await strip.boundingBox())!.width).toBe(23);
  await drawer.screenshot({
    path: test.info().outputPath("mini-folded.png"),
    animations: "disabled",
  });
});

test("one prompt pin follows Mini, Half, and Full through sends and unpinning", async ({
  page,
}) => {
  await workspace(page);
  const switchMode = async (mode: string) => {
    const control = page.locator(`[data-chat-display="${mode}"]`);
    await expect(control).toBeEnabled();
    await control.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    const panel = page.locator(
      mode === "Workspace"
        ? "[data-workspace-chat-pane]"
        : "[data-chat-drawer-panel]",
    );
    const strip = panel.locator(
      `[data-prompt-suggestions="${mode === "Collapsed" ? "compact" : "cards"}"]:visible`,
    );
    await expect(panel.locator("[data-chat-composer-shell]")).toHaveAttribute(
      "data-composer-transfer-phase",
      "idle",
    );
    await expect(strip).toHaveCount(1);
    await expect(strip).toBeVisible();
    return { panel, strip };
  };
  let { panel, strip } = await switchMode("Expanded");
  await panel
    .locator("[data-chat-composer-input]:visible")
    .fill("Keep my draft across modes");
  await expect
    .poll(async () => (await activeTab(page)).draft.input)
    .toBe("Keep my draft across modes");
  await strip.getByRole("button", { name: "All prompts", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }).click();
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await panel.screenshot({
    path: test.info().outputPath("shared-pin-half.png"),
    animations: "disabled",
  });

  ({ panel, strip } = await switchMode("Workspace"));
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await strip.getByRole("button", { name: "All prompts", exact: true }).click();
  await expect(
    page.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await page.evaluate(async () => {
    const path = "/src/renderer/stores/agent-chat-store.ts";
    const store = (await import(path)).useAgentChatStore;
    const send = store.getState().sendPrompt;
    store.setState({
      sendPrompt: (prompt: string, context: unknown) =>
        send(prompt, context, false, () => {
          const state = store.getState();
          state.pauseExecution(state.activeTabId);
        }),
    });
  });
  await strip.getByRole("button", { name: /^Improve writing/ }).click();
  await expect
    .poll(async () =>
      (await activeTab(page)).messages.some(
        (message: any) => message.type === "user",
      ),
    )
    .toBe(true);
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await expect(strip.locator("[data-prompt-scroll]")).toBeVisible();
  await expect(panel.locator("[data-chat-composer-input]:visible")).toHaveValue(
    "Keep my draft across modes",
  );
  await panel.screenshot({
    path: test.info().outputPath("shared-pin-full-existing.png"),
    animations: "disabled",
  });

  ({ strip } = await switchMode("Collapsed"));
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  ({ strip } = await switchMode("Expanded"));
  await strip.getByRole("button", { name: "Unpin and collapse" }).click();
  await expect(
    strip.getByRole("button", { name: "Show prompt cards" }),
  ).toBeVisible();
  await expect(strip.locator("[data-prompt-scroll]")).toBeHidden();
  ({ panel, strip } = await switchMode("Workspace"));
  await expect(
    strip.getByRole("button", { name: "Show prompt cards" }),
  ).toBeVisible();
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toHaveCount(0);
  // Reopen the floating control to pin an existing chat from the strip's menu.
  await strip.getByRole("button", { name: "Show prompt cards" }).click();
  await strip.getByRole("button", { name: "All prompts", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }).click();
  await expect(
    strip.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  ({ strip } = await switchMode("Collapsed"));
  await strip.getByRole("button", { name: "Unpin and collapse" }).click();
  await expect(
    strip.getByRole("button", { name: "Show prompts", exact: true }),
  ).toBeVisible();
  ({ strip } = await switchMode("Workspace"));
  await expect(
    strip.getByRole("button", { name: "Show prompt cards" }),
  ).toBeVisible();
});

for (const display of ["Expanded", "Workspace"]) {
  test(`prompt cards and menu in ${display} preserve the composer`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1300, height: 900 });
    await workspace(page);
    await page.evaluate(async () => {
      const path = "/src/renderer/stores/settings-store.ts";
      (await import(path)).useSettingsStore.getState().saveLibraryPrompt({
        id: "check-terminology",
        title: "Check terminology",
        prompt: "Check terminology for consistency.",
        availability: "always",
        enabled: true,
      });
    });
    const control = page.locator(`[data-chat-display="${display}"]`);
    await expect(control).toBeEnabled();
    await control.evaluate((element) => (element as HTMLButtonElement).click());
    const panel = page.locator(
      display === "Workspace"
        ? "[data-workspace-chat-pane]"
        : "[data-chat-drawer-panel]",
    );
    const cards = panel.locator('[data-prompt-suggestions="cards"]:visible');
    await expect(cards).toHaveCount(1);
    await expect(control).toBeEnabled();
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    const input = panel.locator("[data-chat-composer-input]:visible");
    await input.fill("My draft stays here");
    await expect(
      cards.getByRole("button", { name: /^Improve writing/ }),
    ).toBeEnabled();
    const scroll = cards.locator("[data-prompt-scroll]");
    await expect(scroll.getByRole("button")).toHaveCount(4);
    const cardTops = await scroll
      .getByRole("button")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().top),
      );
    expect(new Set(cardTops).size).toBe(1);
    const allPrompts = cards.getByRole("button", {
      name: "All prompts",
      exact: true,
    });
    const headerBox = (await allPrompts.boundingBox())!;
    const rowBox = (await scroll.boundingBox())!;
    const expandedBox = (await cards.boundingBox())!;
    const composerBox = (await panel
      .locator("[data-chat-composer-surface]:visible")
      .boundingBox())!;
    const foldBox = (await cards
      .getByRole("button", { name: "Hide prompt cards" })
      .boundingBox())!;
    expect(headerBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);
    expect(headerBox.width).toBeLessThanOrEqual(24);
    expect(foldBox.x).toBe(headerBox.x);
    expect(foldBox.y + foldBox.height).toBeCloseTo(headerBox.y, 0);
    expect(headerBox.y + headerBox.height).toBeCloseTo(
      rowBox.y + rowBox.height,
      0,
    );
    expect(composerBox.y - rowBox.y - rowBox.height).toBeGreaterThanOrEqual(0);
    expect(composerBox.y - rowBox.y - rowBox.height).toBeLessThanOrEqual(12);
    await page.screenshot({
      path: test.info().outputPath(`prompt-cards-${display}.png`),
      animations: "disabled",
    });
    await scroll.hover();
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(
      scroll.getByRole("button", { name: /^Tighten layout/ }),
    ).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath(`prompt-cards-${display}-scrolled.png`),
      animations: "disabled",
    });
    await page.mouse.wheel(0, -1200);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollLeft))
      .toBe(0);
    const shelf = panel.locator("[data-prompt-shelf]");
    for (const expanded of [false, true]) {
      const frames = await shelf.evaluate(async (element, expanded) => {
        const surface = element.querySelector<HTMLElement>(
          "[data-prompt-suggestions]",
        )!;
        const path = "/src/renderer/stores/agent-chat-store.ts";
        const store = (await import(path)).useAgentChatStore.getState();
        const frames: Array<{
          width: number;
          height: number;
          connected: boolean;
        }> = [];
        const read = () => {
          const rect = surface.getBoundingClientRect();
          frames.push({
            width: rect.width,
            height: rect.height,
            connected: surface.isConnected,
          });
        };
        read();
        store.setMiniPromptsExpanded(store.activeTabId, expanded);
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const frame = () => {
            read();
            if (performance.now() - start < 300) requestAnimationFrame(frame);
            else resolve();
          };
          requestAnimationFrame(frame);
        });
        return frames;
      }, expanded);
      expect(frames.every((frame) => frame.connected)).toBe(true);
      for (const dimension of ["width", "height"] as const) {
        const values = frames.map((frame) => frame[dimension]);
        const low = Math.min(...values);
        const high = Math.max(...values);
        expect(high - low).toBeGreaterThan(20);
        expect(
          values.some((value) => value > low + 2 && value < high - 2),
        ).toBe(true);
      }
      await test.info().attach(expanded ? "opening-frames" : "closing-frames", {
        body: JSON.stringify(frames),
        contentType: "application/json",
      });
    }
    await cards.getByRole("button", { name: "Hide prompt cards" }).click();
    await shelf.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause();
        animation.currentTime = 90;
      }
    });
    await page.screenshot({
      path: test.info().outputPath(`prompt-cards-${display}-closing.png`),
      animations: "allow",
    });
    await shelf.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true }))
        animation.finish();
    });
    await expect(panel.locator("[data-folded-prompt-toggle]")).toBeVisible();
    await expect.poll(async () => (await cards.boundingBox())!.width).toBe(23);
    if (display === "Expanded") {
      const foldedBox = (await cards.boundingBox())!;
      expect(foldedBox.y + foldedBox.height).toBeCloseTo(
        expandedBox.y + expandedBox.height,
        0,
      );
    } else {
      const mode = panel.locator("[data-chat-mode-row]");
      const modeBox = (await mode.boundingBox())!;
      const foldedBox = (await cards.boundingBox())!;
      expect(foldedBox.y + foldedBox.height).toBeCloseTo(
        modeBox.y + modeBox.height,
        0,
      );
    }
    await expect(scroll).toBeHidden();
    await expect(
      cards.getByRole("button", { name: "Show prompt cards" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(allPrompts).toBeHidden();
    await expect.poll(async () => (await cards.boundingBox())!.width).toBe(23);
    expect((await cards.boundingBox())!.height).toBe(30);
    expect(await cards.getByRole("button").count()).toBe(1);
    await page.screenshot({
      path: test.info().outputPath(`prompt-cards-${display}-folded.png`),
      animations: "disabled",
    });
    await cards.getByRole("button", { name: "Show prompt cards" }).click();
    await expect(scroll).toBeVisible();
    await allPrompts.click();
    await expect(
      page.getByRole("menuitem", { name: "Check terminology", exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await scroll.hover();
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(
      panel.getByRole("button", { name: "Prompts", exact: true }),
    ).toHaveCount(0);
    await allPrompts.click();
    await expect(
      page.getByRole("menuitem", { name: "Improve writing", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("My draft stays here");
    await page.evaluate(async () => {
      const path = "/src/renderer/stores/settings-store.ts";
      const store = (await import(path)).useSettingsStore;
      store
        .getState()
        .promptLibrary.slice(2)
        .forEach((prompt: any) => {
          store.getState().saveLibraryPrompt({ ...prompt, enabled: false });
        });
    });
    await expect(scroll.getByRole("button")).toHaveCount(2);
    const sizes = await scroll.evaluate((element) => ({
      available: element.clientWidth,
      widths: Array.from(element.querySelectorAll("button")).map(
        (button) => button.getBoundingClientRect().width,
      ),
      overflow: element.scrollWidth > element.clientWidth,
    }));
    expect(sizes.overflow).toBe(false);
    // Only the first segment includes a one-pixel divider.
    expect(Math.abs(sizes.widths[0] - sizes.widths[1])).toBeLessThanOrEqual(1);
    expect(
      Math.abs(sizes.widths[0] + sizes.widths[1] - sizes.available),
    ).toBeLessThan(1);
    await page.screenshot({
      path: test.info().outputPath(`prompt-shelf-${display}-two.png`),
      animations: "disabled",
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await cards.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      ),
    ).toBe("none");
    expect(
      await scroll.evaluate(
        (element) => getComputedStyle(element).transitionProperty,
      ),
    ).toBe("none");
  });
}

for (const display of ["Expanded", "Workspace"]) {
  test(`folded prompt placement and message clearance in ${display}`, async ({
    page,
  }) => {
    await workspace(page);
    const control = page.locator(`[data-chat-display="${display}"]`);
    await expect(control).toBeEnabled();
    await control.evaluate((element) => (element as HTMLButtonElement).click());
    const panel = page.locator(
      display === "Workspace"
        ? "[data-workspace-chat-pane]"
        : "[data-chat-drawer-panel]",
    );
    await expect(
      panel.locator('[data-prompt-suggestions="cards"]:visible'),
    ).toBeVisible();
    await expect(control).toBeEnabled();
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    for (const count of [1, 40]) {
      await page.evaluate(async (count) => {
        const path = "/src/renderer/stores/agent-chat-store.ts";
        const store = (await import(path)).useAgentChatStore;
        const state = store.getState();
        const source = state.tabs.find(
          (tab: any) => tab.id === state.activeTabId,
        );
        const id = `floating-chat-${count}`;
        const messages = Array.from({ length: count }, (_, index) => ({
          type: "assistant",
          uuid: `${id}-${index}`,
          message: {
            content: [
              {
                type: "text",
                text:
                  index === count - 1
                    ? "Last message: you can read this entire reply above the floating button."
                    : `Reply ${index + 1}. This paragraph provides enough conversation history to scroll through while the prompt button stays anchored above the input.`,
              },
            ],
          },
        }));
        const tab = {
          ...source,
          id,
          runtimeSessionKey: id,
          title: "Floating prompt check",
          messages,
          miniPromptsExpanded: false,
          history: undefined,
          draft: { input: "", pinnedContexts: [] },
        };
        store.setState({ tabs: [tab], activeTabId: id, messages });
      }, count);
      const messages = panel.locator("[data-chat-messages]");
      const floating = panel.locator("[data-folded-prompt-toggle]");
      const button = floating.getByRole("button", {
        name: "Show prompt cards",
      });
      const scroller = messages.locator('[data-testid="virtuoso-scroller"]');
      await expect(button).toBeVisible();
      await expect(
        messages.locator("[data-prompt-scroll-clearance]"),
      ).toHaveCount(1);
      await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const last = messages.locator(`[data-message-index="${count - 1}"]`);
      await expect(last).toBeVisible();
      await expect
        .poll(async () => {
          const lastBox = (await last.boundingBox())!;
          const buttonBox = (await floating.boundingBox())!;
          return buttonBox.y - lastBox.y - lastBox.height;
        })
        .toBeGreaterThanOrEqual(4);
      const floatBox = (await floating.boundingBox())!;
      const messagesBox = (await messages.boundingBox())!;
      const lastBox = (await last.boundingBox())!;
      expect(
        messagesBox.y + messagesBox.height - lastBox.y - lastBox.height,
      ).toBeGreaterThanOrEqual(24);
      expect(floatBox.width).toBe(23);
      expect(floatBox.height).toBe(30);
      expect(floatBox.y).toBeGreaterThan(messagesBox.y);
      const inputBox = (await panel
        .locator("[data-chat-composer-surface]:visible")
        .boundingBox())!;
      if (display === "Expanded") {
        expect(inputBox.y - floatBox.y - floatBox.height).toBeCloseTo(8, 0);
      } else {
        const modeRow = (await panel
          .locator("[data-chat-mode-row]")
          .boundingBox())!;
        const switcher = (await panel
          .locator('[data-chat-display="Workspace"]')
          .locator("..")
          .boundingBox())!;
        expect(switcher.x + switcher.width / 2).toBeCloseTo(
          modeRow.x + modeRow.width / 2,
          0,
        );
        expect(floatBox.x).toBeGreaterThan(switcher.x + switcher.width);
        expect(floatBox.y + floatBox.height).toBeCloseTo(
          modeRow.y + modeRow.height,
          0,
        );
        expect(floatBox.x + floatBox.width).toBeCloseTo(
          inputBox.x + inputBox.width,
          0,
        );
      }
      if (count > 1) {
        await scroller.hover();
        await page.mouse.wheel(0, -400);
        await expect
          .poll(() =>
            scroller.evaluate(
              (el) => el.scrollTop + el.clientHeight < el.scrollHeight - 50,
            ),
          )
          .toBe(true);
        expect((await floating.boundingBox())!.y).toBeCloseTo(floatBox.y, 0);
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
      }
      await page.screenshot({
        path: test.info().outputPath(`floating-${display}-${count}.png`),
        animations: "disabled",
      });
      await button.click();
      await expect(floating).toHaveCount(0);
      await expect(
        messages.locator("[data-prompt-scroll-clearance]"),
      ).toHaveCount(0);
      const shelf = panel.locator(
        '[data-chat-composer-shell] [data-prompt-suggestions="cards"]',
      );
      await expect(shelf).toBeVisible();
      await expect
        .poll(() =>
          shelf.evaluate(
            (element) =>
              element
                .closest("[data-prompt-shelf]")!
                .getAnimations({ subtree: true }).length,
          ),
        )
        .toBe(0);
      if (display === "Expanded") {
        const shelfBox = (await shelf.boundingBox())!;
        expect(shelfBox.y + shelfBox.height).toBeCloseTo(
          floatBox.y + floatBox.height,
          0,
        );
      }
      await shelf
        .getByRole("button", { name: "All prompts", exact: true })
        .click();
      await page
        .getByRole("menuitemcheckbox", { name: "Pin prompt bar" })
        .click();
      await shelf.getByRole("button", { name: "Unpin and collapse" }).click();
      await expect(button).toBeVisible();
    }
  });
}

test("release prompt settings expose four built-ins with persistent toggles and ordering", async ({
  page,
  context,
}) => {
  await page.goto("/?debug=markdown-settings&section=agent");
  await page.evaluate(async () => {
    const { useSettingsStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/settings-store.ts"
    );
    const { DEFAULT_PROMPT_LIBRARY: defaults } = await import(
      /* @vite-ignore */ "/src/renderer/lib/prompt-library.ts"
    );
    useSettingsStore.setState({
      promptLibrary: [
        {
          ...defaults[0],
          title: "Edited writing",
          prompt: "Keep my customized text",
          icon: "telescope",
        },
        { ...defaults[0], id: "custom", title: "Hidden custom" },
        { ...defaults[1], enabled: false },
        defaults[3],
      ],
    });
  });
  const library = page.locator('[data-settings-row-id="agent-prompt-library"]');
  await library.scrollIntoViewIfNeeded();
  const rows = library.locator("[data-library-prompt-id]");
  const ids = () =>
    rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-library-prompt-id")),
    );
  await expect(rows).toHaveCount(4);
  await expect(
    library.getByRole("button", { name: /^(Add prompt|Edit |Delete)/ }),
  ).toHaveCount(0);
  await expect(library.getByText("Hidden custom", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    library.getByText("Edited writing", { exact: true }),
  ).toHaveCount(0);
  await library.getByText("Improve writing", { exact: true }).click();
  await expect(
    page.getByRole("form", { name: "Edit library prompt" }),
  ).toHaveCount(0);
  await expect(
    library.getByRole("switch", { name: "Enable Fix issues" }),
  ).toHaveAttribute("aria-checked", "false");
  await library.getByRole("switch", { name: "Enable Improve writing" }).click();
  await library.getByRole("button", { name: "Move Fix issues up" }).click();
  await library
    .getByRole("button", { name: "Move Review & comment up" })
    .click();
  await expect
    .poll(ids)
    .toEqual([
      "fix-issues",
      "improve-writing",
      "review-and-comment",
      "tighten-layout",
    ]);
  await expect(
    library.getByRole("button", { name: "Move Fix issues up" }),
  ).toBeDisabled();
  await expect(
    library.getByRole("button", { name: "Move Tighten layout down" }),
  ).toBeDisabled();
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("catalex-settings")!).state.promptLibrary,
  );
  expect(
    saved.find((prompt: any) => prompt.id === "improve-writing"),
  ).toMatchObject({
    title: "Edited writing",
    prompt: "Keep my customized text",
    icon: "telescope",
    enabled: false,
  });
  expect(saved.some((prompt: any) => prompt.id === "custom")).toBe(true);
  const other = await context.newPage();
  await other.goto("/?debug=markdown-settings&section=agent");
  const otherLibrary = other.locator(
    '[data-settings-row-id="agent-prompt-library"]',
  );
  await otherLibrary.scrollIntoViewIfNeeded();
  await expect(
    otherLibrary.getByRole("switch", { name: "Enable Improve writing" }),
  ).toHaveAttribute("aria-checked", "false");
  await library.getByRole("switch", { name: "Enable Improve writing" }).click();
  await expect(
    otherLibrary.getByRole("switch", { name: "Enable Improve writing" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.reload();
  await library.scrollIntoViewIfNeeded();
  await expect
    .poll(ids)
    .toEqual([
      "fix-issues",
      "improve-writing",
      "review-and-comment",
      "tighten-layout",
    ]);
  await expect(
    library.getByRole("switch", { name: "Enable Fix issues" }),
  ).toHaveAttribute("aria-checked", "false");
  await library.screenshot({
    path: test.info().outputPath("built-in-prompts-light.png"),
  });
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await library.scrollIntoViewIfNeeded();
  await expect(
    library.getByRole("switch", { name: "Enable Improve writing" }),
  ).toHaveAttribute("aria-checked", "true");
  await library.screenshot({
    path: test.info().outputPath("built-in-prompts-dark.png"),
  });
  await other.close();
});

test("prompt settings add, edit, reorder, disable, delete, and synchronize across windows", async ({
  page,
  context,
}) => {
  await page.goto("/?debug=markdown-settings&section=agent");
  test.skip(
    !(await page.evaluate(async () => {
      const library = await import(
        /* @vite-ignore */ "/src/renderer/lib/prompt-library.ts"
      );
      return library.PROMPT_CUSTOMIZATION_ENABLED;
    })),
    "Customization is retained for the deferred restoration issue.",
  );

  const library = page.locator('[data-settings-row-id="agent-prompt-library"]');
  await library.scrollIntoViewIfNeeded();
  await library.getByRole("button", { name: "Add prompt" }).click();
  await page
    .getByLabel("Prompt title", { exact: true })
    .fill("Check terminology");
  const defaultIcon = page.getByRole("button", {
    name: "Prompt icon: Default icon",
  });
  await expect(defaultIcon.locator("svg.lucide-bookmark")).toBeVisible();
  await defaultIcon.click();
  await expect(
    page.getByRole("button", { name: "Default icon", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: test.info().outputPath("prompt-icon-picker.png"),
    animations: "disabled",
  });
  const catalog = page.getByRole("group", { name: "Icon catalog" });
  const suggested = catalog.getByRole("button", { name: "Suggested" });
  const allIcons = catalog.getByRole("button", { name: "All icons" });
  await expect(suggested).toHaveAttribute("aria-pressed", "true");
  await allIcons.click();
  await expect(allIcons).toHaveAttribute("aria-pressed", "true");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator('[data-slot="popover-content"] button[aria-pressed] svg'),
  ).toHaveCount(38);
  await page.screenshot({
    path: test.info().outputPath("prompt-icon-catalog.png"),
    animations: "disabled",
  });
  await suggested.click();
  await expect(suggested).toHaveAttribute("aria-pressed", "true");
  await expect(next).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search icons" }).fill("telescope");
  await expect(allIcons).toHaveAttribute("aria-pressed", "true");
  const telescope = page.getByRole("button", {
    name: "Telescope",
    exact: true,
  });
  await expect(telescope.locator("svg.lucide-telescope")).toBeVisible();
  await telescope.click();
  await page
    .getByLabel("Prompt text", { exact: true })
    .fill("Check terminology for consistency.");
  await page.getByRole("combobox", { name: "Prompt availability" }).click();
  await expect(page.getByRole("option")).toHaveText([
    "Always",
    "Has text selection",
    "Has issues",
  ]);
  await page
    .getByRole("option", { name: "Has text selection", exact: true })
    .click();
  await page.getByRole("button", { name: "Save prompt" }).click();
  const other = await context.newPage();
  await workspace(other);
  await other
    .locator('[data-prompt-suggestions="compact"]')
    .getByRole("button", { name: "All prompts", exact: true })
    .click();
  await expect(
    other.getByRole("menuitem", { name: "Check terminology", exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole("menuitem", { name: "Check terminology", exact: true }),
  ).toBeDisabled();
  await other.keyboard.press("Escape");
  await library
    .getByRole("button", { name: "Move Check terminology up" })
    .click();
  await library
    .getByRole("button", { name: "Move Check terminology up" })
    .click();
  await library
    .getByRole("button", { name: "Move Check terminology up" })
    .click();
  await expect(
    library.locator("[data-library-prompt-id]").nth(1),
  ).toContainText("Check terminology");
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terminology", exact: true })
      .locator("svg.lucide-telescope"),
  ).toHaveCount(1);
  await page.reload();
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terminology", exact: true }),
  ).toBeVisible();
  await library.getByRole("button", { name: "Edit Check terminology" }).click();
  await expect(
    page.getByRole("combobox", { name: "Prompt availability" }),
  ).toHaveText("Has text selection");
  await page.getByRole("combobox", { name: "Prompt availability" }).click();
  await page.getByRole("option", { name: "Always", exact: true }).click();
  await page.getByRole("button", { name: "Prompt icon: Telescope" }).click();
  await page.getByRole("button", { name: "Default icon", exact: true }).click();
  await page.getByRole("button", { name: "Save prompt" }).click();
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terminology", exact: true })
      .locator("svg.lucide-bookmark"),
  ).toHaveCount(1);
  await library.getByRole("button", { name: "Edit Check terminology" }).click();
  await defaultIcon.click();
  await page.getByRole("button", { name: "No icon", exact: true }).click();
  await page.getByLabel("Prompt title", { exact: true }).fill("Check terms");
  await page
    .getByLabel("Prompt text", { exact: true })
    .fill("Check terms carefully.");
  await page.getByRole("button", { name: "Save prompt" }).click();
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terms", exact: true }),
  ).toBeVisible();
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terms", exact: true })
      .locator("svg"),
  ).toHaveCount(0);
  await library.getByRole("switch", { name: "Enable Check terms" }).click();
  await expect(
    other
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Check terms", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    library.getByRole("switch", { name: "Enable Check terms" }),
  ).toHaveAttribute("aria-checked", "false");
  await library.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("prompt-library-settings.png"),
  });
  await library.getByRole("button", { name: "Delete Check terms" }).click();
  await library.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(
    library.getByRole("button", { name: "Edit Check terms" }),
  ).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await library.scrollIntoViewIfNeeded();
  await library
    .getByRole("button", { name: "Edit Improve writing", exact: true })
    .click();
  await page
    .getByLabel("Prompt text", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: test.info().outputPath("prompt-library-edit-dark.png"),
  });
});

async function promptFileFixtures(page: Page) {
  await page.evaluate(async () => {
    const { useDocumentStore: doc } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    const { useSettingsStore: settings } = await import(
      /* @vite-ignore */ "/src/renderer/stores/settings-store.ts"
    );
    settings.getState().setProjectAutoCompile("/tmp/harness", false);
    const bytes = new Uint8Array(
      await (await fetch("/examples/paper-standard/main.pdf")).arrayBuffer(),
    );
    const host = (window as any).__TAURI_INTERNALS__;
    const invoke = host.invoke.bind(host);
    host.invoke = (command: string, args: any, ...rest: any[]) =>
      command === "plugin:fs|read_file" && args.path.endsWith("/template.pdf")
        ? Promise.resolve(bytes)
        : invoke(command, args, ...rest);
    const base = doc.getState().files[0];
    doc.setState({
      files: [
        ...doc.getState().files,
        {
          ...base,
          id: "figure.svg",
          name: "figure.svg",
          relativePath: "figure.svg",
          absolutePath: "/tmp/harness/figure.svg",
          type: "image",
          content:
            'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="lightblue"/></svg>',
        },
        {
          ...base,
          id: "archive.bin",
          name: "archive.bin",
          relativePath: "archive.bin",
          absolutePath: "/tmp/harness/archive.bin",
          type: "other",
          content: undefined,
          isBinary: true,
        },
      ],
    });
  });
}

async function selectPromptFile(page: Page, id: string) {
  await page.evaluate(async (id) => {
    const { useDocumentStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile(id);
  }, id);
}

for (const display of ["Collapsed", "Expanded", "Workspace"]) {
  test(`file changes reset temporary prompt choices in ${display} while pinning wins`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await workspace(page);
    await promptFileFixtures(page);
    await page
      .locator("[data-chat-drawer-panel] [data-chat-composer-input]:visible")
      .fill("Keep the draft when changing files");
    await expect
      .poll(async () => (await activeTab(page)).draft.input)
      .toBe("Keep the draft when changing files");
    const control = page.locator(`[data-chat-display="${display}"]`);
    await control.evaluate((element) => (element as HTMLButtonElement).click());
    await expect(
      page.locator("[data-workspace-layout-animating]"),
    ).toHaveAttribute("data-workspace-layout-animating", "false");
    const panel = page.locator(
      display === "Workspace"
        ? "[data-workspace-chat-pane]"
        : "[data-chat-drawer-panel]",
    );
    const cards = panel.locator(
      `[data-prompt-suggestions="${display === "Collapsed" ? "compact" : "cards"}"]:visible`,
    );
    const show = display === "Collapsed" ? "Show prompts" : "Show prompt cards";
    const hide = display === "Collapsed" ? "Hide prompts" : "Hide prompt cards";
    const input = panel.locator("[data-chat-composer-input]:visible");
    await expect(panel.locator("[data-chat-composer-shell]")).toHaveAttribute(
      "data-composer-transfer-phase",
      "idle",
    );
    await expect(input).toHaveValue("Keep the draft when changing files");
    await expect(
      cards.getByRole("button", { name: hide, exact: true }),
    ).toBeVisible();
    for (const id of ["template.pdf", "figure.svg", "archive.bin"]) {
      await selectPromptFile(page, id);
      await expect(
        cards.getByRole("button", { name: show, exact: true }),
      ).toBeVisible();
      expect((await activeTab(page)).miniPromptsExpanded).toBeUndefined();
      await selectPromptFile(page, "main.tex");
      await expect(
        cards.getByRole("button", { name: hide, exact: true }),
      ).toBeVisible();
    }
    await selectPromptFile(page, "template.pdf");
    await expect(page.locator(".mupdf-text-layer").first()).toBeVisible();
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`pdf-prompts-${display}-collapsed.png`),
      animations: "disabled",
    });
    await cards.getByRole("button", { name: show, exact: true }).click();
    await expect(
      cards.getByRole("button", { name: /^Improve writing/ }),
    ).toBeEnabled();
    await selectPromptFile(page, "figure.svg");
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    // Returning to the previous file must not restore its temporary override.
    await selectPromptFile(page, "template.pdf");
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    await selectPromptFile(page, "main.tex");
    await cards.getByRole("button", { name: hide, exact: true }).click();
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    await selectPromptFile(page, "figure.svg");
    await selectPromptFile(page, "main.tex");
    await expect(
      cards.getByRole("button", { name: hide, exact: true }),
    ).toBeVisible();
    await cards
      .getByRole("button", { name: "All prompts", exact: true })
      .click();
    await page
      .getByRole("menuitemcheckbox", { name: "Pin prompt bar" })
      .click();
    await selectPromptFile(page, "template.pdf");
    await expect(
      cards.getByRole("button", { name: "Unpin and collapse" }),
    ).toBeVisible();
    await cards.getByRole("button", { name: "Unpin and collapse" }).click();
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    await selectPromptFile(page, "main.tex");
    await expect(
      cards.getByRole("button", { name: hide, exact: true }),
    ).toBeVisible();
    await expect(input).toHaveValue("Keep the draft when changing files");
    // A new chat gets the file-aware default, independent of the prior override.
    await selectPromptFile(page, "template.pdf");
    await page.evaluate(() => window.__newInputTransferChat?.());
    await expect(
      cards.getByRole("button", { name: show, exact: true }),
    ).toBeVisible();
    await selectPromptFile(page, "main.tex");
    await expect(
      cards.getByRole("button", { name: hide, exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`source-prompts-${display}-expanded.png`),
      animations: "disabled",
    });
  });
}

test("chat pop-outs share the file-aware prompt default and pin override", async ({
  page,
}) => {
  await workspace(page);
  await promptFileFixtures(page);
  const opened = page.waitForEvent("popup");
  await page.evaluate(async () => {
    const { useAgentChatStore } = await import(
      /* @vite-ignore */ "/src/renderer/stores/agent-chat-store.ts"
    );
    const { openPanelWindow } = await import(
      /* @vite-ignore */ "/src/renderer/lib/panel-windows.ts"
    );
    useAgentChatStore.setState({ chatProjectRoot: "/tmp/harness" });
    openPanelWindow("chat", "duet");
  });
  const child = await opened;
  await expect(child.locator("[data-panel-window-title]")).toBeVisible();
  const cards = child.locator('[data-prompt-suggestions="cards"]:visible');
  await expect(
    cards.getByRole("button", { name: "Hide prompt cards", exact: true }),
  ).toBeVisible();
  await selectPromptFile(page, "template.pdf");
  await expect(
    cards.getByRole("button", { name: "Show prompt cards", exact: true }),
  ).toBeVisible();
  await cards
    .getByRole("button", { name: "Show prompt cards", exact: true })
    .click();
  await expect(
    cards.getByRole("button", { name: "Hide prompt cards", exact: true }),
  ).toBeVisible();
  await selectPromptFile(page, "figure.svg");
  await expect(
    cards.getByRole("button", { name: "Show prompt cards", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Show prompts", exact: true }),
  ).toBeVisible();
  await selectPromptFile(page, "main.tex");
  await expect(
    cards.getByRole("button", { name: "Hide prompt cards", exact: true }),
  ).toBeVisible();
  await cards.getByRole("button", { name: "All prompts", exact: true }).click();
  await child.getByRole("menuitemcheckbox", { name: "Pin prompt bar" }).click();
  await selectPromptFile(page, "template.pdf");
  await expect(
    cards.getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-prompt-suggestions="compact"]')
      .getByRole("button", { name: "Unpin and collapse" }),
  ).toBeVisible();
  await child.close();
});
