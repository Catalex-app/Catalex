import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
let vite;
let desktop;
let desktopClosed;
let stopping = false;

function reportError(error) {
  console.error(error);
  process.exitCode = 1;
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (desktop?.exitCode === null && desktop.signalCode === null) desktop.kill();
  // Keep the renderer server available while Electron flushes pending writes.
  await desktopClosed;
  await vite?.close();
}

process.once("SIGINT", () => void stop(130).catch(reportError));
process.once("SIGTERM", () => void stop(143).catch(reportError));

try {
  vite = await createServer({
    root,
    server: { host: "127.0.0.1", port: 14220, strictPort: true },
  });
  if (!stopping) await vite.listen();
  if (stopping) {
    // A signal may arrive while Vite is being created or starting to listen.
    await vite.close();
  } else {
    vite.printUrls();
    const env = { ...process.env, CATALEX_DEV_URL: "http://127.0.0.1:14220" };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = spawn(electron, [root], {
      env,
      stdio: "inherit",
      // The runner forwards Ctrl+C to Electron, which shuts down its helpers.
      detached: process.platform !== "win32",
    });
    desktopClosed = new Promise((resolve) => {
      desktop.once("close", (code) => {
        resolve();
        void stop(code ?? 1).catch(reportError);
      });
    });
    desktop.once("error", (error) => {
      reportError(error);
      void stop(1).catch(reportError);
    });
  }
} catch (error) {
  reportError(error);
  await stop(1).catch(reportError);
}
