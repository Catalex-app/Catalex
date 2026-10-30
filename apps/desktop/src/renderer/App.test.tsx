import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  ask: vi.fn(),
  prepare: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  setChatState: vi.fn(),
  toast: vi.fn(),
  handler: null as
    | null
    | ((event: { preventDefault: () => void }) => Promise<void>),
}));
vi.mock("@/lib/desktop/window", () => ({
  getCurrentWindow: () => ({
    close: mocks.close,
    onCloseRequested: async (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return () => {};
    },
  }),
}));
vi.mock("@/lib/desktop/dialog", () => ({ ask: mocks.ask }));
vi.mock("@/lib/project-chat-lifecycle", () => ({
  prepareProjectExit: mocks.prepare,
  subscribeProjectChats: mocks.subscribe,
  ProjectExitCanceled: class extends Error {},
  CommentSaveExitError: class extends Error {},
}));
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: (select: (state: { projectRoot: null }) => unknown) =>
    select({ projectRoot: null }),
}));
vi.mock("@/stores/agent-chat-store", () => ({
  useAgentChatStore: { setState: mocks.setChatState },
}));
vi.mock("@/stores/onboarding-store", () => ({
  useOnboardingStore: (select: (state: { completed: boolean }) => unknown) =>
    select({ completed: true }),
}));
vi.mock("@/stores/proposed-changes-store", () => ({
  getProposedChangesProjectKey: vi.fn(),
  useProposedChangesStore: vi.fn(),
}));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({
  useKeyboardShortcuts: vi.fn(),
}));
vi.mock("@/hooks/use-project-file-watch", () => ({
  useProjectFileWatch: vi.fn(),
}));
vi.mock("@/hooks/use-agent-events", () => ({ useAgentEvents: vi.fn() }));
vi.mock("@/components/project-picker", () => ({ ProjectPicker: () => null }));
vi.mock("@/components/onboarding", () => ({ Onboarding: () => null }));
vi.mock("@/components/comment-close-dialog", () => ({
  CommentCloseDialog: () => null,
}));
vi.mock("@/components/agent-chat/agent-question-prompt", () => ({
  ProjectChangedDialog: () => null,
}));
vi.mock("@/components/workspace/git-credential-recovery", () => ({
  GitCredentialRecovery: () => null,
}));
vi.mock("@/components/workspace/history-workspace", () => ({
  HistoryWorkspace: () => null,
}));
vi.mock("@/components/workspace/workspace-layout", () => ({
  WorkspaceLayout: () => null,
}));
vi.mock("@/components/settings/solar-mode-effect", () => ({
  SolarModeEffect: () => null,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("sonner", () => ({ toast: { error: mocks.toast } }));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("window close after a save failure", () => {
  let root: Root;
  let container: HTMLDivElement;
  const requestClose = () => mocks.handler!({ preventDefault: vi.fn() });
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.close.mockResolvedValue(undefined);
    mocks.prepare.mockResolvedValue(undefined);
    mocks.ask.mockResolvedValue(false);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<App />));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps the normal save-before-close path without asking to discard", async () => {
    await act(async () => requestClose());
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("defaults to staying open and permits retry without discarding buffers", async () => {
    mocks.prepare.mockRejectedValueOnce(
      new Error("Native service is unavailable"),
    );
    await act(async () => requestClose());
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.ask).toHaveBeenCalledWith(
      expect.stringContaining("unsaved manuscript, chat, and comment changes"),
      expect.objectContaining({
        defaultButton: "cancel",
        cancelLabel: "Stay open",
        okLabel: "Close anyway",
      }),
    );
    expect(mocks.setChatState.mock.calls).toEqual([
      [{ isLeavingProject: false }],
    ]);
    await act(async () => requestClose());
    expect(mocks.prepare).toHaveBeenCalledTimes(2);
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("closes after explicit discard without retrying the failed save", async () => {
    mocks.prepare.mockRejectedValueOnce(
      new Error("Native service is unavailable"),
    );
    mocks.ask.mockResolvedValueOnce(true);
    await act(async () => requestClose());
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("keeps duplicate close requests from opening multiple discard dialogs", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Save failed"));
    let answer!: (value: boolean) => void;
    mocks.ask.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = requestClose();
      await Promise.resolve();
    });
    await act(async () => requestClose());
    expect(mocks.ask).toHaveBeenCalledOnce();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    await act(async () => {
      answer(false);
      await first;
    });
    expect(mocks.close).not.toHaveBeenCalled();
  });

  it("stays open if the confirmation cannot be shown", async () => {
    mocks.prepare.mockRejectedValueOnce(new Error("Save failed"));
    mocks.ask.mockRejectedValueOnce(new Error("Dialog unavailable"));
    await act(async () => requestClose());
    expect(mocks.close).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Dialog unavailable"),
    );
  });
});
