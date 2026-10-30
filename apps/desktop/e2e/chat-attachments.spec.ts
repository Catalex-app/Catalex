import { test, expect } from "@playwright/test";
test("files and pathless screenshots attach while viewing a draft", async ({
  page,
}) => {
  await page.goto("/?debug=agent-pause&provider=claude");
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    const resource = performance
      .getEntriesByType("resource")
      .find(
        (entry) =>
          new URL(entry.name).pathname ===
          "/src/renderer/stores/agent-chat-store.ts",
      );
    const { useAgentChatStore } = await import(resource!.name);
    const state = useAgentChatStore.getState();
    useAgentChatStore.setState({
      isStreaming: false,
      tabs: state.tabs.map((tab: any) => ({
        ...tab,
        isStreaming: false,
        pauseState: "paused",
        turnPhase: null,
      })),
      sendPrompt: async (prompt: string, context: unknown) => {
        (window as any).__sent = { prompt, context };
      },
    });
  });
  await expect(
    page.getByRole("button", { name: "Continue", exact: true }),
  ).toBeEnabled();
  await page.evaluate(async () => {
    const internal = (window as any).__TAURI_INTERNALS__;
    internal.convertFileSrc = () =>
      "data:image/svg+xml," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#4688bc"/><circle cx="40" cy="30" r="15" fill="white"/></svg>',
      );
    const original = internal.invoke;
    const saved: Record<string, unknown> = {};
    (window as any).__savedAttachments = saved;
    internal.invoke = async (cmd: string, args: any, options: any) => {
      if (cmd === "desktop:chat:attachment") {
        if (args.sourcePath) return args.sourcePath;
        const path = `/managed/project/sessions/media/${args.name}`;
        saved[path] = args.bytes;
        return path;
      }
      return original(cmd, args, options);
    };
    const target = document.querySelector("textarea")!;
    document.body.setAttribute("data-chat-drawer-panel", "");
    const rect = target.getBoundingClientRect();
    await internal.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: {
        paths: ["/external/notes.txt"],
        position: { x: rect.x + 10, y: rect.y + 10 },
      },
    });
  });
  await expect(page.getByText("@notes.txt", { exact: true })).toBeVisible();
  await page.getByText("@notes.txt", { exact: true }).hover();
  await expect(page.getByRole("tooltip")).toContainText("/external/notes.txt");
  await page.mouse.move(10, 10);

  await page.evaluate(async () => {
    const target = document.querySelector("textarea")!;
    const rect = target.getBoundingClientRect();
    await (window as any).__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "tauri://drag-drop",
      payload: {
        paths: [],
        files: [new File(["image"], "shot.png", { type: "image/png" })],
        position: { x: rect.x + 10, y: rect.y + 10 },
      },
    });
  });
  await expect(page.getByText("@shot.png", { exact: true })).toBeVisible();
  await expect(page.locator("[data-context-kind]").first()).toHaveAttribute(
    "data-context-kind",
    "attachment",
  );
  const preview = page.getByTestId("chat-image-preview-trigger");
  await expect(preview.locator("img")).toHaveJSProperty("naturalWidth", 80);
  await preview.click();
  await expect(
    page.getByTestId("chat-image-preview-dialog-image"),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/attachment-preview.png" });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-image-preview-dialog-image")).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() => Object.keys((window as any).__savedAttachments)),
  ).toEqual(["/managed/project/sessions/media/shot.png"]);
  await expect(
    page.getByRole("button", { name: "Send", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sent = await page.evaluate(() => (window as any).__sent);
  expect(sent.prompt).toBe("");
  expect(sent.context.map((item: any) => item.filePath)).toEqual([
    "/external/notes.txt",
    "/managed/project/sessions/media/shot.png",
  ]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/chat-attachments.png" });
});
