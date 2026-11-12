import { collectChatMatches } from "../../chat-message-search";
import {
  remapCommentFiles,
  type CommentPathChange,
} from "@/components/workspace/editor/comment-paths";
import {
  minimapDemoName,
  minimapDemoBaseline,
  minimapDemoDiagnostics,
} from "./harnesses/minimap-demo-fixture";
import {
  handoffMessageCount,
  buildCrossProviderTranscript,
} from "../../chat-transcript";
import {
  detectTexEngineFromContent,
  resolveCompileTarget,
  type SynctexSourceMap,
} from "@/lib/latex-compiler";
const demoSynctexMaps = new Map<string, SynctexSourceMap>();
function getDemoSourceMap(projectDir: unknown) {
  const state = useDocumentStore.getState();
  const target = resolveCompileTarget(state.activeFileId, state.files);
  return (
    demoSynctexMaps.get(JSON.stringify([projectDir, target?.targetPath])) ??
    null
  );
}
import {
  applyCommentPatch,
  applyCommentPatches,
  commentPatches,
  type CommentPatch,
  type InlineCommentsByFile,
} from "@/components/workspace/editor/inline-comment-storage";
import { useDocumentStore } from "@/stores/document-store";

// Browser demos emulate the host API in memory; production persists on disk.
const chatCheckpoints = new Map<string, any>();
function chatCheckpointCommand(cmd: string, args: Record<string, any>) {
  const root = String(args.projectRoot);
  const previous = chatCheckpoints.get(root);
  if (cmd === "desktop:chat:checkpoint-load")
    return previous
      ? {
          ...previous,
          tabs: previous.tabs.map((tab: any) => ({
            ...tab,
            messages: [],
            history: { total: tab.messages.length, start: tab.messages.length },
          })),
        }
      : null;
  if (cmd === "desktop:chat:fork") {
    const source = previous?.tabs.find((tab: any) => tab.id === args.tabId);
    if (!source || source.runtimeSessionKey !== args.runtimeSessionKey)
      throw new Error("Conversation changed.");
    const tab = {
      ...structuredClone(args.tab),
      sharedSessionId: `demo-${args.tab.id}`,
      messages: structuredClone(
        source.messages.slice(0, args.messageIndex + 1),
      ),
    };
    previous.tabs.push(tab);
    return {
      ...tab,
      messages: [],
      history: { total: tab.messages.length, start: tab.messages.length },
    };
  }
  if (cmd === "desktop:chat:cancel-fork") {
    previous.tabs = previous.tabs.filter((tab: any) => tab.id !== args.tabId);
    return;
  }
  if (cmd === "desktop:chat:sync-shared") {
    const tab = previous?.tabs.find((tab: any) => tab.id === args.tabId);
    return {
      shared_session_id: tab.sharedSessionId,
      last_modified: tab.lastActivityAt,
    };
  }
  if (cmd === "desktop:chat:prepare-turn") {
    const tab = previous?.tabs.find((tab: any) => tab.id === args.tabId);
    const start = Math.max(
      0,
      Math.floor((tab.messages.length - 200) / 100) * 100,
    );
    return {
      start,
      total: tab.messages.length,
      messages: tab.messages.slice(start),
      prefixCount: handoffMessageCount(tab.messages.slice(0, start)),
      latestReview:
        [...tab.messages]
          .reverse()
          .find(
            (message: any) => message.subtype === "draft_review_decisions",
          ) ?? null,
      transcript: buildCrossProviderTranscript(
        args.retry ? tab.messages.slice(0, -1) : tab.messages,
        args.cursor,
      ),
    };
  }
  if (cmd === "desktop:chat:append-review") {
    const tab = previous?.tabs.find((tab: any) => tab.id === args.tabId);
    if (!tab || tab.runtimeSessionKey !== args.runtimeSessionKey)
      throw new Error("The conversation changed.");
    if (
      !tab.messages.some((message: any) => message.uuid === args.message.uuid)
    )
      tab.messages.push(structuredClone(args.message));
    return tab.messages.length;
  }
  if (cmd === "desktop:chat:search") {
    const messages =
      previous?.tabs.find((tab: any) => tab.id === args.tabId)?.messages ?? [];
    const results = collectChatMatches(args.query);
    const complete = messages.every((message: any, index: number) =>
      results.add(message, index),
    );
    return {
      matches: results.matches,
      total: messages.length,
      truncated: !complete,
    };
  }
  if (cmd === "desktop:chat:messages") {
    const tab = previous?.tabs.find((tab: any) => tab.id === args.tabId);
    if (!tab) throw new Error("Demo chat history was not found.");
    return tab.messages.slice(args.start, args.start + args.limit);
  }
  const snapshot = structuredClone(args.snapshot);
  snapshot.tabs = snapshot.tabs.map((tab: any) => {
    const old = previous?.tabs.find((item: any) => item.id === tab.id);
    if (tab.history) tab.messages = old?.messages ?? [];
    if (tab.checkpointPatch)
      tab.messages = [
        ...(old?.messages ?? []).slice(0, tab.checkpointPatch.start),
        ...tab.messages,
      ];
    delete tab.history;
    delete tab.checkpointPatch;
    return tab;
  });
  chatCheckpoints.set(root, snapshot);
}

export function ensureDesktopBrowserMocks() {
  if (typeof window === "undefined") return;
  const win = window as Window & {
    __CATALEX_TYPORA_THEME_FOLDER_MISSING__?: boolean;
    __TAURI_INTERNALS__?: {
      invoke?: (
        cmd: string,
        args?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>;
      transformCallback?: (
        callback: (...args: unknown[]) => void,
        once?: boolean,
      ) => number;
      unregisterCallback?: (id: number) => void;
      convertFileSrc?: (filePath: string, protocol?: string) => string;
      metadata?: {
        currentWindow?: { label: string };
        currentWebview?: { label: string };
      };
      plugins?: {
        path?: {
          sep?: string;
          delimiter?: string;
        };
      };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
    __editorDiffHarnessCompileContents?: string[];
  };

  if (!win.__TAURI_EVENT_PLUGIN_INTERNALS__) {
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: () => {},
    };
  }

  const existing = win.__TAURI_INTERNALS__ ?? {};
  let callbackId = 1;
  const callbacks = new Map<number, (...args: unknown[]) => void>();
  const eventListeners = new Map<string, Set<number>>();
  const resolvedGitConflicts = new Set<string>();
  let demoGitDirty = true;
  let threeWayGitResolution: Record<string, unknown> | null = null;

  const invokeFallback = async (
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const params = new URLSearchParams(window.location.search);
    const latexDemo =
      params.get("debug") === "comment-workspace"
        ? "comment-workspace"
        : params.has("onboarding-demo") && params.has("project")
          ? "onboarding-demo"
          : null;
    if (params.get("debug") === "comment-workspace" && params.has("ui-demo")) {
      if (cmd === "open_settings_window") {
        const url = new URL(window.location.href);
        url.search = new URLSearchParams({
          settings: "",
          "onboarding-demo": "",
          welcome: "",
          section: String(args.section ?? "rendering"),
        }).toString();
        window.open(url.href, "catalex-demo-settings");
        return null;
      }
      if (cmd === "git_panel_status")
        return {
          repo_found: true,
          branch: "main",
          upstream_branch: "origin/main",
          ahead: 0,
          behind: 0,
          staged: 0,
          unstaged: demoGitDirty ? 1 : 0,
          untracked: 0,
          conflicted: 0,
          operation: null,
          can_push: false,
        };
      if (cmd === "git_panel_changed_files")
        return demoGitDirty
          ? [
              {
                path: "sample.tex",
                staged: false,
                unstaged: true,
                untracked: false,
                conflicted: false,
              },
            ]
          : [];
      if (cmd === "git_panel_pull_status")
        return { can_pull: false, behind: 0, behind_commits: [] };
      if (cmd === "git_panel_branches")
        return [{ name: "main", is_current: true }];
      if (
        [
          "git_panel_history",
          "git_panel_graph",
          "git_panel_stash_list",
          "git_worktree_file_line_stats",
        ].includes(cmd)
      )
        return [];
      if (cmd === "git_panel_commit_selected") {
        demoGitDirty = false;
        return { success: true, message: "Demo changes committed" };
      }
    }
    if (cmd === "check_codex_status" || cmd === "check_claude_status") {
      return {
        installed: true,
        authenticated: true,
        missing_git: false,
        binary_path: "/demo/agent",
        version: "demo",
      };
    }
    if (cmd === "list_codex_models")
      return [
        {
          model: "demo",
          display_name: "Demo",
          description: "Browser harness",
          supported_reasoning_efforts: [
            { value: "medium", description: "Medium" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ];
    if (cmd === "list_claude_models")
      return [
        {
          value: "default",
          displayName: "Demo",
          description: "Browser harness",
          supportsEffort: false,
        },
      ];
    if (cmd === "clear_project_comments") {
      const key = `catalex-harness-comments:${args.projectRoot}`;
      const files: InlineCommentsByFile = JSON.parse(
        localStorage.getItem(key) ?? "{}",
      );
      for (const [path, comments] of Object.entries(files))
        files[path] = comments.filter(
          (comment) => Boolean(comment.origin) !== args.agent,
        );
      localStorage.setItem(key, JSON.stringify(files));
      localStorage.removeItem(
        `${key}:${args.agent ? "agent" : "human"}:counter`,
      );
      return null;
    }
    if (cmd === "manage_comment_files") {
      const key = `catalex-harness-comments:${args.projectRoot}`;
      const disconnectedKey = `catalex-harness-disconnected:${args.projectRoot}`;
      const files: InlineCommentsByFile = JSON.parse(
        localStorage.getItem(key) ?? "{}",
      );
      const groups: InlineCommentsByFile = JSON.parse(
        localStorage.getItem(disconnectedKey) ?? "{}",
      );
      const selection = args.selection as {
        path: string;
        disconnected: boolean;
        ids: string[];
      }[];
      if (!selection.length) throw new Error("Select at least one file.");
      if (args.action !== "clear" && args.action !== "relink")
        throw new Error("Unknown comment action.");
      for (const group of selection) {
        const source = group.disconnected ? groups : files;
        const ids = (source[group.path] ?? [])
          .map((comment) => comment.id)
          .sort();
        if (
          !ids.length ||
          JSON.stringify(ids) !== JSON.stringify([...group.ids].sort())
        )
          throw new Error(
            "Comments changed. Refresh your selection and try again.",
          );
      }
      let newPath = "";
      let unplaced = 0;
      if (args.action === "relink") {
        if (selection.length !== 1)
          throw new Error("Select exactly one file to relink.");
        newPath = String(args.target);
        if (newPath.startsWith(`${args.projectRoot}/`))
          newPath = newPath.slice(String(args.projectRoot).length + 1);
        if (
          selection.some(
            (group) => !group.disconnected && group.path === newPath,
          )
        )
          throw new Error("Choose a different file.");
        const file = useDocumentStore
          .getState()
          .files.find((file) => file.relativePath === newPath);
        if (!file)
          throw new Error("Choose an existing file inside this project.");
        if (!/\.(tex|md|markdown|txt|bib|sty|cls|ltx|rnw|rmd)$/i.test(newPath))
          throw new Error("Choose a supported text document.");
        if (files[newPath]?.length)
          throw new Error(
            "This file already has comments. Choose a file without comments.",
          );
        const sources = JSON.parse(
          localStorage.getItem(
            `catalex-harness-comment-sources:${args.projectRoot}`,
          ) ?? "{}",
        );
        const group = selection[0];
        const source = group.disconnected ? groups : files;
        files[newPath] = source[group.path].map((comment) => {
          const exact =
            comment.anchorRevision &&
            sources[comment.anchorRevision] === file.content;
          if (!exact || comment.positionReset) unplaced++;
          return exact
            ? comment
            : {
                ...comment,
                from: 0,
                to: 0,
                line: 1,
                positionReset: true,
                anchorRevision: undefined,
              };
        });
      }
      let cleared = 0;
      for (const group of selection) {
        const source = group.disconnected ? groups : files;
        const comments = source[group.path];
        if (args.action === "relink") {
          delete source[group.path];
          continue;
        }
        const remaining = comments.filter(
          (comment) =>
            args.author !== "all" &&
            Boolean(comment.origin) !== (args.author === "agent"),
        );
        cleared += comments.length - remaining.length;
        if (remaining.length) source[group.path] = remaining;
        else delete source[group.path];
      }
      if (!args.preview) {
        localStorage.setItem(key, JSON.stringify(files));
        localStorage.setItem(disconnectedKey, JSON.stringify(groups));
        for (const listener of eventListeners.get(
          "catalex-comments-reconnected",
        ) ?? [])
          callbacks.get(listener)?.({
            payload: { projectRoot: args.projectRoot },
          });
      }
      return { newPath, unplaced, cleared };
    }
    if (cmd === "remap_project_comment_paths") {
      const key = `catalex-harness-comments:${args.projectRoot}`;
      const files = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(
        key,
        JSON.stringify(
          remapCommentFiles(files, args.changes as CommentPathChange[]),
        ),
      );
      return null;
    }
    if (cmd === "read_project_comments_anchored") {
      const files = JSON.parse(
        localStorage.getItem(`catalex-harness-comments:${args.projectRoot}`) ??
          "{}",
      );
      const sources = JSON.parse(
        localStorage.getItem(
          `catalex-harness-comment-sources:${args.projectRoot}`,
        ) ?? "{}",
      );
      const documents: Record<string, string> = {};
      for (const file of useDocumentStore.getState().files) {
        if (!files[file.relativePath]) continue;
        const text = file.diskContent ?? file.content;
        if (text == null) continue;
        const digest = await crypto.subtle.digest(
          "SHA-1",
          new TextEncoder().encode(text),
        );
        const revision = Array.from(new Uint8Array(digest), (n) =>
          n.toString(16).padStart(2, "0"),
        ).join("");
        sources[revision] = text;
        documents[file.relativePath] = revision;
      }
      return {
        files,
        sources,
        documents,
        counters: ["human", "agent"].map((kind) =>
          Number(
            localStorage.getItem(
              `catalex-harness-comments:${args.projectRoot}:${kind}:counter`,
            ) ?? 0,
          ),
        ),
        ...(args.includeDisconnected
          ? {
              disconnected: JSON.parse(
                localStorage.getItem(
                  `catalex-harness-disconnected:${args.projectRoot}`,
                ) ?? "{}",
              ),
            }
          : {}),
      };
    }
    if (cmd === "update_project_comment_anchors") {
      const patches = args.patches as CommentPatch[];
      const key = `catalex-harness-comments:${args.projectRoot}`;
      const files = applyCommentPatches(
        JSON.parse(localStorage.getItem(key) ?? "{}"),
        patches,
      );
      const sourceKey = `catalex-harness-comment-sources:${args.projectRoot}`;
      const sources = JSON.parse(localStorage.getItem(sourceKey) ?? "{}");
      for (const patch of patches) {
        if (patch.after?.anchorRevision)
          sources[patch.after.anchorRevision] = args.source;
      }
      const used = new Set(
        Object.values(files)
          .flat()
          .map((comment) => comment.anchorRevision),
      );
      for (const revision of Object.keys(sources))
        if (!used.has(revision)) delete sources[revision];
      localStorage.setItem(key, JSON.stringify(files));
      localStorage.setItem(sourceKey, JSON.stringify(sources));
      if (patches.length)
        await invokeFallback("plugin:event|emit", {
          event: "catalex-comments-changed",
          payload: {
            projectRoot: args.projectRoot,
            patch: patches[0],
            patches,
          },
        });
      return { orphanedIds: [] };
    }
    if (cmd === "update_project_comment_anchored") {
      const key = `catalex-harness-comment-sources:${args.projectRoot}`;
      const sources = JSON.parse(localStorage.getItem(key) ?? "{}");
      sources[(args.patch as CommentPatch).after!.anchorRevision!] =
        args.source;
      localStorage.setItem(key, JSON.stringify(sources));
      cmd = "update_project_comment";
    }
    if (cmd === "read_project_comments") {
      return JSON.parse(
        localStorage.getItem(`catalex-harness-comments:${args.projectRoot}`) ??
          "{}",
      );
    }
    if (cmd === "update_project_comment" || cmd === "replay_project_comment") {
      const key = `catalex-harness-comments:${args.projectRoot}`;
      const files: InlineCommentsByFile = JSON.parse(
        localStorage.getItem(key) ?? "{}",
      );
      const patch = args.patch as CommentPatch;
      if (cmd === "replay_project_comment") {
        const current =
          files[patch.filePath]?.find((c) => c.id === patch.id) ?? null;
        if (current && patch.before?.number == null && patch.before)
          patch.before.number = current.number;
        if (current && patch.after?.number == null && patch.after)
          patch.after.number = current.number;
        if (current)
          for (const value of [patch.before, patch.after]) {
            if (value) value.anchorRevision = current.anchorRevision;
          }
        const rangeChange =
          patch.before &&
          patch.after &&
          (patch.before.from !== patch.after.from ||
            patch.before.to !== patch.after.to ||
            JSON.stringify(patch.before.pdf) !==
              JSON.stringify(patch.after.pdf));
        if (current && !rangeChange)
          for (const value of [patch.before, patch.after]) {
            if (value)
              Object.assign(value, {
                from: current.from,
                to: current.to,
                line: current.line,
              });
          }
        if (
          commentPatches(
            { [patch.filePath]: current ? [current] : [] },
            { [patch.filePath]: patch.before ? [patch.before] : [] },
          ).length
        )
          throw new Error("comment_conflict: changed since that action");
      }
      if (!patch.before && patch.after && patch.after.number == null) {
        const counterKey = `${key}:${patch.after.origin ? "agent" : "human"}:counter`;
        const largest = Math.max(
          0,
          ...Object.values(files)
            .flat()
            .filter((comment) => !!comment.origin === !!patch.after?.origin)
            .map((comment) => comment.number ?? 0),
        );
        const number =
          Math.max(largest, Number(localStorage.getItem(counterKey) ?? 0)) + 1;
        patch.after = { ...patch.after, number };
        localStorage.setItem(counterKey, String(number));
      }
      localStorage.setItem(
        key,
        JSON.stringify(applyCommentPatch(files, patch)),
      );
      await invokeFallback("plugin:event|emit", {
        event: "catalex-comments-changed",
        payload: {
          projectRoot: args.projectRoot,
          patch,
          historyReplay: cmd === "replay_project_comment",
        },
      });
      return patch;
    }
    const defaultTyporaThemeDirectory = "/tmp/typora-config/Typora/themes";
    if (cmd === "plugin:path|resolve_directory" && args.directory === 3) {
      return "/tmp/typora-config";
    }
    if (cmd === "plugin:fs|exists") {
      return (
        !win.__CATALEX_TYPORA_THEME_FOLDER_MISSING__ &&
        args.path === defaultTyporaThemeDirectory
      );
    }
    if (cmd === "plugin:dialog|open") {
      return "/tmp/typora-themes";
    }
    if (
      cmd === "plugin:fs|read_dir" &&
      (args.path === "/tmp/typora-themes" ||
        args.path === defaultTyporaThemeDirectory)
    ) {
      return [
        {
          name: "Academic.css",
          isFile: true,
          isDirectory: false,
          isSymlink: false,
        },
        {
          name: "academic",
          isFile: false,
          isDirectory: true,
          isSymlink: false,
        },
      ];
    }
    if (
      cmd === "plugin:fs|read_text_file" &&
      (args.path === "/tmp/typora-themes/Academic.css" ||
        args.path === `${defaultTyporaThemeDirectory}/Academic.css`)
    ) {
      return Array.from(
        new TextEncoder().encode(`
          :root { --bg-color: #f8fafc; --text-color: #172554; }
          #write h1 { color: rgb(35, 99, 235); }
          @font-face { font-family: "Academic"; src: url("./academic/font.woff2"); }
        `),
      );
    }
    if (cmd === "plugin:fs|read_text_file") {
      const file = useDocumentStore
        .getState()
        .files.find((file) => file.absolutePath === args.path);
      if (file?.content !== undefined)
        return Array.from(new TextEncoder().encode(file.content));
    }
    // Generic demos keep their files in the document store. Repository-backed
    // harnesses override this command to exercise real conditional writes.
    if (cmd === "save_file_if_unchanged")
      return { written: true, current: args.content };
    if (cmd === "git_head_file_content") {
      if (
        args.filePath === minimapDemoName &&
        new URLSearchParams(location.search).get("debug") ===
          "comment-workspace"
      ) {
        return {
          repo_found: true,
          head_content: minimapDemoBaseline,
          ignored: false,
        };
      }
      const gitHeadMode = new URLSearchParams(window.location.search).get(
        "gitHead",
      );
      if (gitHeadMode === "ignored") {
        return { repo_found: true, head_content: null, ignored: true };
      }
      if (gitHeadMode === "untracked") {
        return { repo_found: true, head_content: null, ignored: false };
      }
      return { repo_found: false, head_content: null, ignored: false };
    }
    if (cmd === "git_conflict_file_content") {
      const filePath = String(args.filePath ?? "");
      const params = new URLSearchParams(window.location.search);
      if (
        params.get("debug") === "comment-workspace" &&
        (params.has("markers") || params.has("merge")) &&
        !params.has("proposal") &&
        filePath === "sample.tex" &&
        !resolvedGitConflicts.has(filePath)
      ) {
        const current =
          useDocumentStore
            .getState()
            .files.find((file) => file.relativePath === filePath)?.content ??
          "";
        return {
          conflicted: true,
          current_content: current,
          incoming_content: current
            .replace(
              "Your abstract here. This demonstration paper explores",
              "The incoming revision examines",
            )
            .replace(
              "\\subsection{Research questions}",
              "\\subsection{Research questions}\nThe incoming branch adds a comparison across three data budgets.\n",
            )
            .replace(
              "The text beneath the pointer should remain a useful visual reference.",
              "The incoming branch removes this preview exercise.",
            ),
        };
      }
      const conflictMode = new URLSearchParams(window.location.search).get(
        "gitConflict",
      );
      if (conflictMode === null || resolvedGitConflicts.has(filePath)) {
        return {
          conflicted: false,
          current_content: null,
          incoming_content: null,
        };
      }
      if (conflictMode === "three-way") {
        const prefix =
          "% Preserved project title\n\\documentclass{article}\n\\begin{document}\n";
        const between = "Independent context stays intact.\n";
        const ending = "Incoming compatible conclusion.\n\\end{document}\n";
        return {
          conflicted: true,
          version: "git-three-way-v1",
          ancestor_content: `${prefix}Samples: 10\n${between}Method: manual\n${ending}`,
          current_content: `${prefix}Samples: 20\n${between}Method: reviewed\n${ending}`,
          incoming_content: `${prefix}Samples: 15\n${between}Method: automated\n${ending}`,
          conflict_contents: [
            { kind: "resolved", content: prefix },
            {
              kind: "conflict",
              ancestor: "Samples: 10\n",
              current: "Samples: 20\n",
              agent: "Samples: 15\n",
            },
            { kind: "resolved", content: between },
            {
              kind: "conflict",
              ancestor: "Method: manual\n",
              current: "Method: reviewed\n",
              agent: "Method: automated\n",
            },
            { kind: "resolved", content: ending },
          ],
        };
      }
      if (conflictMode === "multi") {
        return {
          conflicted: true,
          current_content: `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
First choice from current
Text between conflicts
Second choice from current
\\end{document}
`,
          incoming_content: `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
First choice from incoming
Text between conflicts
Second choice from incoming
\\end{document}
`,
        };
      }
      return {
        conflicted: true,
        current_content: `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
Making some issues
\\end{document}
`,
        incoming_content: `% Conflict harness
\\documentclass{article}
\\begin{document}
\\section{Introduction}
Making some problems
\\end{document}
`,
      };
    }
    if (cmd === "demo_git_three_way_resolution") return threeWayGitResolution;
    if (cmd === "git_panel_resolve_conflict") {
      if (
        new URLSearchParams(window.location.search).get("gitConflict") ===
        "three-way"
      ) {
        if (
          args.expectedVersion !== "git-three-way-v1" ||
          typeof args.content !== "string"
        )
          return {
            success: false,
            message: "Expected version-bound result content",
          };
        threeWayGitResolution = { ...args };
      }
      resolvedGitConflicts.add(String(args.filePath ?? ""));
      return { success: true, message: "Conflict resolved" };
    }
    if (cmd === "git_panel_reopen_conflict") {
      resolvedGitConflicts.delete(String(args.filePath ?? ""));
      return { success: true, message: "Conflict reopened" };
    }
    // The browser demo has no native SyncTeX process; use its compiled map.
    if ((cmd === "synctex_view" || cmd === "synctex_edit") && latexDemo) {
      const map = getDemoSourceMap(args.projectDir);
      if (!map) return null;
      if (cmd === "synctex_view") {
        const line = Number(args.line ?? 1);
        const boxes = map.boxes.filter((box) => box.sources.length > 0);
        const distance = (box: (typeof boxes)[number]) =>
          Math.min(
            ...box.sources.map((source) => Math.abs(source.line - line)),
          );
        const box = boxes.reduce<(typeof boxes)[number] | undefined>(
          (best, next) =>
            !best || distance(next) < distance(best) ? next : best,
          undefined,
        );
        return box ? { page: box.page, x: box.x, y: box.y } : null;
      }
      const boxes = map.boxes.filter(
        (box) => box.page === Number(args.page) && box.sources.length > 0,
      );
      const distance = (box: (typeof boxes)[number]) =>
        Math.abs(box.y - Number(args.y ?? 0));
      const box = boxes.reduce<(typeof boxes)[number] | undefined>(
        (best, next) =>
          !best || distance(next) < distance(best) ? next : best,
        undefined,
      );
      const source = box?.sources[0];
      return source
        ? { file: map.inputs[source.tag], line: source.line, column: 1 }
        : null;
    }
    if (cmd === "get_synctex_source_map" && latexDemo)
      return getDemoSourceMap(args.projectDir);
    if (cmd === "compile_latex" && latexDemo) {
      const file = useDocumentStore
        .getState()
        .files.find((file) => file.relativePath === args.mainFile);
      if (!file) throw new Error("Demo LaTeX file not found.");
      if (file.relativePath === minimapDemoName) {
        (
          args.diagnostics as { onmessage: (value: unknown[]) => void }
        )?.onmessage(minimapDemoDiagnostics);
        throw new Error(
          "Intentional demo errors: use the minimap to explore separated and grouped markers.",
        );
      }
      const response = await fetch("/__demo/compile", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Catalex-Demo": latexDemo,
        },
        body: JSON.stringify({
          source: file.content,
          engine:
            args.engine ??
            detectTexEngineFromContent(file.content ?? "") ??
            "pdflatex",
          file: file.relativePath,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      (
        args.diagnostics as
          | { onmessage: (value: unknown[]) => void }
          | undefined
      )?.onmessage([]);
      const result = await response.json();
      demoSynctexMaps.set(
        JSON.stringify([args.projectDir, args.mainFile]),
        result.sourceMap,
      );
      return Uint8Array.from(atob(result.pdf), (char) => char.charCodeAt(0))
        .buffer;
    }
    if (
      cmd === "compile_latex" &&
      new URLSearchParams(window.location.search).has("withPdf")
    ) {
      const activeFile = useDocumentStore
        .getState()
        .files.find(
          (file) => file.id === useDocumentStore.getState().activeFileId,
        );
      win.__editorDiffHarnessCompileContents ??= [];
      win.__editorDiffHarnessCompileContents.push(activeFile?.content ?? "");
      const response = await fetch("/examples/paper-standard/main.pdf");
      (
        args?.diagnostics as
          | { onmessage: (value: unknown[]) => void }
          | undefined
      )?.onmessage([]);
      return response.arrayBuffer();
    }
    if (cmd === "detect_editors" || cmd === "list_shared_sessions") {
      return [];
    }
    if (cmd === "get_claude_setup_status" || cmd === "get_codex_setup_status") {
      return { status: "ready" };
    }
    if (cmd === "plugin:event|listen") {
      const event = String(args.event ?? "");
      const handler = Number(args.handler);
      const listeners = eventListeners.get(event) ?? new Set<number>();
      listeners.add(handler);
      eventListeners.set(event, listeners);
      return handler;
    }
    if (cmd === "plugin:event|emit") {
      const event = String(args.event ?? "");
      for (const handler of eventListeners.get(event) ?? []) {
        callbacks.get(handler)?.({
          event,
          id: handler,
          payload: args.payload,
        });
      }
      return null;
    }
    if (cmd === "plugin:event|unlisten") {
      const event = String(args.event ?? "");
      eventListeners.get(event)?.delete(Number(args.eventId));
      return null;
    }
    if (cmd === "plugin:webview|listen" || cmd === "plugin:window|listen") {
      return Number(args.handler) || 1;
    }
    if (cmd === "plugin:webview|unlisten" || cmd === "plugin:window|unlisten") {
      return null;
    }
    if (cmd.startsWith("list_")) return [];
    if (cmd.startsWith("get_")) return {};
    return null;
  };

  win.__TAURI_INTERNALS__ = {
    ...existing,
    metadata: existing.metadata ?? {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback:
      existing.transformCallback ??
      ((callback, once = false) => {
        const id = callbackId++;
        callbacks.set(id, (...args: unknown[]) => {
          callback(...args);
          if (once) callbacks.delete(id);
        });
        return id;
      }),
    unregisterCallback:
      existing.unregisterCallback ??
      ((id) => {
        callbacks.delete(id);
      }),
    invoke: async (cmd, args = {}, options) => {
      if (
        [
          "desktop:chat:checkpoint-load",
          "desktop:chat:checkpoint-save",
          "desktop:chat:messages",
          "desktop:chat:search",
          "desktop:chat:append-review",
          "desktop:chat:fork",
          "desktop:chat:cancel-fork",
          "desktop:chat:prepare-turn",
          "desktop:chat:sync-shared",
        ].includes(cmd)
      )
        return chatCheckpointCommand(cmd, args);
      return (existing.invoke ?? invokeFallback)(cmd, args, options);
    },
    convertFileSrc: existing.convertFileSrc ?? ((filePath) => filePath),
    plugins: {
      path: {
        sep: existing.plugins?.path?.sep ?? "/",
        delimiter: existing.plugins?.path?.delimiter ?? ":",
      },
    },
  };
}
