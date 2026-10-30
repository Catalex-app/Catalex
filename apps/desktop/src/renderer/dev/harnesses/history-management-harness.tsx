import { WorkspaceHistoryControl } from "@/components/workspace/workspace-history-control";
import { useEffect } from "react";
import { HistoryPanel } from "@/components/workspace/history-panel";
import { useDocumentStore } from "@/stores/document-store";
import {
  useHistoryStore,
  type HistoryStorageInfo,
  type SnapshotInfo,
} from "@/stores/history-store";
import { ensureDesktopBrowserMocks } from "../desktop-browser-mocks";

const PROJECT_ROOT = "/tmp/catalex-history-management-harness";

interface HistoryHarnessWindow {
  __historyManagementHarnessInstalled?: boolean;
  __TAURI_INTERNALS__?: {
    invoke?: (
      command: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
}

function installHistoryManagementMocks() {
  ensureDesktopBrowserMocks();
  const harnessWindow = window as unknown as HistoryHarnessWindow;
  if (harnessWindow.__historyManagementHarnessInstalled) return;
  harnessWindow.__historyManagementHarnessInstalled = true;

  const internals = harnessWindow.__TAURI_INTERNALS__;
  if (!internals?.invoke) return;
  const fallbackInvoke = internals.invoke.bind(internals);
  const now = Math.floor(Date.now() / 1000);
  let snapshots: SnapshotInfo[] = [
    {
      id: "submission-snapshot",
      message: "[manual] Submission draft",
      timestamp: now - 90,
      labels: ["Submission"],
      changed_files: ["main.tex", "references.bib"],
    },
    {
      id: "agent-snapshot",
      message: "[claude] After Claude edit",
      timestamp: now - 3600,
      labels: ["Reviewed"],
      changed_files: ["sections/results.tex"],
    },
    {
      id: "initial-snapshot",
      message: "[init] Project opened",
      timestamp: now - 86400,
      labels: [],
      changed_files: [],
    },
  ];
  let storageInfo: HistoryStorageInfo = {
    usageBytes: 42 * 1024 * 1024,
    limitBytes: 250 * 1024 * 1024,
    snapshotCount: 14,
    protectedSnapshotCount: 2,
  };

  internals.invoke = async (command, args = {}) => {
    if (command === "history_init") return null;
    if (command === "history_list") return snapshots;
    if (command === "history_storage_info") return storageInfo;
    if (command === "history_set_storage_limit") {
      storageInfo = {
        ...storageInfo,
        limitBytes: Number(args.limitBytes),
      };
      return storageInfo;
    }
    if (command === "history_clear") {
      if (new URLSearchParams(window.location.search).has("clearFailure")) {
        throw new Error("Automatic history is currently in use");
      }
      snapshots = [
        {
          id: "fresh-initial-snapshot",
          message: "[init] Project opened",
          timestamp: Math.floor(Date.now() / 1000),
          labels: [],
          changed_files: [],
        },
      ];
      storageInfo = {
        ...storageInfo,
        usageBytes: 12 * 1024,
        snapshotCount: 1,
        protectedSnapshotCount: 0,
      };
      return storageInfo;
    }
    return fallbackInvoke(command, args);
  };
}

export function HistoryManagementHarness() {
  installHistoryManagementMocks();

  useEffect(() => {
    useHistoryStore.getState().reset();
    useDocumentStore.setState((state) => ({
      ...state,
      projectRoot: PROJECT_ROOT,
      initialized: true,
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: `${PROJECT_ROOT}/main.tex`,
          type: "tex",
          content:
            "\\documentclass{article}\n\\begin{document}\nDraft\n\\end{document}\n",
          isDirty: false,
        },
      ],
      folders: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex"],
    }));
  }, []);

  return (
    <div
      data-testid="history-management-harness-shell"
      className="flex h-screen items-center justify-center bg-muted/40 p-8 text-foreground"
    >
      {new URLSearchParams(window.location.search).has("popup") ? (
        <div className="absolute top-6 right-6">
          <WorkspaceHistoryControl />
        </div>
      ) : (
        <div className="h-[620px] w-[390px] overflow-hidden rounded-xl border bg-background shadow-lg">
          <HistoryPanel />
        </div>
      )}
    </div>
  );
}
