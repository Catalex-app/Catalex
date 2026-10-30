import { useHistoryWorkspaceStore } from "@/stores/history-workspace-store";
import { FileTextIcon, FolderIcon, SparklesIcon } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { useEffect, useState } from "react";
import { HistoryWorkspace } from "@/components/workspace/history-workspace";
import { WorkspaceHistoryControl } from "@/components/workspace/workspace-history-control";
import { getCurrentPdfBytes, useDocumentStore } from "@/stores/document-store";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import {
  type FileDiff,
  type SnapshotInfo,
  useHistoryStore,
} from "@/stores/history-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const PROJECT_ROOT = "/tmp/catalex-history-workspace-harness";

const CURRENT_MAIN = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath, graphicx}
\title{Learning with structure}
\author{Research Group}

\begin{document}
\maketitle

\begin{abstract}
We study how structured representations improve generalization.
Our revised model learns a compact representation from sparse observations.
\end{abstract}

\section{Introduction}
Scientific discovery depends on identifying structure in complex data.
We introduce a framework that combines prior knowledge with learned features.
The evaluation now includes three complementary benchmarks.

\input{methods}

\section{Results}
Our model improves accuracy while requiring fewer labeled examples.
The revised experiments include uncertainty estimates for every benchmark.

\section{Conclusion}
Structured representations offer a practical path to data-efficient learning.
\end{document}
`;

const OLDER_MAIN = CURRENT_MAIN.replace(
  "Our revised model learns a compact representation from sparse observations.",
  "Our model learns useful representations from observations.",
)
  .replace(
    "The evaluation now includes three complementary benchmarks.",
    "We evaluate the framework on an initial benchmark.",
  )
  .replace("\\input{methods}", "\\input{obsolete}")
  .replace(
    "The revised experiments include uncertainty estimates for every benchmark.\n",
    "",
  );

const SHARED_SECTION = String.raw`\section{Shared protocol}
This unchanged nested section belongs to every reviewed manuscript version.
`;
const CONTENTS: Record<string, Record<string, string>> = {
  newest: {
    "main.tex": CURRENT_MAIN,
    "sections/shared.tex": SHARED_SECTION,
    "methods.tex": String.raw`\section{Methods}
We train the structured model with a consistency objective.
The new ablation study compares three representation families.
`,
    "references.bib":
      "@article{structure2026, title={Learning with structure}}\n",
  },
  older: {
    "main.tex": OLDER_MAIN,
    "sections/shared.tex": SHARED_SECTION,
    "obsolete.tex": String.raw`\section{Preliminary experiments}
This earlier experiment was removed from the current project.
`,
    "references.bib":
      "@article{structure2026, title={Learning with structure}}\n",
  },
  initial: {
    "main.tex": String.raw`\documentclass{article}
\title{Initial research outline}
\begin{document}
\section{Research question}
How can structure improve data-efficient learning?
\end{document}
`,
  },
};

const SNAPSHOTS: SnapshotInfo[] = [
  {
    id: "newest",
    message: "[manual] Revised submission",
    timestamp: Date.parse("2026-09-19T02:45:00Z") / 1000,
    labels: ["Revised submission"],
    changed_files: ["main.tex", "methods.tex", "obsolete.tex"],
  },
  {
    id: "older",
    message: "[manual] Before experiments",
    timestamp: Date.parse("2026-09-18T08:20:00Z") / 1000,
    labels: ["Before experiments"],
    changed_files: ["main.tex", "obsolete.tex", "references.bib"],
  },
  {
    id: "initial",
    message: "[init] Project opened",
    timestamp: Date.parse("2026-09-17T01:10:00Z") / 1000,
    labels: [],
    changed_files: ["main.tex"],
  },
];

const pdfFixtures = new Map<string, Promise<Uint8Array>>();
function loadPdfFixture(name: string) {
  let fixture = pdfFixtures.get(name);
  if (!fixture) {
    fixture = fetch(`/examples/${name}/main.pdf`).then(async (response) => {
      if (!response.ok) throw new Error(`PDF fixture unavailable: ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    pdfFixtures.set(name, fixture);
  }
  return fixture;
}

declare global {
  interface Window {
    __historyWorkspaceHarness?: {
      diffRequests: number;
      settledDiffRequests: number;
      restoreRequests: number;
      mediaReadRequests: {
        path: string;
        status: "pending" | "succeeded" | "failed";
      }[];
      settledMediaReadRequests: number;
      allowMediaReads: () => void;
      liveCommandRequests: string[];
      readLiveState: typeof readHarnessLiveState;
      setAgentRunning: (running: boolean) => void;
      anyAgentRunning: () => boolean;
      seedLiveSelection: () => void;
      setCurrentMainText: (text: string) => void;
      switchProject: () => void;
    };
  }
}

// Keep browser tests on the exact singleton modules used by the mounted UI.
// Ad-hoc dynamic /src imports can resolve a second store after Vite HMR updates.
function readHarnessLiveState() {
  const state = useDocumentStore.getState();
  return {
    files: state.files,
    content: state.content,
    activeFileId: state.activeFileId,
    openFileIds: state.openFileIds,
    cursorPosition: state.cursorPosition,
    selectionRange: state.selectionRange,
    pdfSelectionContext: state.pdfSelectionContext,
    jumpToPosition: state.jumpToPosition,
    jumpToSelectionRange: state.jumpToSelectionRange,
    pdfRevision: state.pdfRevision,
    pdfBytes: Array.from(
      (getCurrentPdfBytes() instanceof Uint8Array
        ? getCurrentPdfBytes()
        : []) as Uint8Array,
    ),
    compileError: state.compileError,
    isCompiling: state.isCompiling,
    contentGeneration: state.contentGeneration,
    chatTabs: JSON.parse(JSON.stringify(useAgentChatStore.getState().tabs)),
    compilerChoicesByRoot: useSettingsStore.getState().compilerChoicesByRoot,
    liveCommandRequests: window.__historyWorkspaceHarness?.liveCommandRequests,
  };
}

function installHistoryWorkspaceMocks() {
  ensureDesktopBrowserMocks();
  if (window.__historyWorkspaceHarness) return;
  let mediaAvailable = !new URLSearchParams(window.location.search).has(
    "mediaFailure",
  );
  const harnessState: NonNullable<Window["__historyWorkspaceHarness"]> = {
    diffRequests: 0,
    settledDiffRequests: 0,
    restoreRequests: 0,
    mediaReadRequests: [],
    settledMediaReadRequests: 0,
    allowMediaReads: () => {
      mediaAvailable = true;
    },
    liveCommandRequests: [],
    readLiveState: readHarnessLiveState,
    setAgentRunning: (isStreaming) => {
      const state = useAgentChatStore.getState();
      const tabs = state.tabs.length
        ? state.tabs
        : useAgentChatStore.getInitialState().tabs;
      useAgentChatStore.setState({
        tabs: tabs.map((tab) => ({ ...tab, isStreaming })),
      });
    },
    anyAgentRunning: () =>
      useAgentChatStore.getState().tabs.some((tab) => tab.isStreaming),
    setCurrentMainText: (text) =>
      useDocumentStore.getState().updateFileContent("main.tex", text),
    switchProject: () =>
      useDocumentStore.setState({ projectRoot: "/tmp/other-history-project" }),
    seedLiveSelection: () =>
      useDocumentStore.setState({
        cursorPosition: 23,
        selectionRange: { start: 5, end: 17 },
        pdfSelectionContext: {
          label: "Existing live PDF selection",
          filePath: "main.tex",
          selectedText: "Keep this live context",
        },
        jumpToPosition: 31,
      }),
  };
  window.__historyWorkspaceHarness = harnessState;
  const harnessWindow = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke?: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
    };
  };
  const internals = harnessWindow.__TAURI_INTERNALS__;
  if (!internals?.invoke) return;
  const fallbackInvoke = internals.invoke.bind(internals);
  const params = new URLSearchParams(window.location.search);
  const mixedSnapshots: SnapshotInfo[] = [
    ...(params.has("commentCheckpoints")
      ? [
          ["agent-comment", "[agent-comments] First comment on main.tex"],
          ["reconnect-comments", "[comments] Before reconnecting comments"],
          ["clear-comments", "[comments] Before clearing comments"],
          ["first-comment", "[comments] First comment on main.tex"],
        ]
      : []),
    ["newest", "[agent] Applied reviewed changes"],
    ["before-agent-apply", "[agent] Before applying reviewed changes"],
    ["manual-save", "[manual] Save"],
    ["agent-base", "[agent] Before agent work"],
    ["after-pull", "[git] After pull"],
    ["before-pull", "[git] Before pull"],
    ["initial", "[init] Project opened"],
  ].map(([id, message], index) => ({
    id,
    message,
    timestamp: SNAPSHOTS[0].timestamp - index * 900,
    labels: id === "manual-save" ? ["My edits"] : [],
    changed_files: ["main.tex"],
  }));
  if (params.has("mixedOperations")) {
    for (const [index, snapshot] of mixedSnapshots.entries()) {
      CONTENTS[snapshot.id] = {
        ...CONTENTS.newest,
        "main.tex": CURRENT_MAIN.replace(
          "\\end{document}",
          `\\section{Revision notes}
${
  params.has("commentCheckpoints")
    ? snapshot.message.replace(/^\[[^\]]*\]\s*/, "")
    : [
        "Agent clarified the findings after review.",
        "User edits preserved before applying the agent draft.",
        "User revised the introduction.",
        "Agent started from the synchronized manuscript.",
        "Collaborator changes received from the remote repository.",
        "Local manuscript before pulling collaborator changes.",
        "Initial manuscript.",
      ][index]
}
\\end{document}`,
        ),
      };
    }
  }

  let labelSnapshots = params.has("mixedOperations")
    ? mixedSnapshots
    : params.has("agentLabel")
      ? SNAPSHOTS.map((snapshot, index) =>
          index === 0
            ? {
                ...snapshot,
                message: params.has("commentLabel")
                  ? "[agent-comments] First comment on main.tex"
                  : "[agent] Applied reviewed changes",
                labels: params.has("manualLabels") ? ["Draft", "Checked"] : [],
              }
            : { ...snapshot, labels: [...snapshot.labels] },
        )
      : SNAPSHOTS.map((snapshot) => ({
          ...snapshot,
          labels: [...snapshot.labels],
        }));
  if (
    params.has("fullStack") &&
    !params.has("mixedOperations") &&
    !params.has("agentLabel")
  ) {
    labelSnapshots.push(
      ...[1, 2, 3].map((index) => ({
        ...SNAPSHOTS[2],
        id: `archive-${index}`,
        timestamp: SNAPSHOTS[2].timestamp - index * 86400,
        message: `Earlier checkpoint ${index}`,
      })),
    );
  }
  if (params.has("storagePressure")) {
    const remaining = 65 - labelSnapshots.length;
    labelSnapshots.push(
      ...Array.from({ length: remaining }, (_, index) => ({
        ...SNAPSHOTS[2],
        id: `storage-archive-${index}`,
        labels: [],
        timestamp: SNAPSHOTS[2].timestamp - (index + 1) * 86400,
        message: "[manual] Earlier draft",
      })),
    );
  }
  let usageBytes = (params.has("storagePressure") ? 200 : 42) * 1024 * 1024;
  let limitBytes = 250 * 1024 * 1024;
  const storageInfo = () => ({
    usageBytes,
    limitBytes,
    snapshotCount: labelSnapshots.length,
    protectedSnapshotCount: labelSnapshots.filter(
      (snapshot) => snapshot.labels.length > 0,
    ).length,
  });
  let labelFailed = false;
  internals.invoke = async (command, args = {}) => {
    if (
      [
        "save_file_if_unchanged",
        "history_snapshot",
        "history_add_label",
      ].includes(command)
    )
      harnessState.liveCommandRequests.push(command);
    if (
      command === "save_file_if_unchanged" &&
      params.has("checkpointSaveFailure")
    )
      throw new Error("File could not be written");
    if (command === "history_init") return null;
    if (command === "history_snapshot") {
      if (params.has("checkpointFailure"))
        throw new Error("History unavailable");
      if (!params.has("checkpointDemo")) return null;
      if (params.has("checkpointDelay"))
        await new Promise((resolve) => setTimeout(resolve, 300));
      const content = Object.fromEntries(
        useDocumentStore
          .getState()
          .files.filter((file) => file.content !== undefined)
          .map((file) => [
            file.relativePath,
            file.diskContent ?? file.content!,
          ]),
      );
      if (
        JSON.stringify(content) ===
        JSON.stringify(CONTENTS[labelSnapshots[0].id])
      )
        return null;
      const snapshot: SnapshotInfo = {
        id: `checkpoint-${labelSnapshots.length}`,
        message: String(args.message),
        timestamp: Math.floor(Date.now() / 1000),
        labels: [],
        changed_files: ["main.tex"],
      };
      CONTENTS[snapshot.id] = content;
      labelSnapshots.unshift(snapshot);
      return snapshot;
    }
    if (command === "history_list") {
      if (Number(args.offset ?? 0) > 0) return [];
      return labelSnapshots;
    }
    if (command === "history_label_counts") {
      const counts: Record<string, number> = {};
      for (const snapshot of labelSnapshots)
        for (const label of snapshot.labels)
          counts[label] = (counts[label] ?? 0) + 1;
      return counts;
    }
    if (command === "history_add_label" || command === "history_remove_label") {
      if (
        command === "history_add_label" &&
        params.has("checkpointLabelFailure") &&
        !labelFailed
      ) {
        labelFailed = true;
        throw new Error("Label storage unavailable");
      }
      const snapshot = labelSnapshots.find(
        (item) => item.id === args.snapshotId,
      );
      if (!snapshot) throw new Error("Checkpoint not found");
      const label = String(args.label).trim();
      if (label === "Agent" && command === "history_add_label")
        throw new Error("Agent is reserved for automatic labels");
      snapshot.labels =
        command === "history_add_label"
          ? [...new Set([...snapshot.labels, label])]
          : snapshot.labels.filter((item) => item !== label);
      return null;
    }
    if (command === "history_diff") {
      harnessState.diffRequests += 1;
      try {
        const fromId = String(args.fromId ?? "newest");
        const toId = String(args.toId ?? "newest");
        if (params.has("delayDiff")) {
          const delay = fromId === "older" || toId === "older" ? 800 : 60;
          await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
        if (params.has("diffFailure")) {
          throw new Error("This snapshot could not be read. Please try again.");
        }
        const before = CONTENTS[fromId] ?? CONTENTS.newest;
        const after = CONTENTS[toId] ?? CONTENTS.newest;
        const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
        const changes: FileDiff[] = [];
        for (const filePath of paths) {
          if (before[filePath] === after[filePath]) continue;
          changes.push({
            file_path: filePath,
            status:
              before[filePath] === undefined
                ? "added"
                : after[filePath] === undefined
                  ? "deleted"
                  : "modified",
            old_content: before[filePath] ?? null,
            new_content: after[filePath] ?? null,
          });
        }
        return changes;
      } finally {
        harnessState.settledDiffRequests += 1;
      }
    }
    if (command === "history_file_bytes") {
      if (args.filePath === "archived.svg") {
        const color = args.snapshotId === "older" ? "#e87932" : "#2563eb";
        return btoa(
          `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240"><rect width="400" height="240" fill="${color}"/><text x="30" y="130" fill="white" font-size="28">${args.snapshotId} figure</text></svg>`,
        );
      }
      const bytes = await loadPdfFixture("letter-formal");
      return btoa(
        Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
      );
    }
    if (command === "history_snapshot_files") {
      return [
        ...Object.keys(CONTENTS[String(args.snapshotId)] ?? {}),
        ...(params.has("recordedAssets")
          ? ["archived.svg", "report.pdf", "dataset.zip"]
          : []),
      ];
    }
    if (
      command === "plugin:fs|read_file" &&
      [`${PROJECT_ROOT}/letter.pdf`, `${PROJECT_ROOT}/report.pdf`].includes(
        String(args.path),
      )
    ) {
      const request: (typeof harnessState.mediaReadRequests)[number] = {
        path: String(args.path),
        status: "pending",
      };
      harnessState.mediaReadRequests.push(request);
      const isReport = request.path.endsWith("/report.pdf");
      try {
        if (isReport && params.has("delayMedia")) {
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
        if (isReport && !mediaAvailable) {
          throw new Error(
            "Current PDF is temporarily unavailable. Please retry.",
          );
        }
        const bytes = await loadPdfFixture(
          isReport ? "newsletter" : "letter-formal",
        );
        request.status = "succeeded";
        return bytes;
      } catch (error) {
        request.status = "failed";
        throw error;
      } finally {
        harnessState.settledMediaReadRequests += 1;
      }
    }
    if (
      [
        "compile_latex",
        "history_compile_pdf",
        "plugin:fs|write_file",
        "plugin:fs|write_text_file",
        "synctex_edit",
        "synctex_view",
        "get_synctex_source_map",
      ].includes(command)
    ) {
      harnessState.liveCommandRequests.push(command);
    }
    if (command === "history_file_at") {
      const content =
        CONTENTS[String(args.snapshotId)]?.[String(args.filePath)];
      if (content === undefined) throw new Error("File not in this snapshot");
      return content;
    }
    if (command === "history_restore") {
      harnessState.restoreRequests += 1;
      throw new Error("Restoration is disabled in the browser harness");
    }
    if (command === "history_storage_info") return storageInfo();
    if (command === "history_set_storage_limit") {
      limitBytes = Number(args.limitBytes);
      if (params.has("storagePressure") && usageBytes > limitBytes) {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        labelSnapshots = labelSnapshots.filter(
          (snapshot, index) => index < 50 || snapshot.labels.length > 0,
        );
        usageBytes = 85 * 1024 * 1024;
      }
      return storageInfo();
    }
    if (command === "history_clear") {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      const id = "b94ef738a61024cbd5628f8390c2d57613bce4a9";
      CONTENTS[id] = { ...CONTENTS.newest, "main.tex": CURRENT_MAIN };
      labelSnapshots = [
        {
          id,
          message: "[init] History restarted",
          timestamp: Math.floor(Date.now() / 1000),
          labels: [],
          changed_files: Object.keys(CONTENTS[id]),
        },
      ];
      usageBytes = 12 * 1024;
      return storageInfo();
    }
    return fallbackInvoke(command, args);
  };
}

export function HistoryWorkspaceHarness() {
  const theme =
    new URLSearchParams(window.location.search).get("theme") === "dark"
      ? "dark"
      : "light";
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme={theme}
      forcedTheme={theme}
      enableSystem={false}
      storageKey="history-workspace-harness-theme"
    >
      <HistoryWorkspaceHarnessContent />
    </ThemeProvider>
  );
}

function HistoryWorkspaceHarnessContent() {
  installHistoryWorkspaceMocks();
  const [draft, setDraft] = useState("Please review the revised introduction.");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready && new URLSearchParams(window.location.search).has("openRewind"))
      useHistoryWorkspaceStore.getState().setOpen(true);
  }, [ready]);

  useEffect(() => {
    let canceled = false;
    void loadPdfFixture("letter-formal").then(() => {
      if (canceled) return;
      useHistoryStore.getState().reset();
      useDocumentStore.setState({
        projectRoot: PROJECT_ROOT,
        initialized: true,
        files: [
          ...Object.entries(CONTENTS.newest).map(([path, content]) => ({
            id: path,
            name: path,
            relativePath: path,
            absolutePath: `${PROJECT_ROOT}/${path}`,
            type: path.endsWith(".tex") ? ("tex" as const) : ("bib" as const),
            content,
            isDirty: false,
          })),
          {
            id: "overview.svg",
            name: "overview.svg",
            relativePath: "overview.svg",
            absolutePath: `${PROJECT_ROOT}/overview.svg`,
            type: "image",
            dataUrl: "/cat-leaf.svg",
            isDirty: false,
          },
          {
            id: "letter.pdf",
            name: "letter.pdf",
            relativePath: "letter.pdf",
            absolutePath: `${PROJECT_ROOT}/letter.pdf`,
            type: "pdf",
            isDirty: false,
          },
          {
            id: "report.pdf",
            name: "report.pdf",
            relativePath: "report.pdf",
            absolutePath: `${PROJECT_ROOT}/report.pdf`,
            type: "pdf",
            isDirty: false,
          },
        ],
        folders: ["sections"],
        activeFileId: "main.tex",
        openFileIds: ["main.tex"],
      });
      setReady(true);
    });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <div
      data-testid="history-workspace-harness-shell"
      data-media-ready={ready}
      className="h-screen overflow-hidden bg-background text-foreground"
    >
      <HistoryWorkspace>
        <div
          data-testid="history-live-workspace"
          className="flex h-full flex-col"
        >
          <header className="flex h-12 shrink-0 items-center justify-between border-b px-5">
            <span className="font-semibold text-sm">Catalex</span>
            <span className="text-muted-foreground text-xs">
              Learning with structure
            </span>
            <WorkspaceHistoryControl />
          </header>
          <div className="flex min-h-0 flex-1">
            <aside className="w-52 shrink-0 border-r bg-muted/20 p-4">
              <div className="mb-5 flex items-center gap-2 font-medium text-xs">
                <FolderIcon className="size-4" /> Research paper
              </div>
              {[
                ...Object.keys(CONTENTS.newest),
                "overview.svg",
                "letter.pdf",
                "report.pdf",
              ].map((path) => (
                <div
                  key={path}
                  className={`mb-1 flex items-center gap-2 rounded-md px-2 py-2 text-xs ${path === "main.tex" ? "bg-muted" : "text-muted-foreground"}`}
                >
                  <FileTextIcon className="size-3.5" /> {path}
                </div>
              ))}
            </aside>
            <main className="flex min-w-0 flex-1 flex-col">
              <div className="h-10 shrink-0 border-b px-5 py-3 text-xs">
                main.tex
              </div>
              <div
                data-testid="history-live-scroll"
                className="min-h-0 flex-1 overflow-auto p-7"
              >
                <pre className="font-mono text-[13px] text-foreground/80 leading-7">
                  {CURRENT_MAIN}
                  {Array.from(
                    { length: 60 },
                    (_, index) => `% Working notes ${index + 1}\n`,
                  ).join("")}
                </pre>
              </div>
            </main>
            <aside
              data-testid="history-live-chat"
              className="flex w-72 shrink-0 flex-col border-l bg-muted/10 p-4"
            >
              <div className="flex items-center gap-2 font-medium text-sm">
                <SparklesIcon className="size-4" /> Assistant
              </div>
              <p className="mt-5 text-muted-foreground text-xs leading-6">
                The revised introduction is ready for review. Your conversation
                stays here while you explore project history.
              </p>
              <textarea
                aria-label="Live chat draft"
                className="mt-auto h-28 resize-none rounded-xl border bg-background p-3 text-xs leading-5"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </aside>
          </div>
        </div>
      </HistoryWorkspace>
    </div>
  );
}
