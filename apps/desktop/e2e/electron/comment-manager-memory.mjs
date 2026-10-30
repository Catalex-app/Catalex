// Repeated real manager lifecycles. GC samples distinguish live retention from
// temporary allocations; process RSS is reported separately, not called a leak.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";

const exec = promisify(execFile);
export async function checkManagerMemory(app, page, projectRoot, count) {
  const cycles = Number(process.env.CATALEX_MEMORY_CYCLES ?? 35);
  assert.ok(
    Number.isInteger(cycles) &&
      cycles >= 10 &&
      cycles <= 200 &&
      cycles % 5 === 0,
  );
  // Finish the preceding typing workload before attributing reads to opening.
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await useDocumentStore.getState().saveAllFiles({ requireClean: true });
  });
  await page.waitForTimeout(1000);
  const cdp = await page.context().newCDPSession(page);
  const pid = app.process().pid;
  await cdp.send("HeapProfiler.enable");
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("desktop:invoke");
    globalThis.managerReadProbe = { original, calls: {}, pending: 0 };
    ipcMain.removeHandler("desktop:invoke");
    ipcMain.handle("desktop:invoke", async (event, command, args) => {
      const probe = globalThis.managerReadProbe;
      const tracked =
        command === "read_project_comments_anchored" ||
        command === "read_disconnected_comments" ||
        command === "read_project_comment_counters";
      if (tracked) {
        probe.calls[command] = (probe.calls[command] ?? 0) + 1;
        if (
          command === "read_project_comments_anchored" &&
          args.includeDisconnected
        )
          probe.calls.managerSnapshots =
            (probe.calls.managerSnapshots ?? 0) + 1;
        probe.pending++;
      }
      try {
        return await original(event, command, args);
      } finally {
        if (tracked) probe.pending--;
      }
    });
  });
  const settle = async () => {
    await expect
      .poll(() => app.evaluate(() => globalThis.managerReadProbe.pending))
      .toBe(0);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  };
  const sample = async (phase) => {
    await settle();
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const dom = await cdp.send("Memory.getDOMCounters");
    const processes = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((entry) => ({
        type: entry.type,
        pid: entry.pid,
        rssKiB: entry.memory.workingSetSize,
      })),
    );
    const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss=,comm="]);
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
        return (
          match && {
            pid: +match[1],
            parent: +match[2],
            rssKiB: +match[3],
            command: match[4],
          }
        );
      })
      .filter(Boolean);
    const descendants = new Set([pid]);
    for (let pass = 0; pass < rows.length; pass++) {
      let added = false;
      for (const row of rows)
        if (descendants.has(row.parent) && !descendants.has(row.pid)) {
          descendants.add(row.pid);
          added = true;
        }
      if (!added) break;
    }
    const native = rows.filter(
      (row) => descendants.has(row.pid) && /catalex-desktop/.test(row.command),
    );
    const value = { phase, heap, dom, processes, native };
    console.log(JSON.stringify({ managerMemorySample: value }));
    return value;
  };
  const samples = [];
  const timings = [];
  const heapSnapshot = async (name) => {
    if (process.env.CATALEX_MEMORY_SNAPSHOTS !== "1") return;
    const chunks = [];
    const collect = ({ chunk }) => chunks.push(chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", collect);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot");
      await fs.writeFile(
        path.join(os.tmpdir(), `catalex-manager-${name}.heapsnapshot`),
        chunks.join(""),
      );
    } finally {
      cdp.off("HeapProfiler.addHeapSnapshotChunk", collect);
    }
  };
  try {
    samples.push(await sample("before"));
    for (let cycle = 1; cycle <= cycles; cycle++) {
      await app.evaluate(() => {
        globalThis.managerReadProbe.calls = {};
      });
      const started = performance.now();
      await page.evaluate(async (root) => {
        const { OPEN_COMMENT_MANAGER_EVENT } = await import(
          "/src/renderer/lib/workspace-events.ts"
        );
        window.dispatchEvent(
          new CustomEvent(OPEN_COMMENT_MANAGER_EVENT, {
            detail: { projectRoot: root },
          }),
        );
      }, projectRoot);
      const dialog = page.getByRole("dialog", { name: "Manage comments" });
      await expect(
        dialog.getByRole("checkbox", {
          name: "Select file main.tex",
          exact: true,
        }),
      ).toBeEnabled();
      const openMs = performance.now() - started;
      await dialog
        .getByRole("button", {
          name: "Expand comments in main.tex",
          exact: true,
        })
        .click();
      await expect(
        dialog.getByText(`Feedback ${count - 2}`, { exact: true }),
      ).toBeVisible();
      await settle();
      const calls = await app.evaluate(() => globalThis.managerReadProbe.calls);
      console.log(JSON.stringify({ managerCycle: cycle, calls, openMs }));
      assert.equal(
        calls.read_project_comments_anchored,
        1,
        "one reconciled manager snapshot per opening",
      );
      assert.equal(
        calls.read_disconnected_comments ?? 0,
        0,
        "no independent disconnected read",
      );
      assert.equal(
        calls.read_project_comment_counters ?? 0,
        0,
        "counters are part of the snapshot",
      );
      if (cycle === 1) {
        samples.push(await sample("expanded"));
        await page.screenshot({
          path: path.join(os.tmpdir(), "catalex-manager-memory.png"),
        });
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      timings.push(openMs);
      if (cycle % 5 === 0) samples.push(await sample(`closed-${cycle}`));
      if (cycle === 5) await heapSnapshot("warm");
    }
    const warm = samples.find((entry) => entry.phase === "closed-5");
    const final = samples.at(-1);
    const heapGrowthMiB =
      (final.heap.usedSize - warm.heap.usedSize) / 1024 ** 2;
    const nodeGrowth = final.dom.nodes - warm.dom.nodes;
    const listenerGrowth =
      final.dom.jsEventListeners - warm.dom.jsEventListeners;
    console.log(
      JSON.stringify({
        managerMemorySummary: {
          cycles,
          warmupCycles: 5,
          heapGrowthMiB,
          nodeGrowth,
          listenerGrowth,
          firstOpenMs: timings[0],
          medianOpenMs: [...timings.slice(5)].sort((a, b) => a - b)[
            Math.floor((cycles - 5) / 2)
          ],
          scope:
            "Development Electron; forced-GC live heap and DOM, process RSS includes allocator caches. Bounded retention check, not proof against every leak.",
        },
      }),
    );
    await heapSnapshot("final");
    await page.waitForTimeout(2000);
    await sample("idle");
    // React's development timing entries are retained by the browser even when
    // component trees are gone. Report them before clearing this diagnostic
    // buffer; do not change production code or hide them from the samples above.
    const timingsBuffer = await page.evaluate(() => {
      const measures = performance.getEntriesByType("measure");
      const names = {};
      for (const entry of measures)
        names[entry.name] = (names[entry.name] ?? 0) + 1;
      const result = {
        count: measures.length,
        mostCommon: Object.entries(names)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8),
      };
      performance.clearMeasures();
      performance.clearMarks();
      return result;
    });
    console.log(JSON.stringify({ developmentTimingsBuffer: timingsBuffer }));
    await sample("timings-cleared");
    const closed = await page.evaluate(async () => {
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      return useDocumentStore.getState().closeProject();
    });
    assert.equal(closed, true);
    await page.waitForTimeout(1000);
    await sample("project-closed");
    assert.ok(
      heapGrowthMiB < 8,
      "investigate >8 MiB retained heap after warmup",
    );
    assert.ok(nodeGrowth < 150, "investigate retained manager DOM nodes");
    assert.ok(listenerGrowth < 20, "investigate accumulating event listeners");
  } finally {
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("desktop:invoke");
      ipcMain.handle("desktop:invoke", globalThis.managerReadProbe.original);
      delete globalThis.managerReadProbe;
    });
    await cdp.detach();
  }
}
