import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// This suite checks native process groups on Unix. A cross-compiled Windows
// binary is not evidence for Windows process-tree cleanup.
assert.notEqual(
  process.platform,
  "win32",
  "Run the Unix cancellation smoke on macOS/Linux",
);
const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-compile-cancel-"),
);
const project = path.join(profile, "project");
const tectonicProject = path.join(profile, "tectonic-project");
const bin = path.join(profile, "bin");
const signals = path.join(profile, "signals");
for (const directory of [project, tectonicProject, bin, signals])
  await fs.mkdir(directory);
const pdf = path.join(root, "public/examples/letter-formal/main.pdf");
const worker = path.join(profile, "tree-worker.cjs");
await fs.writeFile(
  worker,
  `
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const [signals, id, role] = process.argv.slice(2);
process.on('SIGTERM', () => {});
fs.writeFileSync(path.join(signals, id + '.' + role + '.pid'), String(process.pid));
if (role === 'child') cp.spawn(process.execPath, [__filename, signals, id, 'grandchild'], {stdio: 'ignore'});
setInterval(() => {
  fs.appendFileSync(path.join(signals, id + '.' + role + '.activity'), '.');
}, 20);
`,
);
await fs.writeFile(
  path.join(bin, "latexmk"),
  `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const file = process.argv.at(-1);
if (!file.endsWith('.tex')) process.exit(0);
const source = fs.readFileSync(file, 'utf8');
const id = source.match(/CASE=(\\w+)/)[1];
const signals = ${JSON.stringify(signals)};
const stem = file.replace(/\\.tex$/, '');
function alive(pid) {
  try { return !cp.execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {encoding:'utf8'}).trim().startsWith('Z'); }
  catch { return false; }
}
const overlap = fs.readdirSync(signals).filter(name => name.endsWith('.pid'))
  .map(name => ({name, pid:Number(fs.readFileSync(path.join(signals, name), 'utf8'))}))
  .filter(item => alive(item.pid));
fs.writeFileSync(path.join(signals, id + '.started'), JSON.stringify({pid:process.pid, cwd:process.cwd(), overlap}));
fs.appendFileSync(path.join(signals, 'builds'), id + '\\n');
if (id.startsWith('tree')) {
  process.on('SIGTERM', () => {});
  fs.writeFileSync(path.join(signals, id + '.parent.pid'), String(process.pid));
  cp.spawn(process.execPath, [${JSON.stringify(worker)}, signals, id, 'child'], {stdio:'ignore'});
  // Cancellation must not publish a partial PDF or the replacement SyncTeX.
  fs.writeFileSync(stem + '.pdf', '%PDF-1.7\\npartial cancelled output');
  fs.writeFileSync(stem + '.synctex', 'Input:1:./cancelled.tex\\nContent:\\n');
  setInterval(() => {}, 100);
} else {
  fs.copyFileSync(${JSON.stringify(pdf)}, stem + '.pdf');
  fs.writeFileSync(stem + '.synctex', 'Input:1:./' + id + '.tex\\nUnit:65536\\nContent:\\n{1\\n(1,3:100,100:200,10,2\\nx1,3:110,=\\n)\\n}1\\nPostamble:\\n');
}
`,
  { mode: 0o755 },
);
await fs.writeFile(path.join(bin, "pdflatex"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});

function source(id) {
  return `% CASE=${id}\n\\documentclass{article}\n\\begin{document}Test\\end{document}\n`;
}
async function setSource(id) {
  await fs.writeFile(path.join(project, "main.tex"), source(id));
}
function alive(pid) {
  try {
    const stat = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return stat.length > 0 && !stat.startsWith("Z");
  } catch {
    return false;
  }
}
async function record(id) {
  return JSON.parse(
    await fs.readFile(path.join(signals, `${id}.started`), "utf8"),
  );
}
async function started(id) {
  await expect
    .poll(() => record(id).catch(() => null), { timeout: 15000 })
    .not.toBeNull();
  return record(id);
}
async function treePids(id) {
  await expect
    .poll(async () => {
      const values = await Promise.all(
        ["parent", "child", "grandchild"].map((role) =>
          fs
            .readFile(path.join(signals, `${id}.${role}.pid`), "utf8")
            .then(Number)
            .catch(() => 0),
        ),
      );
      return values.every(Boolean);
    })
    .toBe(true);
  return Promise.all(
    ["parent", "child", "grandchild"].map(async (role) =>
      Number(
        await fs.readFile(path.join(signals, `${id}.${role}.pid`), "utf8"),
      ),
    ),
  );
}
function tectonicPids() {
  return execFileSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(
      (line) => line.includes("--tectonic-compile") && line.includes(profile),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

// Use the real renderer/preload/main/service boundary with a minimal page so
// React's auto-compile effects cannot race these explicit native requests.
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "compile-cancellation-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/",
              "<html><body><div id='root'>Native compilation cancellation</div></body></html>",
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
let app;
let page;
const pending = new Map();
async function compile(id, { target = project, backend = "latexmk" } = {}) {
  pending.set(id, target);
  await page.evaluate(
    async ({ id, target, backend, bin }) => {
      const { invoke, Channel } = await import(
        "/src/renderer/lib/desktop/core.ts"
      );
      window.runs ??= {};
      const diagnostics = new Channel();
      window.runs[id] = invoke("compile_latex_snapshot", {
        projectDir: target,
        mainFile: "main.tex",
        backend,
        engine: "pdflatex",
        installation: backend === "latexmk" ? bin : null,
        diagnostics,
        compilationId: id,
      })
        .then(
          (result) => ({ result }),
          (error) => ({ error }),
        )
        .finally(() => diagnostics.dispose());
    },
    { id, target, backend, bin },
  );
}
async function result(id) {
  const value = await page.evaluate(async (id) => await window.runs[id], id);
  pending.delete(id);
  return value;
}
async function cancel(ids, target = project, caller = page) {
  return caller.evaluate(
    async ({ ids, target }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke("cancel_compilation", {
        projectDir: target,
        compilationIds: ids,
      });
    },
    { ids, target },
  );
}
async function sourceMap(compilationId, caller = page) {
  return caller.evaluate(
    async ({ projectDir, compilationId }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      return invoke("get_synctex_source_map", { projectDir, compilationId });
    },
    { projectDir: project, compilationId },
  );
}
async function snapshotBytes(snapshot) {
  return page.evaluate(
    async (snapshot) => [
      ...new Uint8Array(await (await fetch(snapshot.url)).arrayBuffer()),
    ],
    snapshot,
  );
}
try {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));

  await setSource("baseline");
  await compile("baseline");
  const baseline = await result("baseline");
  assert.ok(baseline.result?.byteLength > 100, JSON.stringify(baseline));
  const baselineBytes = await snapshotBytes(baseline.result);
  const baselineMap = await sourceMap();
  assert.ok(Object.keys(baselineMap.inputs).length > 0);

  await setSource("tree_first");
  await compile("tree_first");
  await started("tree_first");
  const firstPids = await treePids("tree_first");
  assert.ok(firstPids.every(alive));
  // Wrong request/project and a forged owner field cannot stop this operation.
  await cancel(["unknown"]);
  await cancel(["tree_first"], tectonicProject);
  const newWindow = app.waitForEvent("window");
  await page.evaluate(() => window.catalex.invoke("create_new_window"));
  const second = await newWindow;
  await second.waitForFunction(() => Boolean(window.catalex));
  const owner = await page.evaluate(() => window.catalex.windowId);
  await second.evaluate(
    async ({ target, owner }) => {
      const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
      await invoke("cancel_compilation", {
        projectDir: target,
        compilationIds: ["tree_first"],
        windowId: owner,
      });
    },
    { target: project, owner },
  );
  assert.ok(
    firstPids.every(alive),
    "Other windows/requests must not kill this build",
  );

  await setSource("after_first");
  await compile("after_first");
  await cancel(["tree_first"]);
  assert.ok(
    firstPids.every((pid) => !alive(pid)),
    "Stop must wait for all tree members to exit",
  );
  assert.equal((await result("tree_first")).error?.code, "cancelled");
  assert.ok((await result("after_first")).result?.byteLength > 100);
  assert.deepEqual(
    (await record("after_first")).overlap,
    [],
    "Next compile started before prior tree cleanup",
  );
  assert.deepEqual(await snapshotBytes(baseline.result), baselineBytes);
  assert.notDeepEqual(await sourceMap(), baselineMap);
  assert.deepEqual(await sourceMap("baseline"), baselineMap);
  await assert.rejects(sourceMap("baseline", second));
  await assert.rejects(sourceMap("missing-result"));
  console.log(
    "PASS exact-request source maps survive later completion and reject other owners/missing IDs",
  );
  console.log(
    "PASS scoped cancellation reaps TERM-resistant child/grandchild processes before the next build",
  );

  // Hold the lock again, cancel only its waiting request, and then verify the
  // cancelled build's partial output did not replace the published map/PDF.
  const lastGoodMap = await sourceMap();
  await setSource("tree_wait");
  await compile("tree_wait");
  await started("tree_wait");
  const waitingPids = await treePids("tree_wait");
  await setSource("never_run");
  await compile("cancel_waiter");
  await cancel(["cancel_waiter"]);
  assert.equal((await result("cancel_waiter")).error?.code, "cancelled");
  assert.ok(waitingPids.every(alive));
  await cancel(["tree_wait"]);
  assert.equal((await result("tree_wait")).error?.code, "cancelled");
  assert.ok(waitingPids.every((pid) => !alive(pid)));
  assert.deepEqual(await sourceMap(), lastGoodMap);
  assert.deepEqual(await snapshotBytes(baseline.result), baselineBytes);
  assert.ok(
    !(await fs.readFile(path.join(signals, "builds"), "utf8")).includes(
      "never_run",
    ),
  );
  console.log(
    "PASS cancellation during native lock wait and preservation of published PDF/SyncTeX",
  );

  await cancel(["before_registration"]);
  await compile("before_registration");
  assert.equal((await result("before_registration")).error?.code, "cancelled");
  await cancel(["before_registration"]);
  await setSource("after_cancel");
  await compile("after_cancel");
  assert.ok((await result("after_cancel")).result?.byteLength > 100);
  assert.deepEqual((await record("after_cancel")).overlap, []);
  console.log(
    "PASS pre-registration and repeated Stop cannot cancel a newer request",
  );

  // Exercise the bundled Tectonic subprocess itself, without replacing it with
  // a fixture. The infinite TeX loop makes cancellation timing deterministic.
  await fs.writeFile(
    path.join(tectonicProject, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\loop\\iftrue\\repeat\n\\end{document}\n",
  );
  await compile("tectonic_cancel", {
    target: tectonicProject,
    backend: "tectonic",
  });
  await expect.poll(tectonicPids, { timeout: 20000 }).not.toEqual([]);
  const tectonic = tectonicPids();
  await cancel(["tectonic_cancel"], tectonicProject);
  assert.equal((await result("tectonic_cancel")).error?.code, "cancelled");
  assert.ok(tectonic.every((pid) => !alive(pid)));
  await fs.writeFile(
    path.join(tectonicProject, "main.tex"),
    source("tectonic_after"),
  );
  await compile("tectonic_after", {
    target: tectonicProject,
    backend: "tectonic",
  });
  const tectonicAfter = await result("tectonic_after");
  assert.ok(
    tectonicAfter.result?.byteLength > 100,
    JSON.stringify(tectonicAfter),
  );
  console.log(
    "PASS actual Tectonic process cancellation and subsequent compilation",
  );
} finally {
  // Cancel owned requests first; fixture fallback cleanup also runs when the
  // implementation under test fails, so failed tests leave no infinite workers.
  if (page && !page.isClosed()) {
    for (const [id, target] of pending)
      await Promise.race([
        cancel([id], target).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
  }
  for (const file of await fs.readdir(signals)) {
    if (!file.endsWith(".pid")) continue;
    const pid = Number(await fs.readFile(path.join(signals, file), "utf8"));
    if (alive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  for (const pid of tectonicPids()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  await app?.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
