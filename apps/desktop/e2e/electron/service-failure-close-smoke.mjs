import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { createServer } from "vite";

// Real Electron/native IPC, isolated profiles and project files. Only native
// dialog responses are automated. No user process or model service is touched.
// Requires a desktop build; process identification below targets macOS/Linux.
const root = fileURLToPath(new URL("../..", import.meta.url));
const fixture = await fs.mkdtemp(
  path.join(os.tmpdir(), "catalex-service-close-"),
);
const native = path.join(fixture, "catalex-desktop");
const builtNative =
  process.env.CATALEX_SERVICE_PATH ??
  path.join(root, "dist/native/catalex-desktop");
const bin = path.join(fixture, "bin");
const artifacts = path.resolve(root, "../../output/playwright/service-close");
const source =
  "\\documentclass{article}\n\\begin{document}\nSaved source.\n\\end{document}\n";
const edited = source.replace("Saved source.", "Unsaved manuscript change.");
const chatText = "Unsaved chat content remains available.";
await fs.copyFile(builtNative, native);
const nativeLibraries = path.join(path.dirname(builtNative), "lib");
if (await fs.stat(nativeLibraries).catch(() => null))
  await fs.cp(nativeLibraries, path.join(fixture, "lib"), { recursive: true });
await fs.chmod(native, 0o755);
await fs.mkdir(bin);
await fs.mkdir(artifacts, { recursive: true });
await fs.writeFile(path.join(bin, "pi"), '#!/bin/sh\nprintf "1.0.0\\n"\n', {
  mode: 0o755,
});
let app;
let vite;

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nativePid() {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((row) => {
      const [, pid, ppid, command] = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: Number(pid), ppid: Number(ppid), command };
    });
  const child = rows.find(
    ({ ppid, command }) => ppid === app.process().pid && command === native,
  );
  assert.ok(child, "native child belongs to this isolated Electron process");
  return child.pid;
}

async function launch(mode) {
  const profile = path.join(fixture, mode);
  const project = path.join(profile, "project");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "main.tex"), source);
  const env = {
    ...process.env,
    PATH: [bin, process.env.PATH].join(path.delimiter),
    CATALEX_USER_DATA_DIR: profile,
    CATALEX_DEV_URL: `http://127.0.0.1:${vite.httpServer.address().port}`,
    CATALEX_SERVICE_PATH: native,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [root], env, timeout: 30000 });
  app.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
  await app.evaluate(({ dialog }) => {
    globalThis.closeSmoke = { failures: [], dialogs: [], response: 0 };
    dialog.showErrorBox = (title, content) => {
      globalThis.closeSmoke.failures.push({ title, content });
    };
    dialog.showMessageBox = async (_window, options) => {
      globalThis.closeSmoke.dialogs.push(options);
      return {
        response: globalThis.closeSmoke.response,
        checkboxChecked: false,
      };
    };
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForFunction(
    () => window.catalex && document.querySelector("#root")?.children.length,
  );
  await bounded(
    page.evaluate(async (project) => {
      const { useOnboardingStore } = await import(
        "/src/renderer/stores/onboarding-store.ts"
      );
      const { useSettingsStore } = await import(
        "/src/renderer/stores/settings-store.ts"
      );
      const { useDocumentStore } = await import(
        "/src/renderer/stores/document-store.ts"
      );
      useOnboardingStore.getState().finish();
      useSettingsStore.setState({ autoCompileByProject: { [project]: false } });
      await useDocumentStore.getState().openProject(project);
    }, project),
    `${mode}: open project`,
  );
  await page.locator(".cm-content").first().waitFor();
  console.log(`Service close smoke: ${mode} ready`);
  return { page, project };
}

async function edit(page) {
  await bounded(
    page.evaluate(
      async ({ edited, chatText }) => {
        const { useDocumentStore } = await import(
          "/src/renderer/stores/document-store.ts"
        );
        const { useAgentChatStore } = await import(
          "/src/renderer/stores/agent-chat-store.ts"
        );
        useDocumentStore.getState().updateFileContent("main.tex", edited);
        const chat = useAgentChatStore.getState();
        chat._appendMessage(chat.activeTabId, {
          type: "user",
          uuid: "close-smoke-message",
          message: { content: [{ type: "text", text: chatText }] },
        });
      },
      { edited, chatText },
    ),
    "Edit manuscript and chat",
  );
}

async function requestClose(mode) {
  if (mode === "signal") app.process().kill("SIGINT");
  else
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
}

try {
  vite = await createServer({
    root,
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  });
  await vite.listen();
  for (const mode of ["healthy", "window", "signal"]) {
    console.log(`Service close smoke: ${mode}`);
    const { page, project } = await launch(mode);
    if (mode !== "healthy") {
      process.kill(nativePid(), "SIGKILL");
      await expect
        .poll(() => app.evaluate(() => globalThis.closeSmoke.failures.length))
        .toBe(1);
      const reply = await bounded(
        page.evaluate(
          (projectRoot) =>
            window.catalex.invoke("prepare_project_storage", { projectRoot }),
          project,
        ),
        "Failed native request",
      );
      assert.match(reply.error, /Native service is unavailable/);
    }
    await edit(page);
    console.log(`Service close smoke: ${mode} edited`);
    if (mode !== "healthy") {
      await requestClose(mode);
      await expect
        .poll(() => app.evaluate(() => globalThis.closeSmoke.dialogs.length))
        .toBe(1);
      const dialog = await app.evaluate(() => globalThis.closeSmoke.dialogs[0]);
      assert.equal(dialog.title, "Close without saving?");
      assert.deepEqual(dialog.buttons, ["Stay open", "Close anyway"]);
      assert.equal(dialog.defaultId, 0);
      assert.equal(dialog.cancelId, 0);
      assert.match(dialog.message, /unsaved manuscript, chat, and comment/);
      assert.equal(app.windows().length, 1, "Stay open retained the window");
      const retained = await bounded(
        page.evaluate(async () => {
          const { useDocumentStore } = await import(
            "/src/renderer/stores/document-store.ts"
          );
          const { useAgentChatStore } = await import(
            "/src/renderer/stores/agent-chat-store.ts"
          );
          return {
            file: useDocumentStore
              .getState()
              .files.find((f) => f.id === "main.tex"),
            messages: useAgentChatStore.getState().tabs[0].messages,
            leaving: useAgentChatStore.getState().isLeavingProject,
          };
        }),
        "Inspect retained buffers",
      );
      assert.equal(retained.file.content, edited);
      assert.equal(retained.file.isDirty, true);
      assert.equal(retained.leaving, false);
      assert.ok(JSON.stringify(retained.messages).includes(chatText));
      await expect(page.locator(".cm-content").first()).toContainText(
        "Unsaved manuscript change.",
      );
      await page.screenshot({
        path: path.join(artifacts, `${mode}-stay-open.png`),
      });
      assert.equal(
        await fs.readFile(path.join(project, "main.tex"), "utf8"),
        source,
      );
      await app.evaluate(() => {
        globalThis.closeSmoke.response = 1;
      });
    }
    const closed = app.waitForEvent("close", { timeout: 30000 });
    await requestClose(mode);
    await closed;
    app = undefined;
    assert.equal(
      await fs.readFile(path.join(project, "main.tex"), "utf8"),
      mode === "healthy" ? edited : source,
    );
    console.log(`Service close smoke: ${mode} passed`);
  }
  console.log(
    "Electron service-close smoke passed: healthy save, native failure, retained manuscript/chat on Stay open, explicit window close, and repeated SIGINT with confirmation.",
  );
} catch (error) {
  console.error("Service close smoke failed:", error);
  if (app)
    console.error(
      await bounded(
        app.evaluate(() => globalThis.closeSmoke),
        "Read failure diagnostics",
      ).catch(String),
    );
  throw error;
} finally {
  // Cleanup is scoped to this test's process and temporary project. app.exit
  // avoids another save dialog if an assertion failed while the service is dead.
  if (app) {
    try {
      process.kill(nativePid(), "SIGKILL");
    } catch {}
    const closed = app
      .waitForEvent("close", { timeout: 10000 })
      .catch(() => {});
    await bounded(
      app.evaluate(({ app }) => app.exit(1)),
      "Fixture cleanup",
    ).catch(() => {});
    await closed;
  }
  if (vite) await vite.close();
  await fs.rm(fixture, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
