import {
  PRODUCT_NAME,
  APP_NAMESPACE,
  APP_ID,
  PROFILE_DIRECTORY,
  APP_PROTOCOL,
  ASSET_PROTOCOL,
} from "../branding";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  session,
  shell,
} from "electron";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FileAccess, filesystemCommand, isWithin } from "./file-access";
import { NativeService, type Reply } from "./service";
import { detectEditors, openInEditor } from "./editors";
import { ManagedStorage, CACHE_CLEANUP_INTERVAL_MS } from "./managed-storage";
import { ProjectOwnership } from "./project-ownership";
import { storeChatAttachment } from "./chat-attachments";
import {
  cancelSavedFork,
  forkSavedChat,
  prepareSavedChatTurn,
  syncSavedChat,
  appendChatReviewDecision,
  includeChatReviewDecisions,
  loadChatCheckpoint,
  loadChatMessages,
  saveChatCheckpoint,
} from "./chat-checkpoints";
import { WorkspaceStateStorage } from "./workspace-state-storage";
import { PdfSnapshots } from "./pdf-snapshots";
import { RENDERER_CSP } from "./security";

const exec = promisify(execFile);
function environmentDirectory(value: string | undefined, fallback: string) {
  return value && path.isAbsolute(value) ? value : fallback;
}
const desktopRoot = path.resolve(__dirname, "../..");
const rendererRoot = path.join(desktopRoot, "dist", "renderer");
const developmentUrl = process.env.CATALEX_DEV_URL;
if (
  developmentUrl &&
  !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(developmentUrl)
) {
  throw new Error("The development URL must use a loopback address.");
}
const isolatedProfile = process.env.CATALEX_USER_DATA_DIR;
// Catalex starts with fresh storage; leave previous TexBuddy folders untouched.
if (isolatedProfile) app.setPath("userData", path.resolve(isolatedProfile));
else
  app.setPath("userData", path.join(app.getPath("appData"), PROFILE_DIRECTORY));
const workspaceState = new WorkspaceStateStorage(
  path.join(app.getPath("userData"), "workspace-state"),
);
app.setName(PRODUCT_NAME);
// Chromium storage must have one process owner, including dev/installed launches.
// Acquire the lock after selecting userData so isolated profiles remain independent.
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
  {
    scheme: ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const pdfSnapshots = new PdfSnapshots(
  path.join(app.getPath("userData"), "pdf-snapshots"),
);
const windows = new Map<string, BrowserWindow>();
const projectOwnership = new ProjectOwnership(() => {
  for (const win of windows.values())
    send(win, "project-ownership-changed", null);
});
const projectCleanup = new Map<string, Promise<void>>();
function cleanupWindowProjects(id: string) {
  projectOwnership.invalidate(id);
  void pdfSnapshots.closeWindow(id).catch(console.error);
  const cleanup = (projectCleanup.get(id) ?? Promise.resolve())
    .then(() => service.request(id, "__close_window", {}))
    .catch((error) => console.error("Window cleanup failed", error))
    .then(() => projectOwnership.releaseWindow(id));
  projectCleanup.set(id, cleanup);
  void cleanup.then(() => {
    if (projectCleanup.get(id) === cleanup) projectCleanup.delete(id);
  });
}
const chatCheckpointWrites = new Map<string, Promise<unknown>>();
const closeHandlers = new Set<number>();
const approvedClose = new Set<number>();
const files = new FileAccess();
let service: NativeService;
let managedStorage: ManagedStorage;
let quitting = false;
let terminationRequested = false;

function send(win: BrowserWindow, event: string, payload?: unknown) {
  if (!win.isDestroyed())
    win.webContents.send("desktop:event", { event, payload });
}

function trustedSender(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (
    !win ||
    ![...windows.values()].includes(win) ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error("Untrusted desktop request.");
  }
  const url = new URL(event.senderFrame.url);
  const valid = developmentUrl
    ? url.origin === new URL(developmentUrl).origin
    : url.protocol === `${APP_PROTOCOL}:` && url.host === "app";
  if (!valid) throw new Error("Untrusted desktop origin.");
  return win;
}

function windowId(win: BrowserWindow) {
  return [...windows].find(([, candidate]) => candidate === win)?.[0] ?? "main";
}

async function openExternal(value: unknown) {
  if (typeof value !== "string") throw new Error("A URL or path is required.");
  if (/^(https?:|mailto:)/i.test(value)) return shell.openExternal(value);
  const file = value.startsWith("file:") ? fileURLToPath(value) : value;
  const error = await shell.openPath(await files.check(file));
  if (error) throw new Error(error);
}

async function createWindow(id: string, query = "") {
  const current = windows.get(id);
  if (current && !current.isDestroyed()) {
    current.show();
    current.focus();
    return current;
  }
  const settings = id === "settings";
  const debug = id === "debug";
  const win = new BrowserWindow({
    title: settings ? "" : debug ? `${PRODUCT_NAME} — Debug` : PRODUCT_NAME,
    width: settings ? 720 : debug ? 560 : 1400,
    height: settings ? 520 : debug ? 700 : 900,
    minWidth: settings ? 720 : debug ? 400 : 800,
    minHeight: settings ? 420 : debug ? 400 : 600,
    ...(settings ? { maxWidth: 720, maxHeight: 900 } : {}),
    show: false,
    backgroundColor: "#ffffff",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          // Center the 14-point native buttons in the renderer's 40px toolbar.
          trafficLightPosition: { x: 14, y: 13 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [`--catalex-window=${id}`],
    },
  });
  windows.set(id, win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(`Renderer ${id} stopped: ${details.reason}`);
    closeHandlers.delete(win.id);
    cleanupWindowProjects(id);
  });
  win.webContents.on(
    "did-start-navigation",
    (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace && win.webContents.getURL())
        cleanupWindowProjects(id);
    },
  );
  win.on("focus", () => send(win, "window-focus-restored"));
  win.on("resize", () => send(win, "desktop:window:resized"));
  win.on("close", (event) => {
    if (!quitting && closeHandlers.has(win.id) && !approvedClose.has(win.id)) {
      event.preventDefault();
      send(win, "desktop:window:close-requested");
    }
  });
  win.on("closed", () => {
    windows.delete(id);
    closeHandlers.delete(win.id);
    approvedClose.delete(win.id);
    cleanupWindowProjects(id);
  });
  win.once("ready-to-show", () => {
    if (!settings && !debug) win.maximize();
    win.show();
  });
  await win.loadURL(`${developmentUrl ?? `${APP_PROTOCOL}://app`}/${query}`);
  return win;
}

async function clipboardFiles() {
  if (process.platform === "darwin") {
    const script =
      'set paths to ""\ntry\nrepeat with f in (the clipboard as list)\ntry\nset paths to paths & POSIX path of (f as alias) & linefeed\nend try\nend repeat\nend try\nreturn paths';
    const { stdout } = await exec("osascript", ["-e", script]);
    return stdout.trim().split("\n").filter(Boolean);
  }
  if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }",
      ],
      { windowsHide: true },
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean);
  }
  const items = await clipboard.read();
  const item = items.find((entry) => entry.types.includes("text/uri-list"));
  if (!item) return [];
  const data = await item.getType("text/uri-list");
  if (!(data instanceof Blob)) return [];
  const uris = await data.text();
  return uris
    .split(/\r?\n/)
    .filter((line) => line.startsWith("file:"))
    .map((uri) => fileURLToPath(uri));
}

async function hostCommand(
  win: BrowserWindow,
  command: string,
  args: Record<string, any>,
): Promise<Reply> {
  if (command.startsWith("desktop:fs:"))
    return { result: await filesystemCommand(files, command.slice(11), args) };
  switch (command) {
    case "desktop:pdf:open":
      return {
        result: await pdfSnapshots.copy(
          windowId(win),
          await files.check(args.path),
        ),
      };
    case "desktop:pdf:release":
      await pdfSnapshots.release(windowId(win), args.id);
      return { result: null };
    case "desktop:pdf:export":
      await pdfSnapshots.export(
        windowId(win),
        args.id,
        await files.check(args.path),
      );
      return { result: null };
    case "compile_latex_snapshot": {
      let failure: Reply | undefined;
      try {
        const result = await pdfSnapshots.create(
          windowId(win),
          async (snapshotPath) => {
            const reply = await service.request(windowId(win), command, {
              ...args,
              snapshotPath,
            });
            if ("error" in reply) {
              failure = reply;
              throw new Error("Compilation failed");
            }
            if (win.isDestroyed())
              throw new Error("Window closed during compilation");
          },
        );
        return { result };
      } catch (error) {
        if (failure) return failure;
        throw error;
      }
    }

    case "desktop:workspace-state:read":
    case "desktop:workspace-state:write":
    case "desktop:workspace-state:migrate":
    case "desktop:workspace-state:remove": {
      if (typeof args.key !== "string")
        throw new Error("Invalid recovery key.");
      const result = await workspaceState.run(async () => {
        if (command.endsWith(":read")) return workspaceState.read(args.key);
        if (command.endsWith(":migrate"))
          return workspaceState.migrate(args.key, args.value);
        if (command.endsWith(":remove")) return workspaceState.remove(args.key);
        return workspaceState.write(
          args.key,
          args.value,
          args.revision,
          args.base,
        );
      });
      if (command.endsWith(":write")) {
        for (const other of windows.values()) {
          if (other !== win && !other.isDestroyed())
            other.webContents.send("desktop:event", {
              event: "workspace-state-changed",
              payload: { key: args.key },
            });
        }
      }
      return { result };
    }
    case "load_shared_session":
    case "desktop:chat:cancel-fork":
    case "desktop:chat:fork":
    case "desktop:chat:prepare-turn":
    case "desktop:chat:sync-shared":
    case "desktop:chat:append-review":
    case "desktop:chat:messages":
    case "desktop:chat:checkpoint-load":
    case "desktop:chat:checkpoint-save": {
      const projectRoot = await files.check(
        args.projectRoot ?? args.projectPath,
      );
      const reply = await service.request(
        windowId(win),
        "prepare_project_storage",
        { projectRoot },
      );
      if ("error" in reply) throw new Error(String(reply.error));
      if (
        typeof reply.result !== "string" ||
        !/^[a-f0-9-]+$/i.test(reply.result)
      )
        throw new Error("Invalid project storage ID.");
      const directory = path.join(
        managedStorage.dataPath,
        "projects",
        reply.result,
        "sessions",
        "checkpoints",
      );
      const previous = chatCheckpointWrites.get(directory) ?? Promise.resolve();
      const operation = previous
        .catch(() => {})
        .then<unknown>(async () => {
          if (command === "load_shared_session") {
            const reply = await service.request(windowId(win), command, args);
            if ("error" in reply) throw new Error(String(reply.error));
            const session = reply.result as {
              messages: Array<{ uuid?: string }>;
            };
            return {
              ...session,
              messages: await includeChatReviewDecisions(
                directory,
                args.sharedSessionId,
                session.messages,
              ),
            };
          }
          if (command === "desktop:chat:cancel-fork")
            return cancelSavedFork(directory, args.tabId, args.sharedSessionId);
          if (command === "desktop:chat:fork")
            return forkSavedChat(
              directory,
              args.tabId,
              args.runtimeSessionKey,
              args.messageIndex,
              args.tab,
            );
          if (command === "desktop:chat:prepare-turn")
            return prepareSavedChatTurn(
              directory,
              args.tabId,
              args.runtimeSessionKey,
              args.cursor,
              args.retry,
            );
          if (command === "desktop:chat:sync-shared") {
            const previous = await service.request(
              windowId(win),
              "shared_session_metadata",
              {
                projectPath: projectRoot,
                sharedSessionId: args.sharedSessionId,
              },
            );
            if ("error" in previous) throw new Error(String(previous.error));
            return syncSavedChat(
              directory,
              args.tabId,
              args.runtimeSessionKey,
              previous.result as any,
              args.pendingQuestion,
            );
          }
          if (command === "desktop:chat:append-review")
            return appendChatReviewDecision(
              directory,
              args.tabId,
              args.runtimeSessionKey,
              args.message,
            );
          return command === "desktop:chat:checkpoint-save"
            ? saveChatCheckpoint(directory, args.snapshot)
            : command === "desktop:chat:messages"
              ? loadChatMessages(directory, args.tabId, args.start, args.limit)
              : loadChatCheckpoint(directory);
        });
      chatCheckpointWrites.set(directory, operation);
      try {
        return { result: await operation };
      } finally {
        if (chatCheckpointWrites.get(directory) === operation)
          chatCheckpointWrites.delete(directory);
      }
    }
    case "desktop:chat:attachment": {
      const projectRoot = await files.check(args.projectRoot);
      const sourcePath = args.sourcePath
        ? await files.check(args.sourcePath)
        : undefined;
      const result = await storeChatAttachment(
        async () => {
          const reply = await service.request(
            windowId(win),
            "prepare_project_storage",
            { projectRoot },
          );
          if ("error" in reply) throw new Error(String(reply.error));
          if (
            typeof reply.result !== "string" ||
            !/^[a-f0-9-]+$/i.test(reply.result)
          )
            throw new Error("Invalid project storage ID.");
          const directory = path.join(
            managedStorage.dataPath,
            "projects",
            reply.result,
            "sessions",
            "media",
          );
          await fs.mkdir(directory, { recursive: true });
          return directory;
        },
        { sourcePath, name: args.name, bytes: args.bytes },
      );
      return { result };
    }

    case "desktop:project:acquire": {
      const id = windowId(win);
      await projectCleanup.get(id);
      const generation = projectOwnership.generation(id);
      const projectPath = await files.check(args.path);
      if (win.isDestroyed())
        throw new Error("The requesting window has closed.");
      const token = await projectOwnership.acquire(projectPath, id, generation);
      if (win.isDestroyed()) {
        projectOwnership.release(token, id);
        throw new Error("The requesting window has closed.");
      }
      return { result: token };
    }
    case "desktop:shell:trash": {
      await shell.trashItem(await files.check(args.path));
      return { result: null };
    }
    case "desktop:project:trash": {
      const projectPath = await files.check(args.path);
      const canonical = await fs.realpath(projectPath);
      if (
        canonical === path.parse(canonical).root ||
        canonical === (await fs.realpath(os.homedir()))
      )
        throw new Error(
          "The home folder and filesystem root cannot be moved to Trash.",
        );
      await projectOwnership.trash(projectPath, (target) =>
        shell.trashItem(target),
      );
      return { result: null };
    }
    case "desktop:project:release":
      projectOwnership.release(String(args.token), windowId(win));
      return { result: null };
    case "desktop:project:owners": {
      if (
        !Array.isArray(args.paths) ||
        args.paths.length > 100 ||
        !args.paths.every((p: unknown) => typeof p === "string")
      )
        throw new Error("Project paths are required.");
      const owners = await Promise.all(
        args.paths.map(async (p: string) => [
          p,
          await files
            .check(p)
            .then((checked) => projectOwnership.owner(checked))
            .catch(() => null),
        ]),
      );
      return { result: Object.fromEntries(owners) };
    }
    case "desktop:project:focus": {
      const owner = await projectOwnership.owner(await files.check(args.path));
      const target = owner ? windows.get(owner) : undefined;
      if (!target || target.isDestroyed()) return { result: false };
      if (target.isMinimized()) target.restore();
      target.show();
      target.focus();
      return { result: true };
    }
    case "desktop:path:homeDir":
      return { result: os.homedir() + path.sep };
    case "desktop:path:configDir":
      return { result: app.getPath("appData") + path.sep };
    case "desktop:path:join":
      if (
        !Array.isArray(args.paths) ||
        !args.paths.every((part: unknown) => typeof part === "string")
      )
        throw new Error("Invalid path components.");
      return { result: path.join(...args.paths) };
    case "desktop:dialog:open": {
      const options = args.options ?? {};
      const result = await dialog.showOpenDialog(win, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
        properties: [
          options.directory ? "openDirectory" : "openFile",
          ...(options.multiple ? ["multiSelections" as const] : []),
          ...(options.noResolveAliases ? ["noResolveAliases" as const] : []),
        ],
      });
      for (const file of result.filePaths) await files.grant(file);
      return {
        result: result.canceled
          ? null
          : options.multiple
            ? result.filePaths
            : result.filePaths[0],
      };
    }
    case "desktop:dialog:save": {
      const options = args.options ?? {};
      const result = await dialog.showSaveDialog(win, {
        title: options.title,
        defaultPath: options.defaultPath,
        filters: options.filters,
      });
      if (result.filePath) await files.grant(result.filePath);
      return { result: result.canceled ? null : result.filePath };
    }
    case "desktop:dialog:ask": {
      const options = args.options ?? {};
      const result = await dialog.showMessageBox(win, {
        message: String(args.message),
        title: options.title,
        type: options.kind ?? "question",
        buttons: [options.cancelLabel ?? "Cancel", options.okLabel ?? "OK"],
        cancelId: 0,
        defaultId: options.defaultButton === "cancel" ? 0 : 1,
      });
      return { result: result.response === 1 };
    }
    case "desktop:shell:open":
      await openExternal(args.path);
      return { result: null };
    case "desktop:app:getVersion":
      return { result: app.getVersion() };
    case "desktop:webview:setZoom":
      if (
        typeof args.scaleFactor !== "number" ||
        !Number.isFinite(args.scaleFactor) ||
        args.scaleFactor < 0.5 ||
        args.scaleFactor > 3
      )
        throw new Error("Invalid zoom level.");
      win.webContents.setZoomFactor(args.scaleFactor);
      if (process.platform === "darwin") {
        win.setWindowButtonPosition({
          x: 14,
          y: Math.round(20 * args.scaleFactor - 7),
        });
      }
      return { result: null };
    case "desktop:window:show":
      win.show();
      return { result: null };
    case "desktop:window:close":
      approvedClose.add(win.id);
      win.close();
      return { result: null };
    case "desktop:window:isFullscreen":
      return { result: win.isFullScreen() };
    case "desktop:window:setTitle":
      win.setTitle(String(args.title));
      return { result: null };
    case "desktop:window:setCloseHandler":
      if (args.enabled) closeHandlers.add(win.id);
      else closeHandlers.delete(win.id);
      return { result: null };
    case "desktop:process:relaunch":
      app.relaunch();
      app.quit();
      return { result: null };
    case "desktop:updater:check":
      return {
        result: {
          unavailable: true,
          message: "Updates are unavailable in this Electron migration build.",
        },
      };
    case "rerun_setup": {
      const main = await createWindow("main");
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
      if (win !== main) {
        approvedClose.add(win.id);
        win.close();
      }
      return { result: null };
    }
    case "create_new_window":
      await createWindow(`window-${crypto.randomUUID()}`);
      return { result: null };
    case "open_debug_window":
      await createWindow("debug", "?debug=1");
      return { result: null };
    case "open_settings_window": {
      const provider = ["codex", "claude", "pi"].includes(args.provider)
        ? args.provider
        : "";
      const query = new URLSearchParams({ settings: "1" });
      if (args.section === "agent" || args.section === "storage") {
        query.set("section", args.section);
        if (provider) query.set("provider", provider);
      }
      const existing = windows.has("settings");
      const settings = await createWindow("settings", `?${query}`);
      if (existing && (args.section === "agent" || args.section === "storage"))
        send(
          settings,
          "settings-navigate",
          args.section === "storage" ? "storage" : provider || "agent",
        );
      return { result: null };
    }
    case "desktop:storage:clear-browser-cache":
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
      return { result: null };
    case "desktop:storage:list":
      return { result: await managedStorage.list(args.recentPaths ?? []) };
    case "desktop:storage:clear":
      await managedStorage.clear(args.projectId, args.action, async (paths) => {
        await workspaceState.run(() => workspaceState.clearProjects(paths));
        for (const window of windows.values()) {
          if (!window.isDestroyed()) {
            for (const key of [
              "catalex-agent-review-queue",
              "catalex-proposed-changes",
              "catalex-paused-review",
            ])
              window.webContents.send("desktop:event", {
                event: "workspace-state-changed",
                payload: { key },
              });
          }
        }
      });
      return { result: null };
    case "desktop:storage:limit":
      await managedStorage.setHistoryLimit(args.projectId, args.bytes);
      return { result: null };
    case "desktop:storage:reveal": {
      const error = await shell.openPath(
        await managedStorage.revealPath(args.projectId),
      );
      if (error) throw new Error(error);
      return { result: null };
    }
    case "get_system_info":
      return {
        result: {
          os:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : process.platform,
          os_version: os.release(),
          arch: process.arch,
          app_version: app.getVersion(),
        },
      };
    case "js_log":
      console.log(String(args.msg));
      return { result: null };
    case "restore_current_webview":
      send(win, "window-focus-restored");
      return { result: null };
    case "webview_repaint_probe_ack":
      return { result: null };
    case "desktop:clipboard:readText":
      return { result: await clipboard.readText() };
    case "read_clipboard_file_paths": {
      const paths = await clipboardFiles();
      for (const file of paths) await files.grant(file);
      return { result: paths };
    }
    case "detect_editors":
      return { result: await detectEditors() };
    case "open_in_editor":
      await openInEditor(args, await files.check(args.projectPath));
      return { result: null };
    case "export_markdown_pdf_native": {
      const destination = await files.check(args.filePath);
      const bytes = await win.webContents.printToPDF({
        pageSize: "A4",
        printBackground: true,
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: true,
      });
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes);
        await fs.rename(temporary, destination);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
      return { result: true };
    }
    default:
      if (command.startsWith("desktop:") || command.startsWith("__"))
        throw new Error(`Unknown desktop operation: ${command}`);
      return service.request(windowId(win), command, args);
  }
}

async function start() {
  if (terminationRequested) return;
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback) => {
      const trusted =
        contents &&
        [...windows.values()].some((win) => win.webContents === contents);
      callback(!!trusted && permission === "clipboard-sanitized-write");
    },
  );
  session.defaultSession.setPermissionCheckHandler((contents, permission) => {
    return (
      !!contents &&
      [...windows.values()].some((win) => win.webContents === contents) &&
      permission === "clipboard-sanitized-write"
    );
  });
  const resources = app.isPackaged
    ? process.resourcesPath
    : path.join(desktopRoot, "backend", "resources");
  const nativeRoot = app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(desktopRoot, "dist", "native");
  const binary =
    process.env.CATALEX_SERVICE_PATH ??
    path.join(
      nativeRoot,
      `${APP_NAMESPACE}-desktop${process.platform === "win32" ? ".exe" : ""}`,
    );
  const bridge = app.isPackaged
    ? path.join(process.resourcesPath, "claude-bridge", "index.mjs")
    : path.resolve(desktopRoot, "../desktop-sidecar/dist/index.mjs");
  const domainData = path.join(
    process.platform === "linux"
      ? environmentDirectory(
          process.env.XDG_DATA_HOME,
          path.join(os.homedir(), ".local", "share"),
        )
      : app.getPath("appData"),
    APP_ID,
  );
  const domainCache =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches", APP_ID)
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA ?? app.getPath("appData"), APP_ID)
        : path.join(
            environmentDirectory(
              process.env.XDG_CACHE_HOME,
              path.join(os.homedir(), ".cache"),
            ),
            APP_ID,
          );
  const data = isolatedProfile
    ? path.join(app.getPath("userData"), "data")
    : domainData;
  const cache = isolatedProfile
    ? path.join(app.getPath("userData"), "project-cache")
    : domainCache;
  managedStorage = new ManagedStorage(
    data,
    cache,
    app.getPath("userData"),
    projectOwnership,
  );
  for (const directory of [data, cache])
    await fs.mkdir(directory, { recursive: true });
  for (const directory of [
    os.homedir(),
    os.tmpdir(),
    resources,
    app.getPath("userData"),
  ])
    await files.grant(directory);
  if (!existsSync(binary))
    throw new Error(
      "Native helper is missing. Run pnpm build:desktop before launching Electron.",
    );
  if (!existsSync(bridge))
    throw new Error("Claude bridge is missing. Run pnpm build:claude-sidecar.");
  if (terminationRequested) return;
  service = new NativeService(
    binary,
    {
      ...process.env,
      CATALEX_DATA_DIR: data,
      CATALEX_CACHE_DIR: cache,
      CATALEX_RESOURCE_DIR: resources,
      CATALEX_NODE_EXECUTABLE: process.execPath,
      CATALEX_CLAUDE_BRIDGE: bridge,
    },
    (event) => {
      for (const [id, win] of windows)
        if (!event.windowId || event.windowId === id)
          send(win, event.event, event.payload);
    },
    (message) => {
      console.error(message);
      if (!quitting && !terminationRequested)
        dialog.showErrorBox(
          PRODUCT_NAME + " service stopped",
          `${message}\nRestart ${PRODUCT_NAME} to reconnect. Unsaved editor content remains in the window.`,
        );
    },
  );
  protocol.handle(APP_PROTOCOL, async (request) => {
    const url = new URL(request.url);
    const filename = path.resolve(
      rendererRoot,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (url.host !== "app" || !isWithin(rendererRoot, filename))
      return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(filename).toString());
    response.headers.set("Content-Security-Policy", RENDERER_CSP);
    return response;
  });
  protocol.handle(ASSET_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host === "pdf") {
        const origin = developmentUrl
          ? new URL(developmentUrl).origin
          : `${APP_PROTOCOL}://app`;
        const response =
          request.method === "OPTIONS"
            ? new Response(null, { status: 204 })
            : await pdfSnapshots.respond(request);
        response.headers.set("Access-Control-Allow-Origin", origin);
        response.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, DELETE, OPTIONS",
        );
        return response;
      }
      if (url.host !== "local") throw new Error("Invalid asset host");
      const filename = await files.check(
        decodeURIComponent(url.pathname.slice(1)),
      );
      const response = await net.fetch(pathToFileURL(filename).toString());
      response.headers.set(
        "Access-Control-Allow-Origin",
        developmentUrl
          ? new URL(developmentUrl).origin
          : `${APP_PROTOCOL}://app`,
      );
      response.headers.set(
        "Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      );
      return response;
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  ipcMain.handle("desktop:invoke", async (event, command, args) => {
    try {
      const win = trustedSender(event);
      if (
        typeof command !== "string" ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        throw new Error("Invalid desktop request.");
      return await hostCommand(win, command, args);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:emit", (event, name, payload) => {
    trustedSender(event);
    if (
      !["debug-log-entry", "debug-log-sync-request", "debug-log-sync"].includes(
        name,
      )
    )
      throw new Error("Unknown application event.");
    for (const win of windows.values()) send(win, name, payload);
  });
  ipcMain.on("desktop:grant-file", (event, file) => {
    try {
      trustedSender(event);
      if (typeof file === "string" && path.isAbsolute(file))
        void files.grant(file).catch(console.error);
    } catch (error) {
      console.error(error);
    }
  });
  const menu: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: "about" as const },
              {
                label: "Preferences…",
                accelerator: "CmdOrCtrl+,",
                click: () => void createWindow("settings", "?settings=1"),
              },
              { type: "separator" as const },
              { role: "services" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  powerMonitor.on("resume", () => {
    for (const win of windows.values()) send(win, "window-focus-restored");
  });
  await createWindow("main", process.env.CATALEX_TEST_QUERY ?? "");
  const cleanupCaches = () => {
    void managedStorage
      .cleanupUnusedCaches()
      .catch((error) => console.warn("Project cache cleanup failed", error));
  };
  cleanupCaches();
  const cacheCleanupTimer = setInterval(
    cleanupCaches,
    CACHE_CLEANUP_INTERVAL_MS,
  );
  cacheCleanupTimer.unref();
  app.once("will-quit", () => clearInterval(cacheCleanupTimer));
}

app.on("window-all-closed", () => app.quit());
function handleTermination() {
  terminationRequested = true;
  app.quit();
}
process.on("SIGINT", handleTermination);
process.on("SIGTERM", handleTermination);
app.on("before-quit", (event) => {
  // Let each renderer flush pending project/chat writes, including on Cmd+Q.
  if (windows.size > 0 && closeHandlers.size > 0) {
    event.preventDefault();
    for (const win of windows.values()) win.close();
    return;
  }
  quitting = true;
});
let serviceStopped = false;
app.on("will-quit", (event) => {
  // Renderer close handlers have finished their final chat/settings writes.
  if (app.isReady()) session.defaultSession.flushStorageData();
  if (!service || serviceStopped) return;
  event.preventDefault();
  void service.close().finally(() => {
    serviceStopped = true;
    app.quit();
  });
});
app.on("second-instance", () => {
  const win = windows.get("main") ?? windows.values().next().value;
  if (!win || win.isDestroyed()) return; // Initial startup will show its window.
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

if (ownsProfile)
  app
    .whenReady()
    .then(start)
    .catch((error) => {
      console.error(error);
      if (!quitting && !terminationRequested)
        dialog.showErrorBox(
          PRODUCT_NAME + " could not start",
          error instanceof Error ? error.message : String(error),
        );
      app.quit();
    });
