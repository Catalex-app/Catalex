import { expect, test } from "@playwright/test";

test("production MathJax chunk renders without external resources", async ({
  page,
}) => {
  const { readdir } = await import("node:fs/promises");
  const assets = await readdir(
    new URL("../dist/renderer/assets/", import.meta.url),
  );
  const chunk = assets.find((name) => /^markdown-mathjax-.*\.js$/.test(name));
  expect(chunk).toBeDefined();
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith("http") && url.hostname !== "127.0.0.1") {
      externalRequests.push(url.href);
      await route.abort();
    } else {
      await route.continue();
    }
  });
  // Release builds keep diagnostics but deliberately exclude development harnesses.
  await page.goto("/?debug");
  await expect(
    page.getByRole("heading", { name: "Debug", exact: true }),
  ).toBeVisible();
  // Ignore the app shell's already-blocked font request; check MathJax's requests.
  externalRequests.length = 0;
  const result = await page.evaluate(async (chunk) => {
    const { default: mathjax } = await import(`/assets/${chunk}`);
    const tree = {
      type: "root",
      children: ["x^2", String.raw`\frac{a}{b}`].map((value) => ({
        type: "element",
        tagName: "code",
        properties: { className: ["math-inline"] },
        children: [{ type: "text", value }],
      })),
    };
    const errors: string[] = [];
    mathjax()(tree, { message: (message: string) => errors.push(message) });
    const output = JSON.stringify(tree);
    return {
      errors,
      equations: (output.match(/"tagName":"mjx-container"/g) ?? []).length,
      paths: (output.match(/"tagName":"path"/g) ?? []).length,
    };
  }, chunk);
  expect(result.errors).toEqual([]);
  expect(result.equations).toBe(2);
  expect(result.paths).toBeGreaterThan(0);
  expect(externalRequests).toEqual([]);
});

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
