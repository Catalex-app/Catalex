import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Exercises the real WASM in Chromium, but does not yet claim the application
// handlers have migrated. Build packages/document-core's WASM target first.
test.skip(
  process.env.CATALEX_DOCUMENT_CORE_PROTOTYPE !== "1",
  "Explicit prototype check; not yet part of the application build",
);
test("shared document prototype runs in the browser without per-edit IPC", async ({
  page,
}, info) => {
  const coreRoot = new URL("../../../packages/document-core/", import.meta.url);
  const wasm = readFileSync(
    new URL(
      "target/wasm32-unknown-unknown/release/catalex_document_core.wasm",
      coreRoot,
    ),
  );
  await page.goto("/?debug=comment-workspace&saving=edit");
  await expect(page.locator(".cm-editor").first()).toBeVisible();
  const report = await page.evaluate(
    async ({ moduleUrl, bytes }) => {
      const { createDocumentCore } = await import(/* @vite-ignore */ moduleUrl);
      const core = createDocumentCore(
        Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0)),
      );
      const results = [];
      for (const size of [220_000, 2_200_000]) {
        const document = {
          revision: 0,
          text: "a".repeat(size),
          anchors: Array.from({ length: 1000 }, (_, i) => ({
            id: `c-${i}`,
            from: i * 100,
            to: i * 100 + 10,
            resolved: i % 2 === 0,
            positionReset: false,
          })),
        };
        let view = core.session({ type: "open", document }).Ok;
        if (!view) throw new Error("Could not open document");
        const handle = view.handle;
        const times = [];
        try {
          for (let i = 0; i < 120; i++) {
            const start = performance.now();
            const result = core.session({
              type: "update",
              handle,
              update: {
                expectedRevision: view.revision,
                operations: [
                  { type: "text", edits: [{ from: 0, to: 0, insert: "x" }] },
                ],
              },
            });
            if (!result.Ok) throw new Error(result.Err);
            view = result.Ok;
            if (i >= 20) times.push(performance.now() - start);
          }
          const snapshot = core.session({ type: "read", handle }).Ok;
          if (
            snapshot.text !== `${"x".repeat(120)}${document.text}` ||
            snapshot.anchors.some(
              (
                anchor: { from: number; to: number; resolved: boolean },
                i: number,
              ) =>
                anchor.from !== i * 100 + 120 ||
                anchor.to !== i * 100 + 130 ||
                anchor.resolved !== (i % 2 === 0),
            )
          ) {
            throw new Error("Text and anchors diverged");
          }
          const stale = core.session({
            type: "update",
            handle,
            update: { expectedRevision: 0, operations: [] },
          });
          if (!stale.Err?.includes("Stale"))
            throw new Error("Stale revision was accepted");
          times.sort((a, b) => a - b);
          results.push({
            size,
            anchors: 1000,
            medianMs: times[50],
            p95Ms: times[95],
          });
        } finally {
          core.session({ type: "close", handle });
        }
      }
      return results;
    },
    {
      moduleUrl: `/@fs/${fileURLToPath(new URL("wasm-adapter.mjs", coreRoot))}`,
      bytes: wasm.toString("base64"),
    },
  );
  await info.attach("core-performance.json", {
    body: JSON.stringify(
      {
        scope:
          "Isolated browser WASM calls; excludes app typing, persistence and rendering",
        results: report,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  console.log(JSON.stringify(report));
});
