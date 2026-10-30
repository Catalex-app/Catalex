import { expect, test } from "@playwright/test";

// Run after `pnpm build` using playwright.production.config.ts. Dev-mode
// module loading does not exercise production chunk initialization order.
for (const [name, url, ready] of [
  ["workspace", "/?debug=input-transfer", ".cm-editor"],
  [
    "settings",
    "/?debug=claude-models&section=agent&provider=codex",
    "#custom-model-configuration",
  ],
]) {
  test(`production ${name} starts without module initialization errors`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await expect(page.locator(ready).first()).toBeVisible();
    await expect(
      page.getByText("App failed to start", { exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await page.screenshot({ path: `/tmp/catalex-production-${name}.png` });
  });
}

test("production PDF worker initializes WebAssembly", async ({ page }) => {
  await page.goto("/?debug=input-transfer");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  const methods = await page.evaluate(async () => {
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      if (!entry.name.endsWith(".js")) continue;
      const source = await (await fetch(entry.name)).text();
      const workerPath = source.match(/\/assets\/mupdf-worker-[\w-]+\.js/);
      if (!workerPath) continue;
      return new Promise<string[]>((resolve, reject) => {
        const worker = new Worker(workerPath[0], { type: "module" });
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error("PDF worker initialization timed out"));
        }, 10000);
        worker.onerror = (event) => {
          clearTimeout(timeout);
          worker.terminate();
          reject(new Error(event.message));
        };
        worker.onmessage = (event) => {
          clearTimeout(timeout);
          worker.terminate();
          resolve(event.data[0] === "INIT" ? event.data[2] : []);
        };
      });
    }
    throw new Error("Production PDF worker asset was not found");
  });
  expect(methods).toContain("openDocument");
});
