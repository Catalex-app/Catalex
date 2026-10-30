import { useEffect } from "react";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectFileWatch } from "@/hooks/use-project-file-watch";
import { LatexEditor } from "@/components/workspace/editor/latex-editor";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const root = "/tmp/external-files-harness";
const initial = {
  "main.tex": "\\section{Example}\nOriginal paragraph.\nAnother paragraph.\n",
  "comments.json": '{"comments": ["Example"]}\n',
};
const disk = new Map<string, string>(Object.entries(initial));
let ready = false;
let watchId = "";
let signal: (paths: string[], rescan?: boolean) => Promise<unknown> =
  async () => {};

declare global {
  interface Window {
    __externalFilesHarness?: {
      write: (
        path: string,
        content: string | null,
        notify?: boolean,
      ) => Promise<void>;
      disk: (path: string) => string | null;
      state: () => unknown;
    };
  }
}

function setup() {
  if (ready) return;
  ensureDesktopBrowserMocks();
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    }
  ).__TAURI_INTERNALS__;
  const fallback = internals.invoke.bind(internals);
  signal = (paths, rescan = false) =>
    fallback("plugin:event|emit", {
      event: "project-files-changed",
      payload: { projectRoot: root, watchId, paths, rescan },
    });
  internals.invoke = async (command, args = {}) => {
    if (command === "plugin:path|join")
      return (args.paths as string[]).join("/");
    const path = String(args.path ?? "").replace(`${root}/`, "");
    if (command === "watch_project_files") {
      watchId = String(args.watchId);
      return;
    }
    if (command === "unwatch_project_files") {
      if (watchId === args.watchId) watchId = "";
      return;
    }
    if (command === "save_file_if_unchanged") {
      const filePath = String(args.filePath);
      const current = disk.get(filePath) ?? null;
      if (current !== args.expected) return { written: false, current };
      disk.set(filePath, String(args.content));
      await signal([filePath]);
      return { written: true, current: args.content };
    }
    if (command === "plugin:fs|exists" && String(args.path).startsWith(root))
      return disk.has(path) || args.path === root;
    if (command === "plugin:fs|read_dir" && args.path === root)
      return [...disk.keys()].map((name) => ({
        name,
        isDirectory: false,
        isFile: true,
        isSymlink: false,
      }));
    if (command === "plugin:fs|stat" && String(args.path).startsWith(root))
      return { size: disk.get(path)?.length ?? 0 };
    if (
      command === "plugin:fs|read_text_file" &&
      String(args.path).startsWith(root)
    ) {
      if (!disk.has(path)) throw new Error("File missing");
      return Array.from(new TextEncoder().encode(disk.get(path)));
    }
    return fallback(command, args);
  };
  window.__externalFilesHarness = {
    write: async (path, content, notify = true) => {
      if (content === null) disk.delete(path);
      else disk.set(path, content);
      if (notify) await signal([path], true);
    },
    disk: (path) => disk.get(path) ?? null,
    state: () => useDocumentStore.getState().files,
  };
  ready = true;
}

export function ExternalFilesHarness() {
  setup();
  useProjectFileWatch();
  const files = useDocumentStore((state) => state.files);
  useEffect(() => {
    useDocumentStore.setState({
      projectRoot: root,
      agentWorkspaceRoot: null,
      isAgentWorkspaceReadOnly: false,
      isGitOperationRunning: false,
      files: Object.entries(initial).map(([id, content]) => ({
        id,
        name: id,
        relativePath: id,
        absolutePath: `${root}/${id}`,
        content,
        type: id.endsWith(".tex") ? "tex" : "other",
        isDirty: false,
      })),
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex", "comments.json"],
      initialized: true,
    });
  }, []);
  return (
    <div className="h-screen bg-background p-4 text-foreground">
      <div className="mb-3 flex gap-2">
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            className="rounded border px-3 py-1"
            onClick={() => useDocumentStore.getState().setActiveFile(file.id)}
          >
            {file.name}
          </button>
        ))}
      </div>
      <div className="h-[80vh] overflow-hidden rounded-lg border">
        <LatexEditor suppressToolbar />
      </div>
    </div>
  );
}
