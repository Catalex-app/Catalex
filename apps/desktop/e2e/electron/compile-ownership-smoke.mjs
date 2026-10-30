import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const profile = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-compile-ownership-"),
);
const bin = path.join(profile, "bin");
const signals = path.join(profile, "signals");
await fs.mkdir(bin);
await fs.mkdir(signals);
const fixture = path.join(root, "public/examples/letter-formal/main.pdf");
// A real child process controlled by files: Rust still stages the source,
// acquires its compiler lock, launches the tool, and transports the PDF/errors.
await fs.writeFile(
  path.join(bin, "latexmk"),
  `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = process.argv.at(-1);
if (!file.endsWith('.tex')) process.exit(0);
const id = fs.readFileSync(file, 'utf8').match(/CASE=(\\w+)/)[1];
const signal = path.join(${JSON.stringify(signals)}, id);
fs.writeFileSync(signal + '.started', fs.readFileSync(file, 'utf8'));
fs.appendFileSync(path.join(${JSON.stringify(signals)}, 'builds'), id + '\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(signal + '.release')) return;
  clearInterval(timer);
  if (fs.readFileSync(signal + '.release', 'utf8') === 'fail') {
    console.error(file + ':2: Delayed fixture failure');
    process.exit(1);
  }
  fs.copyFileSync(${JSON.stringify(fixture)}, file.replace(/\\.tex$/, '.pdf'));
}, 20);
`,
  { mode: 0o755 },
);
await fs.writeFile(path.join(bin, "pdflatex"), "#!/bin/sh\nexit 0\n", {
  mode: 0o755,
});
const projects = {};
for (const name of [
  "old",
  "new",
  "failed",
  "draft",
  "rewind",
  "git",
  "queue",
]) {
  projects[name] = path.join(profile, name);
  await fs.mkdir(projects[name]);
  await fs.writeFile(
    path.join(projects[name], "main.tex"),
    `% CASE=${name}\n\\documentclass{article}\n\\begin{document}Test\\end{document}\n`,
  );
}
await fs.writeFile(
  path.join(projects.new, "alternate.tex"),
  "% CASE=alternate\n\\documentclass{article}\n\\begin{document}Alternate\\end{document}\n",
);
function git(...args) {
  return execFileSync("git", ["-C", projects.git, ...args], { stdio: "pipe" });
}
git("init", "-q");
git("config", "user.name", "Compile test");
git("config", "user.email", "compile-test@example.invalid");
git("add", ".");
git("commit", "-qm", "Baseline");
// Keep automatic React preview requests out of the deterministic race checks.
// This page still runs in the actual Electron renderer with the real preload/service.
let isolated = true;
const vite = await createServer({
  root,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
  plugins: [
    {
      name: "compile-ownership-fixture",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!isolated || request.url !== "/") return next();
          response.setHeader("Content-Type", "text/html");
          response.end(
            await server.transformIndexHtml(
              "/",
              '<html><head></head><body><div id="root">Compilation ownership smoke</div></body></html>',
            ),
          );
        });
      },
    },
  ],
});
await vite.listen();
let app;
try {
  const env = {
    ...process.env,
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.catalex));
  await page.evaluate(async (bin) => {
    const { useAgentReviewQueueStore } = await import(
      "/src/renderer/stores/agent-review-queue-store.ts"
    );
    const { useProposedChangesStore } = await import(
      "/src/renderer/stores/proposed-changes-store.ts"
    );
    const { usePausedReviewStore } = await import(
      "/src/renderer/stores/paused-review-store.ts"
    );
    for (const store of [
      useAgentReviewQueueStore,
      useProposedChangesStore,
      usePausedReviewStore,
    ])
      await store.persist.rehydrate();
    const { useOnboardingStore } = await import(
      "/src/renderer/stores/onboarding-store.ts"
    );
    useOnboardingStore.getState().finish();
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore.setState({
      latexInstallation: bin,
      compilerBackend: "latexmk",
      compilerEngine: "pdflatex",
    });
    window.runs = {};
  }, bin);
  async function open(name) {
    await page.evaluate(async (project) => {
      const { useDocumentStore: store } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      await store.getState().openProject(project);
      // Explicit requests control timing in this smoke; disable initial auto-compile.
      store.setState({ initialized: false });
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      useSettingsStore
        .getState()
        .setCompilerChoiceForRoot(project, "main.tex", {
          backend: "latexmk",
          engine: "pdflatex",
          autoEngine: false,
        });
    }, projects[name]);
  }
  async function start(name, wait = true) {
    await page.evaluate(async (name) => {
      const { compileWorkspace } = await import(
        "/src/renderer/lib/workspace-compile.ts"
      );
      window.runs[name] = compileWorkspace({ force: true });
    }, name);
    if (!wait) return;
    await expect
      .poll(
        async () =>
          fs.access(path.join(signals, `${name}.started`)).then(
            () => true,
            () => false,
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  }
  async function release(name, outcome = "ok") {
    await fs.writeFile(path.join(signals, `${name}.release`), outcome);
    await page.evaluate(async (name) => await window.runs[name], name);
    if (name === "new")
      await expect.poll(async () => (await state()).compiling).toBe(false);
  }
  async function state() {
    return page.evaluate(async () => {
      const { useDocumentStore: store, getCurrentPdfBytes } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      const s = store.getState();
      return {
        compiling: s.isCompiling,
        pending: s.pendingRecompile,
        error: s.compileError,
        pdf: getCurrentPdfBytes()?.byteLength ?? 0,
        diagnostics: [...s.compileDiagnosticsCache],
        generations: [...s.lastCompiledGenerations],
      };
    });
  }
  await open("queue");
  await start("queue");
  await page.evaluate(async () => {
    const { compileWorkspace } = await import(
      "/src/renderer/lib/workspace-compile.ts"
    );
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    await compileWorkspace({ force: true, snapshot: true });
    const state = useDocumentStore.getState();
    state.updateFileContent(
      "main.tex",
      `${state.files.find((f) => f.id === "main.tex").content.replace("CASE=queue", "CASE=latest")}% newest edit\n`,
    );
    await compileWorkspace();
    await compileWorkspace({ force: true });
  });
  assert.equal(
    await fs.readFile(path.join(signals, "builds"), "utf8"),
    "queue\n",
  );
  await release("queue");
  await expect
    .poll(async () =>
      fs.readFile(path.join(signals, "latest.started"), "utf8").catch(() => ""),
    )
    .toContain("% newest edit");
  assert.equal(
    await fs.readFile(path.join(signals, "builds"), "utf8"),
    "queue\nlatest\n",
  );
  assert.equal((await state()).pdf, 0);
  await fs.writeFile(path.join(signals, "latest.release"), "ok");
  await expect.poll(async () => (await state()).compiling).toBe(false);
  assert.ok((await state()).pdf > 100);
  console.log(
    "PASS manual and auto requests coalesce and compile the newest saved content",
  );
  await open("old");
  await start("old");
  await open("new");
  await start("new", false);
  await release("old");
  assert.deepEqual(await state(), {
    compiling: true,
    pending: false,
    error: null,
    pdf: 0,
    diagnostics: [],
    generations: [],
  });
  await release("new");
  assert.ok((await state()).pdf > 100);
  assert.equal((await state()).compiling, false);
  const missingResult = await page.evaluate(async (projectDir) => {
    const { invoke } = await import("/src/renderer/lib/desktop/core.ts");
    return invoke("get_compiled_pdf", {
      projectDir,
      requestId: "unknown-build",
    });
  }, projects.new);
  assert.equal(
    missingResult,
    null,
    "A missing request must never return the latest project's PDF",
  );
  console.log(
    "PASS request-specific PDF lookup cannot substitute another build",
  );
  console.log(
    "PASS late native success cannot publish into a new project or stop its spinner",
  );

  await open("failed");
  await start("failed");
  await open("new");
  const before = await state();
  await release("failed", "fail");
  assert.deepEqual(await state(), before);
  console.log(
    "PASS late native failure cannot publish errors into a new project",
  );

  for (const name of ["draft", "rewind", "git"]) {
    await open(name);
    if (name === "rewind") {
      await page.evaluate(async () => {
        const { useHistoryStore } = await import(
          "/src/renderer/stores/history-store.ts"
        );
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const project = useDocumentStore.getState().projectRoot;
        await useHistoryStore.getState().init(project);
        await useHistoryStore.getState().createSnapshot(project, "Before edit");
        await useHistoryStore.getState().loadSnapshots(project);
        window.restorePoint = useHistoryStore.getState().snapshots[0].id;
      });
    }
    if (name !== "draft") {
      await page.evaluate(async () => {
        const { useDocumentStore: store } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        store
          .getState()
          .updateFileContent(
            "main.tex",
            store.getState().files.find((f) => f.id === "main.tex").content +
              "% changed after baseline\n",
          );
        await store.getState().saveAllFiles({ requireClean: true });
      });
    }
    await start(name);
    await page.evaluate(async (name) => {
      const { useDocumentStore: store } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      if (name === "draft") {
        await store
          .getState()
          .activateAgentWorkspace("test-draft", store.getState().projectRoot);
      } else if (name === "rewind") {
        const { useHistoryStore } = await import(
          "/src/renderer/stores/history-store.ts"
        );
        await useHistoryStore
          .getState()
          .restoreSnapshot(store.getState().projectRoot, window.restorePoint);
      } else {
        window.gitRun = store.getState().runGitOperation(
          store.getState().projectRoot,
          {},
          () =>
            new Promise((resolve) => {
              window.finishGit = resolve;
            }),
        );
      }
    }, name);
    if (name === "git") {
      await page.waitForFunction(() => typeof window.finishGit === "function");
      git("checkout", "--", "main.tex");
      await page.evaluate(async () => {
        window.finishGit();
        await window.gitRun;
      });
    }
    if (name !== "draft")
      assert.ok(
        !(
          await fs.readFile(path.join(projects[name], "main.tex"), "utf8")
        ).includes("changed after baseline"),
      );
    const before = await state();
    await release(name);
    assert.deepEqual(await state(), before);
    console.log(`PASS late native result ignored after ${name} transition`);
  }
  const artifacts = path.resolve(
    root,
    "../../output/playwright/compile-ownership",
  );
  await fs.mkdir(artifacts, { recursive: true });
  isolated = false;
  await app.evaluate(async ({ BrowserWindow }, url) => {
    await BrowserWindow.getAllWindows()[0].loadURL(url);
  }, `http://127.0.0.1:${vite.httpServer.address().port}`);
  await page.waitForFunction(
    () => document.querySelector("#root")?.children.length,
  );
  await open("new");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.setState({ initialized: true });
  });
  await expect
    .poll(async () => (await state()).pdf, { timeout: 15000 })
    .toBeGreaterThan(100);
  await fs.writeFile(path.join(signals, "alternate.release"), "ok");
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    const { useSettingsStore } = await import(
      "/src/renderer/stores/settings-store.ts"
    );
    useSettingsStore
      .getState()
      .setCompilerChoiceForRoot(
        useDocumentStore.getState().projectRoot,
        "alternate.tex",
        { backend: "latexmk", engine: "pdflatex", autoEngine: false },
      );
    useDocumentStore.getState().setActiveFile("alternate.tex");
  });
  await expect
    .poll(
      async () =>
        fs.access(path.join(signals, "alternate.started")).then(
          () => true,
          () => false,
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  await expect.poll(async () => (await state()).pdf).toBeGreaterThan(100);
  await expect.poll(async () => (await state()).compiling).toBe(false);
  const buildsBeforeReturn = await fs.readFile(
    path.join(signals, "builds"),
    "utf8",
  );
  await page.evaluate(async () => {
    const { useDocumentStore } = await import(
      "/src/renderer/stores/document-store.ts"
    );
    useDocumentStore.getState().setActiveFile("main.tex");
  });
  await page.waitForTimeout(1000);
  assert.equal(
    await fs.readFile(path.join(signals, "builds"), "utf8"),
    buildsBeforeReturn,
  );
  console.log(
    "PASS switching to an uncompiled root builds it and returning to a cached root does not rebuild",
  );
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(artifacts, "workspace.png") });
} finally {
  // Unblock any fixture process on failures before shutting down the service.
  for (const name of Object.keys(projects))
    await fs.writeFile(path.join(signals, `${name}.release`), "ok");
  await app?.close();
  await vite.close();
  await fs.rm(profile, { recursive: true, force: true });
}
