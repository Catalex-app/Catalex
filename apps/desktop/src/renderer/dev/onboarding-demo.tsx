import { useSettingsStore } from "@/stores/settings-store";
import { useState } from "react";
import { App } from "@/App";
import { browserHarness } from "@/lib/desktop/bridge";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { usePiSetupStore } from "@/stores/pi-setup-store";
import {
  type AgentStreamMessage,
  useAgentChatStore,
} from "@/stores/agent-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import type { SnapshotInfo } from "@/stores/history-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { ensureDesktopBrowserMocks } from "./desktop-browser-mocks";
import demoPaper from "./fixtures/pdf-animation/demo-paper.tex?raw";
import landscapeNotes from "./fixtures/pdf-animation/landscape-notes.tex?raw";
import shortLetter from "./fixtures/pdf-animation/short-letter.tex?raw";

const DEMO_CONTENT =
  "# Welcome to your workspace\n\nWrite **Markdown** here and watch the preview update.\n\n## Your next idea\n\nTry switching between Artisan and Duet.\n";
const DEMO_DOCUMENTS: Record<string, string> = {
  "welcome.md": DEMO_CONTENT,
  "demo-paper.tex": demoPaper,
  "landscape-notes.tex": landscapeNotes,
  "short-letter.tex": shortLetter,
};

const queueDemoSessions = new Set<string>();

function startPromptQueueDemo() {
  const chat = useAgentChatStore.getState();
  const tabId = chat.createTab();
  const tab = useAgentChatStore
    .getState()
    .tabs.find((item) => item.id === tabId)!;
  queueDemoSessions.add(tab.runtimeSessionKey);
  useAgentChatStore.setState((state) => ({
    tabs: state.tabs.map((item) =>
      item.id === tabId ? { ...item, title: "Prompt queue demo" } : item,
    ),
  }));
  chat._appendMessage(tabId, {
    type: "user",
    uuid: crypto.randomUUID(),
    message: { content: [{ type: "text", text: "Polish the introduction." }] },
  });
  chat._setStreaming(tabId, true);
  chat.enqueuePrompt(tabId, "Summarize the main findings.", []);
  chat.enqueuePrompt(tabId, "Check the limitations section.", []);
  chat.requestDrawerOpen();
  return { tabId, runtimeSessionKey: tab.runtimeSessionKey };
}

function seedDemoChats() {
  const chat = useAgentChatStore.getState();
  chat.restoreProjectTabs("/browser-demo/My first project");
  const base = useAgentChatStore.getState().tabs[0];
  const conversations = [
    {
      title: "Polish the introduction",
      turns: [
        "Can you help make my introduction clearer? Keep the tone academic, but make it easier to read.",
        "The main idea is strong. I would bring the research question forward and shorten the background.\n\n### Suggested structure\n\n1. **Context:** what problem are we studying?\n2. **Gap:** what do existing approaches miss?\n3. **Contribution:** what does this paper add?\n\nThis gives the reader a clear reason to keep reading before introducing the technical details.",
        "That sounds good. Show me an example of the opening paragraph.",
        "Here is a possible opening:\n\n> Writing tools increasingly combine document editing with AI assistance. Yet moving between a draft and a separate conversation can interrupt the writing process. We explore how an assistant embedded in the writing workspace can support revision while keeping the author in control.\n\nI kept the motivation concrete and left the evaluation claims for the next paragraph. You could follow this with your study design and the main finding.\n\nWould you like a more concise version, or one that emphasizes the research gap?",
      ],
    },
    {
      title: "Outline the evaluation",
      turns: [
        "Suggest an evaluation plan for the writing assistant. We want to compare a drawer with a full workspace.",
        "Use a within-participant study so each person tries both layouts. Counterbalance the order to reduce learning effects.\n\n| Task | What to observe |\n| --- | --- |\n| Revise a paragraph | Time, accepted edits, and revision quality |\n| Ask a follow-up question | How easily people recover conversation context |\n| Compare two drafts | Switching frequency and perceived effort |\n\nAfter each task, ask participants to rate focus, control, and ease of navigation. A short interview can explain why they preferred one layout.\n\n### Next steps\n\n- Prepare two passages with similar length and difficulty.\n- Define the same success criteria for both layouts.\n- Pilot the tasks before recruiting the full study.",
      ],
    },
    {
      title: "Check terminology",
      paused: true,
      turns: [
        "Check whether the draft uses consistent names for the two chat layouts.",
        "I have checked the introduction and design section so far.\n\n- Use **drawer** for the compact chat attached to the editor.\n- Use **workspace** for the expanded chat layout.\n- Use **Duet** for the overall assistant mode.\n\nThe methods section still needs a pass. I paused here so you can review the naming before I continue.",
      ],
    },
  ];
  const tabs = conversations.map((conversation, index) => ({
    ...base,
    id: `demo-chat-${index}`,
    runtimeSessionKey: `demo-runtime-${index}`,
    sharedSessionId: `demo-session-${index}`,
    title: conversation.title,
    provider: "codex" as const,
    pauseState: conversation.paused ? ("paused" as const) : null,
    lastActivityAt: Date.now() / 1000 - index * 300,
    messages: conversation.turns.map(
      (text, turn): AgentStreamMessage => ({
        type: turn % 2 === 0 ? "user" : "assistant",
        uuid: `demo-message-${index}-${turn}`,
        message: { content: [{ type: "text", text }] },
      }),
    ),
  }));
  useAgentChatStore.setState({ tabs, drawerOpenRequested: true });
  useAgentChatStore.getState().setActiveTab(tabs[0].id);
  if (new URLSearchParams(location.search).has("codex-error")) {
    const chat = useAgentChatStore.getState();
    chat._setError(
      tabs[0].id,
      "Connection to the model service failed.\nThe connection was interrupted and the retry limit was reached.",
    );
    chat._setStreaming(tabs[0].id, false, true);
  }
}

function openDemoProject() {
  queueDemoSessions.clear();
  // Previous demo versions may have persisted a review for a mock draft folder.
  // These sample conversations always start without pending document edits.
  useAgentReviewQueueStore.setState((state) => ({
    entries: state.entries.filter(
      (entry) => entry.session.projectRoot !== "/browser-demo/My first project",
    ),
  }));
  useProposedChangesStore
    .getState()
    .clearWorkspaceReview("/browser-demo/My first project");
  useOnboardingStore.setState({ completed: true });
  useSettingsStore
    .getState()
    .setWorkspacePreferences("/browser-demo/My first project", {
      mode: "duet",
      chatLayout: "drawer",
    });
  useDocumentStore.setState({
    projectRoot: "/browser-demo/My first project",
    agentWorkspaceRoot: null,
    agentWorkspaceSessionId: null,
    sourceViewSnapshot: null,
    isAgentWorkspaceReadOnly: false,
    isApplyingAgentDraft: false,
    files: Object.entries(DEMO_DOCUMENTS).map(([name, content]) => ({
      id: name,
      name,
      relativePath: name,
      absolutePath: `/browser-demo/My first project/${name}`,
      type: name.endsWith(".tex") ? ("tex" as const) : ("other" as const),
      content,
      isDirty: false,
    })),
    folders: [],
    activeFileId: "welcome.md",
    openFileIds: ["welcome.md"],
    initialized: true,
  });
  seedDemoChats();
}

function setDemoProviders(value: string) {
  // Select the affected provider before disabling it to preview its chat state.
  useSettingsStore.setState({
    enabledProviders: { claude: true, codex: true, pi: false },
  });
  useAgentChatStore
    .getState()
    .setProvider(value === "claude" ? "claude" : "codex");
  useSettingsStore.setState({
    enabledProviders: {
      claude: value !== "claude" && value !== "both",
      codex: value !== "codex" && value !== "both",
      pi: false,
    },
  });
}

function previewAgentState(value: string) {
  const provider =
    new URLSearchParams(location.search).get("provider") === "claude"
      ? "claude"
      : "codex";
  const chat = useAgentChatStore.getState();
  const tabId = chat.activeTabId;
  chat.setProvider(provider);
  useAgentChatStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === tabId
        ? {
            ...tab,
            pauseState: null,
            error: null,
            isSettling: false,
            cancelledByUser: false,
            turnPhase: "running",
            isStreaming: true,
            providerStatus: null,
          }
        : tab,
    ),
  }));
  chat._setError(tabId, null);
  chat._setStreaming(tabId, true);
  chat._setProviderStatus(tabId, provider, value === "working" ? null : value);
  chat.requestDrawerOpen();
}

const demoParams = new URLSearchParams(window.location.search);
const requestedScenario = demoParams.get("scenario") ?? "ready";
let scenario = [
  "ready",
  "missing",
  "missing-latex",
  "missing-claude",
  "missing-codex",
  "missing-pi",
  "missing-providers",
  "signed-out",
  "error",
].includes(requestedScenario)
  ? requestedScenario
  : "ready";
export function initializeOnboardingDemo() {
  ensureDesktopBrowserMocks();
  // Keep the normal composer UI, but accept prompts locally in this demo.
  // No provider process, workspace edits, or real model requests are started.
  useAgentChatStore.setState({
    sendPrompt: async (prompt, context, retry, onAccepted, targetTabId) => {
      const chat = useAgentChatStore.getState();
      const tabId = targetTabId ?? chat.activeTabId;
      const tab = chat.tabs.find((item) => item.id === tabId);
      if (!tab || !prompt.trim()) return;
      if (
        !targetTabId &&
        !retry &&
        (tab.isStreaming || tab.queuedPrompts?.length)
      ) {
        if (chat.enqueuePrompt(tabId, prompt, context)) onAccepted?.();
        void chat._runNextQueuedPrompt(tabId);
        return;
      }
      const queuedDemo = queueDemoSessions.has(tab.runtimeSessionKey);
      if (queuedDemo) chat._setStreaming(tabId, true);
      useAgentChatStore.setState((state) => ({
        tabs: state.tabs.map((item) =>
          item.id === tabId
            ? {
                ...item,
                title: item.messages.length ? item.title : prompt.slice(0, 40),
                sharedSessionId:
                  item.sharedSessionId ?? `demo-session-${tabId}`,
                pauseState: null,
                lastActivityAt: Date.now() / 1000,
              }
            : item,
        ),
      }));
      chat._appendMessage(tabId, {
        type: "user",
        uuid: crypto.randomUUID(),
        message: { content: [{ type: "text", text: prompt }] },
      });
      onAccepted?.();
      const finish = () => {
        const current = useAgentChatStore.getState();
        const currentTab = current.tabs.find((item) => item.id === tabId);
        if (
          currentTab?.runtimeSessionKey !== tab.runtimeSessionKey ||
          current.chatProjectRoot !== chat.chatProjectRoot ||
          (queuedDemo && !currentTab.isStreaming)
        )
          return;
        current._appendMessage(tabId, {
          type: "assistant",
          uuid: crypto.randomUUID(),
          message: {
            content: [
              {
                type: "text",
                text: "**Demo reply**\n\nYour message was received. You can keep typing, start a new chat, or switch between Mini, Half, and Full to try the conversation layouts.\n\nThis is a simulated response; no AI service was called and no files were changed.",
              },
            ],
          },
        });
        if (queuedDemo) {
          current._setStreaming(tabId, false);
          void current._runNextQueuedPrompt(tabId);
        }
      };
      if (queuedDemo) window.setTimeout(finish, 5000);
      else finish();
    },
  });
  if (demoParams.has("welcome")) {
    useOnboardingStore.setState({ completed: true });
  }
  if (scenario === "missing-latex" && !demoParams.has("welcome")) {
    useOnboardingStore.setState({ completed: false, step: 2 });
    useSettingsStore.setState({
      compilerBackend: "latexmk",
      latexInstallation: null,
    });
  }
  const harness = browserHarness();
  if (!harness) return;
  const original = harness.invoke;
  const checkpoints: {
    snapshot: SnapshotInfo;
    files: Record<string, string>;
  }[] = [];
  harness.invoke = async (command, args, options) => {
    const historyArgs = args as
      | {
          projectRoot?: string;
          snapshotId?: string;
          filePath?: string;
          fromId?: string;
          toId?: string;
          label?: string;
          message?: string;
          limit?: number;
          offset?: number;
        }
      | undefined;
    if (
      historyArgs?.projectRoot === "/browser-demo/My first project" &&
      command.startsWith("history_")
    ) {
      const files = () =>
        Object.fromEntries(
          useDocumentStore
            .getState()
            .files.filter((file) => file.content !== undefined)
            .map((file) => [
              file.relativePath,
              file.diskContent ?? file.content!,
            ]),
        );
      const snapshot = checkpoints.find(
        (item) => item.snapshot.id === historyArgs.snapshotId,
      );
      if (command === "history_init" || command === "history_snapshot") {
        const current = files();
        if (
          !checkpoints.length ||
          (command === "history_snapshot" &&
            JSON.stringify(current) !== JSON.stringify(checkpoints[0].files))
        ) {
          const item = {
            snapshot: {
              id: crypto.randomUUID(),
              message: historyArgs.message ?? "[init] Project opened",
              timestamp: Math.floor(Date.now() / 1000),
              labels: [],
              changed_files: Object.keys(current),
            } satisfies SnapshotInfo,
            files: current,
          };
          checkpoints.unshift(item);
          return command === "history_snapshot" ? item.snapshot : null;
        }
        return null;
      }
      if (command === "history_list")
        return checkpoints
          .slice(
            historyArgs.offset ?? 0,
            (historyArgs.offset ?? 0) + (historyArgs.limit ?? 50),
          )
          .map((item) => item.snapshot);
      if (command === "history_label_counts") {
        const counts: Record<string, number> = {};
        for (const item of checkpoints)
          for (const label of item.snapshot.labels)
            counts[label] = (counts[label] ?? 0) + 1;
        return counts;
      }
      if (
        command === "history_add_label" ||
        command === "history_remove_label"
      ) {
        if (!snapshot) throw new Error("Checkpoint not found");
        const label = historyArgs.label?.trim() ?? "";
        snapshot.snapshot.labels =
          command === "history_add_label"
            ? [...new Set([...snapshot.snapshot.labels, label])]
            : snapshot.snapshot.labels.filter((item) => item !== label);
        return null;
      }
      if (command === "history_snapshot_files")
        return Object.keys(snapshot?.files ?? {});
      if (command === "history_file_at")
        return snapshot?.files[historyArgs.filePath ?? ""] ?? "";
      if (command === "history_diff") {
        const before =
          checkpoints.find((item) => item.snapshot.id === historyArgs.fromId)
            ?.files ?? {};
        const after =
          checkpoints.find((item) => item.snapshot.id === historyArgs.toId)
            ?.files ?? {};
        return [...new Set([...Object.keys(before), ...Object.keys(after)])]
          .filter((path) => before[path] !== after[path])
          .map((path) => ({
            file_path: path,
            status:
              before[path] === undefined
                ? "added"
                : after[path] === undefined
                  ? "deleted"
                  : "modified",
            old_content: before[path] ?? null,
            new_content: after[path] ?? null,
          }));
      }
    }
    if (
      command === "list_shared_sessions" &&
      useDocumentStore.getState().projectRoot ===
        "/browser-demo/My first project"
    ) {
      return useAgentChatStore
        .getState()
        .tabs.filter((tab) => tab.sharedSessionId)
        .map((tab) => ({
          shared_session_id: tab.sharedSessionId,
          title: tab.title,
          last_modified: tab.lastActivityAt,
          archived: !!tab.archived,
          last_provider: tab.provider,
        }));
    }
    const demoPath = (args as { path?: string })?.path;
    if (
      command === "plugin:fs|exists" &&
      demoPath?.startsWith("/browser-demo/My first project")
    )
      return true;
    if (
      command === "plugin:fs|read_text_file" &&
      demoPath?.startsWith("/browser-demo/My first project/")
    ) {
      const name = demoPath.slice("/browser-demo/My first project/".length);
      if (Object.prototype.hasOwnProperty.call(DEMO_DOCUMENTS, name))
        return (
          useDocumentStore
            .getState()
            .files.find((file) => file.absolutePath === demoPath)?.content ??
          DEMO_DOCUMENTS[name]
        );
    }
    if (
      command === "plugin:fs|read_dir" &&
      (args as { path?: string })?.path === "/browser-demo/My first project"
    ) {
      return Object.keys(DEMO_DOCUMENTS).map((name) => ({
        name,
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      }));
    }
    if (command === "open_settings_window") {
      const options = args as
        | { section?: string; provider?: string }
        | undefined;
      const url = new URL(window.location.href);
      url.search = new URLSearchParams({
        settings: "",
        "onboarding-demo": "",
        section: options?.section ?? "agent",
        provider: options?.provider ?? "codex",
      }).toString();
      window.open(url.href, "catalex-demo-settings");
      return null;
    }
    if (command === "detect_texlive") {
      const latexReady = scenario !== "missing" && scenario !== "missing-latex";
      if (scenario === "error") throw new Error("Demo dependency check failed");
      return {
        installations: latexReady
          ? [
              {
                id: "/Library/TeX/texbin",
                name: "MacTeX",
                version: "pdfTeX 3.141592653 (TeX Live 2025)",
                available: true,
                engines: ["pdflatex", "xelatex", "lualatex"],
                binaryPaths: Object.fromEntries(
                  ["latexmk", "pdflatex", "xelatex", "lualatex"].map((name) => [
                    name,
                    `/Library/TeX/texbin/${name}`,
                  ]),
                ),
              },
              {
                id: "/demo/miktex/bin",
                name: "MiKTeX",
                version: "MiKTeX demo",
                available: true,
                engines: ["pdflatex", "xelatex"],
                binaryPaths: Object.fromEntries(
                  ["latexmk", "pdflatex", "xelatex"].map((name) => [
                    name,
                    `/demo/miktex/bin/${name}`,
                  ]),
                ),
              },
            ]
          : [],
        available: latexReady,
        latexmkAvailable: latexReady,
        engines: latexReady ? ["pdflatex", "xelatex", "lualatex"] : [],
        version: latexReady ? "pdfTeX 3.141592653 (TeX Live 2025)" : null,
        binaryPaths: latexReady
          ? Object.fromEntries(
              ["latexmk", "pdflatex", "xelatex", "lualatex"].map((name) => [
                name,
                `/Library/TeX/texbin/${name}`,
              ]),
            )
          : {},
      };
    }
    if (
      ["check_claude_status", "check_codex_status", "check_pi_status"].includes(
        command,
      )
    ) {
      if (scenario === "error") throw new Error("Demo provider check failed");
      const missing =
        scenario === "missing" ||
        scenario === "missing-providers" ||
        (scenario === "missing-claude" && command === "check_claude_status") ||
        (scenario === "missing-codex" && command === "check_codex_status") ||
        (scenario === "missing-pi" && command === "check_pi_status");
      if (command === "check_pi_status") {
        const config = (
          args as
            | { piConfig?: { binaryPath?: string; configDirectory?: string } }
            | undefined
        )?.piConfig;
        return {
          installed: !missing,
          version: missing ? null : "1.2.0",
          binary_path: config?.binaryPath || "/demo/bin/pi",
          config_directory: config?.configDirectory || "/demo/.pi/agent",
        };
      }
      return {
        installed: !missing,
        authenticated: !missing && scenario !== "signed-out",
        version: "Demo",
        account_email: "writer@example.com",
        account_label: "Demo account",
        missing_git: false,
      };
    }
    if (command === "list_pi_models")
      return [
        {
          id: "demo-model",
          provider: "demo",
          name: "Demo model",
          reasoning: false,
        },
      ];
    if (command === "list_claude_models")
      return [
        {
          value: "default",
          displayName: "Provider default",
          description: "Demo model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Demo model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];
    if (command === "list_codex_models")
      return [
        {
          model: "gpt-5.4",
          display_name: "GPT-5.4",
          description: "Demo model",
          supported_reasoning_efforts: [
            { value: "medium", description: "Medium" },
          ],
          default_reasoning_effort: "medium",
          is_default: true,
        },
      ];
    if (["install_claude_cli", "login_claude", "login_codex"].includes(command))
      throw new Error(
        "Browser demo: choose Ready in the demo controls to simulate successful setup.",
      );
    if (command === "plugin:shell|open") return null;
    return original(command, args, options);
  };
  if (demoParams.has("project")) {
    openDemoProject();
    setDemoProviders(demoParams.get("disabled") ?? "none");
    if (demoParams.has("agent-state"))
      previewAgentState(demoParams.get("agent-state") ?? "working");
  }
}

export function OnboardingDemo({ onReady }: { onReady: () => void }) {
  const [agentState, setAgentState] = useState(
    demoParams.get("agent-state") ?? "working",
  );
  const [selected, setSelected] = useState(scenario);
  const [heldQueueTurn, setHeldQueueTurn] = useState<ReturnType<
    typeof startPromptQueueDemo
  > | null>(null);
  const projectRoot = useDocumentStore((state) => state.projectRoot);
  const holdingQueueTurn = useAgentChatStore((state) =>
    state.tabs.some(
      (tab) =>
        tab.id === heldQueueTurn?.tabId &&
        tab.runtimeSessionKey === heldQueueTurn.runtimeSessionKey &&
        tab.isStreaming,
    ),
  );
  const completed = useOnboardingStore((s) => s.completed);
  const enabled = useSettingsStore((s) => s.enabledProviders);
  const selectedProvider = useAgentChatStore((s) => s.selectedProvider);
  const disabled =
    !enabled.claude && !enabled.codex
      ? "both"
      : !enabled.claude
        ? "claude"
        : !enabled.codex
          ? "codex"
          : "none";
  return (
    <>
      <App onReady={onReady} />
      <aside
        className="fixed right-3 bottom-1 z-50 flex items-center gap-2 rounded-md border bg-background/95 px-2 py-1 text-[10px] text-foreground shadow-sm"
        aria-label="Browser demo controls"
      >
        <span>Browser demo · simulated services</span>
        {demoParams.has("agent-state") && (
          <select
            aria-label="Agent status preview"
            value={agentState}
            onChange={(event) => {
              setAgentState(event.target.value);
              previewAgentState(event.target.value);
            }}
          >
            <option value="working">Working</option>
            <option value="compacting">Compacting</option>
            <option value="retrying">Retrying</option>
            {demoParams.get("provider") === "claude" && (
              <option value="requesting">Requesting</option>
            )}
          </select>
        )}
        <select
          aria-label="Disabled providers"
          value={disabled}
          onChange={(event) => setDemoProviders(event.target.value)}
        >
          <option value="none">Both enabled</option>
          <option value="codex">Codex disabled</option>
          <option value="claude">Claude disabled</option>
          <option value="both">Both disabled</option>
        </select>
        <a
          className="underline"
          href="/?settings&onboarding-demo&section=agent"
          target="catalex-demo-settings"
        >
          Agent Settings
        </a>
        <select
          aria-label="Dependency scenario"
          value={selected}
          onChange={(event) => {
            scenario = event.target.value;
            setSelected(scenario);
            const refresh = document.querySelector<HTMLButtonElement>(
              '[data-testid="welcome-sidebar-panel"] button[aria-label="Check again"]',
            );
            if (refresh) refresh.click();
            else {
              void useClaudeSetupStore.getState().checkStatus();
              void useCodexSetupStore.getState().checkStatus();
              void usePiSetupStore.getState().checkStatus();
            }
          }}
        >
          <option value="ready">Ready</option>
          <option value="missing">All unavailable</option>
          <option value="missing-latex">MacTeX unavailable</option>
          <option value="missing-claude">Claude Code unavailable</option>
          <option value="missing-codex">Codex unavailable</option>
          <option value="missing-pi">Pi unavailable</option>
          <option value="missing-providers">All AI agents unavailable</option>
          <option value="signed-out">Signed out</option>
          <option value="error">Check failed</option>
        </select>
        <button
          type="button"
          className="underline"
          onClick={() =>
            useOnboardingStore.setState({ completed: false, step: 0 })
          }
        >
          Restart onboarding
        </button>
        {projectRoot === "/browser-demo/My first project" && (
          <button
            type="button"
            className="underline disabled:opacity-50"
            disabled={!enabled[selectedProvider]}
            onClick={() => {
              if (holdingQueueTurn && heldQueueTurn) {
                const chat = useAgentChatStore.getState();
                chat._appendMessage(heldQueueTurn.tabId, {
                  type: "assistant",
                  uuid: crypto.randomUUID(),
                  message: {
                    content: [
                      {
                        type: "text",
                        text: "Demo task finished. Processing the queued follow-ups.",
                      },
                    ],
                  },
                });
                chat._setStreaming(heldQueueTurn.tabId, false);
                void chat._runNextQueuedPrompt(heldQueueTurn.tabId);
                setHeldQueueTurn(null);
              } else {
                setHeldQueueTurn(startPromptQueueDemo());
              }
            }}
          >
            {holdingQueueTurn ? "Finish demo turn" : "Start prompt queue"}
          </button>
        )}
        {completed && (
          <button
            type="button"
            className="underline"
            onClick={() => {
              openDemoProject();
            }}
          >
            Open sample project
          </button>
        )}
      </aside>
    </>
  );
}
