import { shell } from "electron";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { isWithin } from "./file-access";

const exec = promisify(execFile);
const editors = [
  {
    id: "cursor",
    name: "Cursor",
    cli: "cursor",
    mac: "/Applications/Cursor.app",
  },
  {
    id: "vscode",
    name: "VS Code",
    cli: "code",
    mac: "/Applications/Visual Studio Code.app",
  },
  { id: "zed", name: "Zed", cli: "zed", mac: "/Applications/Zed.app" },
  {
    id: "sublime",
    name: "Sublime Text",
    cli: "subl",
    mac: "/Applications/Sublime Text.app",
  },
  {
    id: "finder",
    name: process.platform === "darwin" ? "Finder" : "File manager",
    cli: "",
    mac: "/System/Library/CoreServices/Finder.app",
  },
  {
    id: "ghostty",
    name: "Ghostty",
    cli: "ghostty",
    mac: "/Applications/Ghostty.app",
  },
  { id: "iterm2", name: "iTerm2", cli: "", mac: "/Applications/iTerm.app" },
  { id: "kitty", name: "Kitty", cli: "kitty", mac: "/Applications/kitty.app" },
  {
    id: "antigravity",
    name: "Antigravity",
    cli: "antigravity",
    mac: "/Applications/Antigravity.app",
  },
];

async function exists(filename: string) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(cli: string) {
  if (!cli) return null;
  try {
    const { stdout } =
      process.platform === "win32"
        ? await exec("where.exe", [cli], { windowsHide: true })
        : await exec(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh", [
            "-lc",
            `command -v ${cli}`,
          ]);
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

async function readMacAppIcon(bundlePath: string) {
  let temporaryDirectory: string | undefined;
  try {
    // getFileIcon returns a generic .app icon on macOS. Read the declared
    // bundle icon so document-type icons in Resources cannot be picked instead.
    const { stdout } = await exec("/usr/bin/plutil", [
      "-extract",
      "CFBundleIconFile",
      "raw",
      "-o",
      "-",
      path.join(bundlePath, "Contents", "Info.plist"),
    ]);
    const name = stdout.trim();
    if (!name || path.basename(name) !== name) return null;
    const source = path.join(
      bundlePath,
      "Contents",
      "Resources",
      path.extname(name) ? name : `${name}.icns`,
    );
    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "catalex-app-icon-"),
    );
    const png = path.join(temporaryDirectory, "icon.png");
    await exec("/usr/bin/sips", [
      "-s",
      "format",
      "png",
      "-Z",
      "64",
      source,
      "--out",
      png,
    ]);
    return `data:image/png;base64,${(await readFile(png)).toString("base64")}`;
  } catch {
    // The renderer supplies a recognizable vector icon if extraction fails.
    return null;
  } finally {
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => {},
      );
  }
}

export async function detectEditors() {
  const available = await Promise.all(
    editors.map(async (editor) => {
      if (
        editor.id !== "finder" &&
        !(process.platform === "darwin"
          ? await exists(editor.mac)
          : await resolveCommand(editor.cli))
      )
        return null;
      const iconDataUrl =
        process.platform === "darwin" ? await readMacAppIcon(editor.mac) : null;
      return {
        id: editor.id,
        name: editor.name,
        iconPath: null,
        iconDataUrl,
      };
    }),
  );
  return available.filter((editor) => editor !== null);
}

export async function openInEditor(args: Record<string, any>, project: string) {
  const editor = editors.find((item) => item.id === args.editorId);
  if (!editor) throw new Error("Unknown external editor.");
  const file =
    typeof args.filePath === "string"
      ? path.resolve(project, args.filePath)
      : null;
  if (file && !isWithin(project, file))
    throw new Error("The file is outside this project.");
  if (editor.id === "finder") {
    if (file) shell.showItemInFolder(file);
    else {
      const error = await shell.openPath(project);
      if (error) throw new Error(error);
    }
    return;
  }
  if (
    process.platform === "darwin" &&
    ["iterm2", "ghostty", "kitty", "antigravity"].includes(editor.id)
  ) {
    await exec("/usr/bin/open", ["-a", editor.mac, project]);
    return;
  }
  let cli = await resolveCommand(editor.cli);
  if (!cli)
    throw new Error(`${editor.name}'s command-line launcher is unavailable.`);
  // The Windows launchers for Electron-based editors are .cmd wrappers.
  // Open their actual executable so project paths never pass through cmd.exe.
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    const executables: Record<string, string> = {
      vscode: "Code.exe",
      cursor: "Cursor.exe",
      antigravity: "Antigravity.exe",
    };
    const executable = executables[editor.id];
    const candidate =
      executable && path.resolve(path.dirname(cli), "..", executable);
    if (!candidate || !(await exists(candidate)))
      throw new Error(`${editor.name}'s executable could not be located.`);
    cli = candidate;
  }
  const argv = [project];
  if (file) {
    if (Number.isInteger(args.line) && args.line > 0)
      argv.push("-g", `${file}:${args.line}`);
    else argv.push(file);
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cli, argv, {
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
