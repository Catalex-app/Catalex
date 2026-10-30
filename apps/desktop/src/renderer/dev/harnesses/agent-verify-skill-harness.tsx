import { useEffect } from "react";
import { AgentChatDrawer } from "@/components/agent-chat/agent-chat-drawer";
import { ChatComposer } from "@/components/agent-chat/chat-composer";
import { ChatMessages } from "@/components/agent-chat/chat-messages";
import type { SlashCommand } from "@/components/agent-chat/slash-command-picker";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useAgentQuestionStore } from "@/stores/agent-question-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore } from "@/stores/document-store";

type ScenarioId =
  | "success"
  | "compile-repair"
  | "retry-exhausted"
  | "visual-repair";

type TraceStatus = "success" | "warning" | "error" | "info";

interface TraceStep {
  label: string;
  detail: string;
  status: TraceStatus;
  tool?: "mcp__catalex__compile" | "mcp__catalex__render_page";
}

interface Scenario {
  title: string;
  summary: string;
  verification: "complete" | "failed";
  steps: TraceStep[];
}

const SCENARIOS: Record<ScenarioId, Scenario> = {
  success: {
    title: "Successful verification",
    summary:
      "Compiled in 1/3 attempts; pages 1 and 3 inspected; no issues remain.",
    verification: "complete",
    steps: [
      {
        label: "Edit source",
        detail: "Applied a targeted change to sections/results.tex.",
        status: "info",
      },
      {
        label: "LaTeX verification attempt 1/3",
        detail: "Compilation succeeded with no actionable diagnostics.",
        status: "success",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Render representative pages",
        detail: "Rendered pages 1 and 3 from the current compiled PDF.",
        status: "success",
        tool: "mcp__catalex__render_page",
      },
      {
        label: "Inspect output",
        detail:
          "No clipping, overlap, missing content, or broken references found.",
        status: "success",
      },
    ],
  },
  "compile-repair": {
    title: "Compile failure repaired",
    summary:
      "Repaired one diagnostic; compiled in 2/3 attempts; page 2 inspected.",
    verification: "complete",
    steps: [
      {
        label: "LaTeX verification attempt 1/3",
        detail: "Compilation failed: undefined control sequence on line 48.",
        status: "error",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Diagnose and repair",
        detail: "Corrected the misspelled command supported by the diagnostic.",
        status: "warning",
      },
      {
        label: "LaTeX verification attempt 2/3",
        detail: "Compilation succeeded after the targeted repair.",
        status: "success",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Render and inspect",
        detail:
          "Rendered page 2 and confirmed the repaired equation is visible.",
        status: "success",
        tool: "mcp__catalex__render_page",
      },
    ],
  },
  "retry-exhausted": {
    title: "Retry budget exhausted",
    summary:
      "Compilation failed after 3/3 attempts; unresolved diagnostics reported.",
    verification: "failed",
    steps: [
      {
        label: "LaTeX verification attempt 1/3",
        detail: "Compilation failed with an actionable brace mismatch.",
        status: "error",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Repair cycle 1",
        detail: "Applied the smallest diagnostic-supported source repair.",
        status: "warning",
      },
      {
        label: "LaTeX verification attempt 2/3",
        detail: "Compilation still failed in the same edited section.",
        status: "error",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Repair cycle 2",
        detail: "Applied the final bounded repair attempt.",
        status: "warning",
      },
      {
        label: "LaTeX verification attempt 3/3",
        detail: "Compilation failed; stopped without rendering a stale PDF.",
        status: "error",
        tool: "mcp__catalex__compile",
      },
    ],
  },
  "visual-repair": {
    title: "Visual problem repaired",
    summary:
      "Recompiled in 2/3 attempts; page 4 re-rendered; clipping resolved.",
    verification: "complete",
    steps: [
      {
        label: "LaTeX verification attempt 1/3",
        detail: "Compilation succeeded.",
        status: "success",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Render and inspect page 4",
        detail: "The table's final column was visibly clipped.",
        status: "error",
        tool: "mcp__catalex__render_page",
      },
      {
        label: "Repair visual issue",
        detail: "Adjusted the table source without touching editor UI state.",
        status: "warning",
      },
      {
        label: "LaTeX verification attempt 2/3",
        detail: "Compilation succeeded after the visual repair.",
        status: "success",
        tool: "mcp__catalex__compile",
      },
      {
        label: "Re-render and inspect page 4",
        detail: "The table now fits and no new visual problems are visible.",
        status: "success",
        tool: "mcp__catalex__render_page",
      },
    ],
  },
};

const BUILT_IN_SKILL: SlashCommand = {
  id: "skill-catalex-verify-latex",
  name: "catalex-verify-latex",
  full_command: "/catalex-verify-latex",
  scope: "skill",
  namespace: null,
  file_path: "catalex://built-in-skills/catalex-verify-latex/SKILL.md",
  content: "# Verify LaTeX in Catalex",
  description: "Compile, repair, and visually inspect LaTeX changes.",
  allowed_tools: [],
  has_bash_commands: false,
  has_file_references: false,
  accepts_arguments: true,
};

const REVIEW_SKILL: SlashCommand = {
  ...BUILT_IN_SKILL,
  id: "skill-review-document",
  name: "review-document",
  full_command: "/review-document",
  file_path: "catalex://built-in-skills/review-document/SKILL.md",
  content: "# Review a document in Catalex",
  description:
    "Review documents and leave exact-passage comments without rewriting.",
};

function ensureHarnessTauriMocks() {
  const win = window as Window & {
    __TAURI_INTERNALS__?: {
      invoke?: (
        cmd: string,
        args?: {
          provider?: string;
          answer?: string;
          tabId?: string;
          messages?: unknown[];
          pendingQuestion?: unknown;
          title?: string;
          lastProvider?: string;
          projectRoot?: string;
          mode?: string;
          prompt?: string;
        },
      ) => Promise<unknown>;
      transformCallback?: (callback: (...args: unknown[]) => void) => number;
      unregisterCallback?: (id: number) => void;
      metadata?: {
        currentWindow?: { label: string };
        currentWebview?: { label: string };
      };
      plugins?: { path?: { sep?: string; delimiter?: string } };
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };

  win.__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
  let callbackId = 0;
  win.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "agent-verify-skill-harness" },
      currentWebview: { label: "agent-verify-skill-harness" },
    },
    transformCallback: () => {
      callbackId += 1;
      return callbackId;
    },
    unregisterCallback: () => {},
    invoke: async (cmd, args) => {
      if (cmd === "answer_agent_question") {
        document.documentElement.dataset.agentAnswer = args?.answer;
        useAgentChatStore.getState()._applyActivity(args?.tabId ?? "", {
          kind: "text_delta",
          id: "question-continuation",
          text: "Your answer was received. Continuing the review.",
        });
        return null;
      }
      if (cmd === "save_shared_session") {
        document.documentElement.dataset.savedMessages = JSON.stringify(
          args?.messages,
        );
        sessionStorage.setItem(
          "catalex-question-harness",
          JSON.stringify(args),
        );
        return { shared_session_id: "harness-chat" };
      }
      if (cmd === "load_shared_session") {
        const saved = JSON.parse(
          sessionStorage.getItem("catalex-question-harness") ?? "{}",
        );
        return {
          shared_session_id: "harness-chat",
          title: saved.title,
          last_provider: saved.lastProvider,
          provider_session_ids: {},
          messages: saved.messages ?? [],
          pending_question: saved.pendingQuestion ?? null,
        };
      }
      if (cmd === "plugin:fs|read_text_file") return "";
      if (cmd === "prepare_agent_workspace")
        return {
          sessionId: "harness-draft",
          projectRoot: args?.projectRoot,
          tabId: args?.tabId,
          mode: args?.mode,
          status: "active",
          candidateRoot: "/tmp/harness-draft",
        };
      if (/^(execute|resume)_(claude|codex)_code$/.test(cmd)) {
        document.documentElement.dataset.resumedPrompt = args?.prompt;
        const chat = useAgentChatStore.getState();
        chat._appendMessage(args?.tabId ?? "", {
          type: "assistant",
          message: {
            content: [
              {
                type: "text",
                text: "Continuing from your saved question and answer.",
              },
            ],
          },
        });
        chat._setStreaming(args?.tabId ?? "", false);
        return null;
      }
      if (cmd === "slash_commands_list") {
        return [BUILT_IN_SKILL, REVIEW_SKILL].map((skill) =>
          args?.provider === "claude"
            ? {
                ...skill,
                full_command: `/catalex:${skill.name}`,
                namespace: "catalex",
              }
            : skill,
        );
      }
      if (cmd === "check_codex_status") {
        return {
          installed: true,
          authenticated: true,
          binary_path: "/usr/local/bin/codex",
          version: "0.144.5",
          account_label: "Harness Account",
        };
      }
      if (cmd === "check_claude_status") {
        return {
          installed: true,
          authenticated: true,
          binary_path: "/usr/local/bin/claude",
          version: "harness",
          account_email: "harness@example.test",
          missing_git: false,
        };
      }
      if (cmd === "list_claude_models")
        return [
          {
            value: "default",
            displayName: "Demo",
            description: "Browser harness",
            supportsEffort: false,
          },
        ];
      if (cmd === "list_codex_models") {
        const scenario = new URLSearchParams(window.location.search).get(
          "models",
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (scenario === "empty") return [];
        if (scenario === "error") {
          throw new Error(
            "Codex did not discover Catalex's built-in review-document skill.",
          );
        }
        return [
          {
            model: "gpt-6-astra",
            display_name: "GPT-6 Astra",
            description: "Available from Codex",
            supported_reasoning_efforts: [
              { value: "high", description: "High" },
            ],
            default_reasoning_effort: "high",
            is_default: true,
          },
        ];
      }
      return null;
    },
    plugins: { path: { sep: "/", delimiter: ":" } },
  };
}

function scenarioFromLocation(): ScenarioId {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return value && value in SCENARIOS ? (value as ScenarioId) : "success";
}

const STATUS_CLASSES: Record<TraceStatus, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

export function AgentVerifySkillHarness() {
  ensureHarnessTauriMocks();
  const questionMode = new URLSearchParams(window.location.search).has(
    "question",
  );
  const provider =
    new URLSearchParams(window.location.search).get("provider") === "claude"
      ? "claude"
      : "codex";
  const scenarioId = scenarioFromLocation();
  const scenario = SCENARIOS[scenarioId];

  useEffect(() => {
    useDocumentStore.setState({
      projectRoot: "/tmp/agent-verify-skill-harness",
      files: [],
      folders: [],
      activeFileId: undefined,
      openFileIds: [],
      initialized: true,
    });
    useCodexSetupStore.setState({ status: "ready" });
    useClaudeSetupStore.setState({ status: "ready" });
    useAgentChatStore.setState({
      selectedProvider: provider,
      isStreaming: false,
    });
    if (questionMode) {
      if (
        new URLSearchParams(window.location.search).get("question") ===
        "restored"
      ) {
        useAgentChatStore.getState().newSession();
        useAgentQuestionStore.setState({ questions: [] });
        void useAgentChatStore
          .getState()
          .resumeSession("harness-chat", { useSessionLlm: true });
        return;
      }
      const chat = useAgentChatStore.getState();
      useAgentChatStore.setState({
        isStreaming: true,
        messages: [],
        tabs: chat.tabs.map((tab) =>
          tab.id === chat.activeTabId
            ? {
                ...tab,
                provider,
                messages: [],
                isStreaming: true,
                cancelledByUser: false,
                runtimeSessionKey: "harness-session",
              }
            : tab,
        ),
      });
      useAgentChatStore.getState()._appendMessage(chat.activeTabId, {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "The source paragraph changed. How should I continue?",
            },
          ],
        },
      });
      useAgentQuestionStore.getState().receive({
        requestId: "harness-question",
        tabId: chat.activeTabId,
        sessionId: "harness-session",
        projectRoot: "/tmp/agent-verify-skill-harness",
        question:
          "The source paragraph changed during review. What should I do with comments not yet saved?",
        options: [
          {
            label: "Update comments",
            description:
              "Review the current text and revise the affected feedback.",
          },
          {
            label: "Apply safe comments only",
            description:
              "Save only comments whose complete paragraphs still match.",
          },
          {
            label: "Discard unsaved comments",
            description:
              "Stop saving further comments. Already-saved comments stay.",
          },
        ].map((option) =>
          new URLSearchParams(window.location.search).get("question") ===
          "overflow"
            ? { ...option, label: `${option.label}: ${option.description}` }
            : option,
        ),
      });
    }
  }, [provider, questionMode]);

  if (
    questionMode &&
    new URLSearchParams(window.location.search).has("drawer")
  ) {
    return (
      <div
        className="relative h-screen bg-muted/30"
        data-testid="question-drawer-harness"
      >
        <AgentChatDrawer />
      </div>
    );
  }

  return (
    <div
      data-testid="agent-verify-skill-harness"
      data-scenario={scenarioId}
      className="flex h-screen flex-col bg-muted/30 p-5 text-foreground"
    >
      <main className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-sm">
        <header className="border-border border-b px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-blue-600 text-xs">
                $catalex-verify-latex
              </p>
              <h1 className="mt-1 font-semibold text-lg">{scenario.title}</h1>
              <p className="mt-1 text-muted-foreground text-sm">
                Deterministic skill workflow trace
              </p>
            </div>
            <span
              data-testid="verification-status"
              className={`rounded-full border px-3 py-1 font-medium text-xs ${
                scenario.verification === "complete"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {scenario.verification}
            </span>
          </div>
          <nav
            className="mt-4 flex flex-wrap gap-2"
            aria-label="Harness scenarios"
          >
            {(Object.keys(SCENARIOS) as ScenarioId[]).map((id) => (
              <a
                key={id}
                href={`?debug=agent-verify-skill&scenario=${id}`}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  id === scenarioId
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-border text-muted-foreground"
                }`}
              >
                {id}
              </a>
            ))}
          </nav>
        </header>

        {questionMode ? (
          <div className="relative min-h-0 flex-1">
            <ChatMessages />
          </div>
        ) : (
          <section className="min-h-0 flex-1 overflow-auto p-5">
            <ol data-testid="verification-trace" className="space-y-3">
              {scenario.steps.map((step, index) => (
                <li
                  key={`${step.label}-${index}`}
                  data-tool={step.tool ?? ""}
                  className="flex gap-3"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs">
                    {index + 1}
                  </span>
                  <div
                    className={`flex-1 rounded-lg border px-3 py-2 ${STATUS_CLASSES[step.status]}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium text-sm">{step.label}</span>
                      {step.tool && (
                        <code className="rounded bg-white/60 px-1.5 py-0.5 text-[10px]">
                          {step.tool}
                        </code>
                      )}
                    </div>
                    <p className="mt-1 text-xs opacity-80">{step.detail}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-5 rounded-lg border border-border bg-muted/30 px-4 py-3">
              <div className="font-medium text-xs uppercase tracking-wide">
                Final report
              </div>
              <p data-testid="verification-summary" className="mt-1 text-sm">
                {scenario.summary}
              </p>
            </div>
          </section>
        )}

        <div className="border-border border-t">
          <ChatComposer isExpanded />
        </div>
      </main>
    </div>
  );
}
