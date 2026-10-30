import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatErrorRecovery } from "@/components/agent-chat/chat-error-recovery";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { invoke } from "@/lib/desktop/core";

vi.mock("@/lib/desktop/core", () => ({ invoke: vi.fn(), Channel: class {} }));
const revoked =
  "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";
const initial = useAgentChatStore.getState();
let root: Root;
let container: HTMLDivElement;
const button = () =>
  Array.from(container.querySelectorAll("button")).find(
    (b) => b.textContent === "Reload Claude",
  );
const mount = (message = revoked, provider: "claude" | "codex" = "claude") =>
  act(() => {
    useAgentChatStore.setState({ selectedProvider: provider });
    useAgentChatStore.getState()._setError("a", message);
    root.render(
      <ChatErrorRecovery
        message={message}
        source="chat"
        provider={provider}
        agentName="Claude"
        effort="High"
        canFix
      />,
    );
  });
beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useAgentChatStore.setState({
    activeTabId: "a",
    selectedProvider: "claude",
    selectedClaudeModel: "sonnet",
    isStreaming: false,
    error: revoked,
    tabs: [
      {
        ...initial.tabs[0],
        id: "a",
        error: revoked,
        providerSessionIds: { claude: "keep-session" },
        draft: { input: "Keep draft", pinnedContexts: [] },
      },
    ],
  });
  useClaudeSetupStore.setState({
    status: "ready",
    modelsStatus: "ready",
    error: null,
    modelsError: null,
  });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "check_claude_status")
      return { installed: true, authenticated: true, missing_git: false };
    if (command === "list_claude_models")
      return [{ value: "sonnet", displayName: "Sonnet", description: "" }];
    return null;
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
describe("Claude revoked-token recovery", () => {
  it("retains the exact error, shows commands, and does not trust a ready status", () => {
    mount();
    expect(container.textContent).toContain(revoked);
    expect(container.textContent).toContain(
      "claude auth logout\nclaude auth login",
    );
    act(() => useClaudeSetupStore.setState({ status: "checking" }));
    act(() => useClaudeSetupStore.setState({ status: "ready" }));
    expect(useAgentChatStore.getState().error).toBe(revoked);
    expect(button()).toBeDefined();
    expect(container.textContent).not.toContain("Fix with chat");
  });
  it.each([
    ["API Error: 401 Invalid API key", "claude"],
    ["API Error: 403 OAuth access token has been revoked.", "claude"],
    ["API Error: 401 OAuth access token has expired.", "claude"],
    [revoked, "codex"],
  ] as const)("does not offer Claude reload for %s (%s)", (message, provider) => {
    mount(message, provider);
    expect(button()).toBeUndefined();
    expect(container.textContent).not.toContain("claude auth logout");
  });
  it("disposes the affected process and verifies a real request before clearing, preserving draft and session", async () => {
    mount();
    await act(async () => button()!.click());
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "dispose_claude_session",
      "verify_claude_model",
      "check_claude_status",
      "list_claude_models",
    ]);
    expect(invoke).toHaveBeenCalledWith("dispose_claude_session", {
      tabId: "a",
    });
    expect(invoke).toHaveBeenCalledWith("verify_claude_model", {
      modelId: "sonnet",
    });
    expect(useAgentChatStore.getState().error).toBeNull();
    expect(useAgentChatStore.getState().tabs[0].draft.input).toBe("Keep draft");
    expect(useAgentChatStore.getState().tabs[0].providerSessionIds.claude).toBe(
      "keep-session",
    );
  });
  it("keeps instructions and the original error on a failed probe", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "verify_claude_model") throw new Error("Still revoked");
      return null;
    });
    mount();
    await act(async () => button()!.click());
    expect(useAgentChatStore.getState().error).toBe(revoked);
    expect(container.textContent).toContain(revoked);
    expect(container.textContent).toContain("Reload failed: Still revoked");
    expect(container.textContent).toContain("claude auth login");
    expect(button()!.disabled).toBe(false);
  });
  it("prevents duplicate reloads and does not clear a newer error", async () => {
    let finish!: () => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    await act(async () => {
      button()!.click();
      button()!.click();
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(button()!.disabled).toBe(true);
    act(() => useAgentChatStore.getState()._setError("a", "New failure"));
    await act(async () => finish());
    expect(useAgentChatStore.getState().error).toBe("New failure");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
