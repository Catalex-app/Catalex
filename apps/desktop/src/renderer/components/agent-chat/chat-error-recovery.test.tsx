import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorRecovery } from "./chat-error-recovery";
import { CodexSessionRecovery } from "./codex-session-recovery";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useCodexSetupStore } from "@/stores/codex-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { compileLatex } from "@/lib/latex-compiler";
import { invoke } from "@/lib/desktop/core";

vi.mock("@/lib/desktop/core", () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock("@/lib/latex-compiler", async (original) => ({
  ...(await original<typeof import("@/lib/latex-compiler")>()),
  compileLatex: vi.fn(),
}));
const error = "The agent draft did not compile. Undefined control sequence.";
const originalTab = useAgentChatStore.getState().tabs[0];
const send = vi.fn(async (_prompt: string) => {});
let root: Root;
let container: HTMLDivElement;
const button = (name: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  );
const click = async (name: string) =>
  act(async () => {
    button(name)!.click();
  });
const waitFor = vi.waitFor;
function mount(
  message = error,
  source: "chat" | "models" | "setup" = "chat",
  canFix = true,
  provider: "claude" | "codex" = "codex",
) {
  return act(() =>
    root.render(
      <ChatErrorRecovery
        message={message}
        source={source}
        provider={provider}
        agentName="Demo model"
        effort="High"
        canFix={canFix}
      />,
    ),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command) => {
      if (command === "check_codex_status" || command === "check_claude_status")
        return { installed: true, authenticated: true, missing_git: false };
      if (command === "list_codex_models")
        return [
          { model: "model", supported_reasoning_efforts: [{ value: "high" }] },
        ];
      if (command === "list_claude_models")
        return [{ value: "sonnet", displayName: "Sonnet", description: "" }];
      return null;
    });
  useClaudeSetupStore.setState({
    status: "ready",
    modelsStatus: "ready",
    error: null,
    modelsError: null,
  });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useAgentChatStore.setState({
    activeTabId: "a",
    selectedProvider: "codex",
    isStreaming: false,
    error,
    sendPrompt: send,
    tabs: [
      {
        ...originalTab,
        id: "a",
        error,
        draft: { input: "Keep this draft", pinnedContexts: [] },
        agentWorkspace: {
          sessionId: "s",
          projectRoot: "/source",
          candidateRoot: "/candidate",
          status: "review",
        } as any,
        agentVerificationContext: {
          rootId: "main.tex",
          targetPath: "main.tex",
          backend: "latexmk",
          engine: "pdflatex",
          autoEngine: true,
        },
      },
    ],
  });
  useCodexSetupStore.setState({
    status: "ready",
    modelsStatus: "ready",
    error: null,
    modelsError: null,
  });
  useDocumentStore.setState({ agentWorkspaceSessionId: null });
  useAgentReviewQueueStore.setState({
    entries: [
      {
        session: { sessionId: "s" },
        phase: "review",
        verificationError: error,
      },
    ] as any,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
describe("production error recovery", () => {
  it("recompiles the candidate before clearing the error and queue verification failure", async () => {
    vi.mocked(compileLatex).mockResolvedValue({
      pdfData: new Uint8Array(),
      diagnostics: [],
    });
    mount();
    await click("Refresh");
    await waitFor(() => expect(useAgentChatStore.getState().error).toBeNull());
    expect(compileLatex).toHaveBeenCalledWith(
      "/candidate",
      "main.tex",
      "latexmk",
      "pdflatex",
      true,
    );
    expect(
      useAgentReviewQueueStore.getState().entries[0].verificationError,
    ).toBeUndefined();
  });
  it("keeps the original failure when refresh fails and shows the raw new error", async () => {
    vi.mocked(compileLatex).mockRejectedValue(new Error("Still broken"));
    mount();
    await click("Refresh");
    await waitFor(() =>
      expect(container.textContent).toContain("Still broken"),
    );
    expect(useAgentChatStore.getState().error).toBe(error);
    expect(
      useAgentReviewQueueStore.getState().entries[0].verificationError,
    ).toBe(error);
  });
  it("does not clear another tab or a newer failure after an asynchronous refresh", async () => {
    let resolve!: (value: any) => void;
    vi.mocked(compileLatex).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mount();
    await click("Refresh");
    act(() => useAgentChatStore.getState()._setError("a", "New failure"));
    await act(async () =>
      resolve({ pdfData: new Uint8Array(), diagnostics: [] }),
    );
    expect(useAgentChatStore.getState().error).toBe("New failure");
    expect(
      useAgentReviewQueueStore.getState().entries[0].verificationError,
    ).toBe(error);
  });
  it("reconnects without resending the original input or consuming the new draft", async () => {
    const message = "Provider error: authentication service timeout";
    useAgentChatStore.setState((state) => ({
      error: message,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        error: message,
        retryRequest: {
          prompt: "Original request",
          context: [],
          provider: "codex" as const,
        },
      })),
    }));
    mount(message);
    expect(button("Settings")).toBeUndefined();
    expect(button("Fix with chat")).toBeUndefined();
    await click("Reconnect");
    expect(send).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("dispose_codex_session", {
      tabId: "a",
    });
    expect(useAgentChatStore.getState().error).toBeNull();
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe(
      "Keep this draft",
    );
  });
  it.each([
    "claude",
    "codex",
  ] as const)("preserves paused, idle and review states when reconnecting %s", async (provider) => {
    const workspace = useAgentChatStore.getState().tabs[0].agentWorkspace;
    for (const phase of ["paused", "idle", "review"] as const) {
      const message = "Connection interrupted";
      useAgentChatStore.setState((state) => ({
        selectedProvider: provider,
        error: message,
        tabs: state.tabs.map((tab) => ({
          ...tab,
          provider,
          error: message,
          pauseState: phase === "paused" ? "paused" : null,
          agentWorkspace:
            phase === "idle"
              ? null
              : ({
                  ...workspace!,
                  status: phase === "paused" ? "active" : "review",
                } as any),
        })),
      }));
      const tab = useAgentChatStore.getState().tabs[0];
      const queue = useAgentReviewQueueStore.getState().entries;
      mount(message, "chat", true, provider);
      await click("Reconnect");
      expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
        error: null,
        pauseState: tab.pauseState,
        draft: tab.draft,
        agentWorkspace: tab.agentWorkspace,
      });
      expect(useAgentReviewQueueStore.getState().entries).toEqual(queue);
      expect(send).not.toHaveBeenCalled();
    }
    expect(
      vi
        .mocked(invoke)
        .mock.calls.map(([command]) => command)
        .some((command) => /^(execute|resume)_/.test(command)),
    ).toBe(false);
  });

  it("keeps the error and pending review when reconnect readiness fails", async () => {
    const message = "Lost connection";
    useAgentChatStore.getState()._setError("a", message);
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_codex_status")
        return { installed: true, authenticated: true };
      if (command === "list_codex_models")
        throw new Error("Models unavailable");
      return null;
    });
    const queue = useAgentReviewQueueStore.getState().entries;
    mount(message);
    await click("Reconnect");
    expect(useAgentChatStore.getState().error).toBe(message);
    expect(container.textContent).toContain("Models unavailable");
    expect(useAgentReviewQueueStore.getState().entries).toEqual(queue);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not clear a newer error after an asynchronous reconnect", async () => {
    const message = "Lost connection";
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "dispose_codex_session")
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return null;
    });
    useAgentChatStore.getState()._setError("a", message);
    mount(message);
    await click("Reconnect");
    act(() => useAgentChatStore.getState()._setError("a", "New failure"));
    await act(async () => finish());
    expect(useAgentChatStore.getState().error).toBe("New failure");
    expect(send).not.toHaveBeenCalled();
  });

  it("restores a request that never launched only into an empty composer", () => {
    const request = { prompt: "Unsent request", context: [] };
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        agentWorkspace: null,
        pausedRequest: request,
        draft: { input: "", pinnedContexts: [] },
      })),
    }));
    useAgentChatStore.getState()._recoverError("a", error);
    expect(useAgentChatStore.getState().tabs[0]).toMatchObject({
      error: null,
      pauseState: null,
      draft: { input: "Unsent request" },
      pausedRequest: null,
    });
    useAgentChatStore.setState((state) => ({
      error,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        error,
        pausedRequest: request,
        draft: { input: "New draft", pinnedContexts: [] },
      })),
    }));
    useAgentChatStore.getState()._recoverError("a", error);
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe("New draft");
    const attachments = [
      {
        label: "New attachment",
        filePath: "new.md",
        selectedText: "New context",
      },
    ];
    useAgentChatStore.setState((state) => ({
      error,
      tabs: state.tabs.map((tab) => ({
        ...tab,
        error,
        pausedRequest: request,
        draft: { input: "", pinnedContexts: attachments },
      })),
    }));
    useAgentChatStore.getState()._recoverError("a", error);
    expect(useAgentChatStore.getState().tabs[0].draft).toEqual({
      input: "",
      pinnedContexts: attachments,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a fixing prompt without consuming the typed draft", async () => {
    mount();
    await click("Fix with chat");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0]).toContain(error);
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe(
      "Keep this draft",
    );
  });
  it("offers settings instead of a fixing prompt when signed out and clears after sign-in", async () => {
    const message = "Not authenticated";
    useAgentChatStore.getState()._setError("a", message);
    useCodexSetupStore.setState({ status: "not-authenticated" });
    mount(message, "chat", false);
    expect(button("Fix with chat")).toBeUndefined();
    await click("Settings");
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_settings_window", {
        section: "agent",
        provider: "codex",
      }),
    );
    act(() => useCodexSetupStore.setState({ status: "ready" }));
    expect(useAgentChatStore.getState().error).toBeNull();
  });
});

describe("Codex recovery with the shared error panel", () => {
  it("shows takeover only for a verified owner and requires confirmation", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        providerSessionIds: { codex: "thread" },
      })),
    }));
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "check_codex_session_owner"
        ? { ownerToken: "verified-owner" }
        : null,
    );
    act(() =>
      root.render(<CodexSessionRecovery agentName="Codex" effort="High" />),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(button("Take over")).toBeDefined();
    await click("Take over");
    expect(invoke).not.toHaveBeenCalledWith(
      "reconnect_codex_session",
      expect.anything(),
    );
    const confirm = Array.from(
      document.querySelectorAll('[role="dialog"] button'),
    ).find((button) => button.textContent === "Take over") as HTMLButtonElement;
    await act(async () => {
      confirm.click();
    });
    expect(invoke).toHaveBeenCalledWith(
      "reconnect_codex_session",
      expect.objectContaining({
        tabId: "a",
        sessionId: "thread",
        ownerToken: "verified-owner",
      }),
    );
    expect(send).not.toHaveBeenCalled();
  });
  it("does not offer takeover when the owner cannot be verified", async () => {
    useAgentChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        providerSessionIds: { codex: "thread" },
      })),
    }));
    vi.mocked(invoke).mockResolvedValue(null);
    act(() =>
      root.render(<CodexSessionRecovery agentName="Codex" effort="High" />),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(button("Take over")).toBeUndefined();
    expect(button("Reconnect")).toBeDefined();
  });
});
