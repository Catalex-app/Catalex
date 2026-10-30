import { useSettingsStore } from "@/stores/settings-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentWorkspaceSession } from "@/lib/agent-workspace";
import { useAgentReviewQueueStore } from "@/stores/agent-review-queue-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";
import {
  type ProposedChange,
  useProposedChangesStore,
} from "@/stores/proposed-changes-store";
import { useZoteroStore } from "@/stores/zotero-store";

function writeFromAnotherWindow(key: string, state: unknown, version = 0) {
  const value = JSON.stringify({ state, version });
  localStorage.setItem(key, value);
  vi.mocked(localStorage.setItem).mockClear();
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  // A receiving window must not echo the snapshot back to localStorage.
  expect(localStorage.setItem).not.toHaveBeenCalled();
}

function savedState(key: string) {
  return JSON.parse(localStorage.getItem(key)!).state;
}

function change(id: string): ProposedChange {
  return {
    id,
    filePath: `${id}.tex`,
    absolutePath: `/one/${id}.tex`,
    oldContent: "before",
    newContent: "after",
    toolName: "Edit",
    timestamp: 1,
  };
}

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({ recentProjects: [], lastProjectFolder: null });
  useDocumentStore.setState({
    projectRoot: "/one",
    agentWorkspaceSessionId: null,
    files: [],
  });
  useProposedChangesStore.setState({
    activeProjectRoot: "/one",
    changes: [],
    changesByProject: {},
    workspaceReview: null,
    workspaceReviewsByProject: {},
  });
  useAgentReviewQueueStore.setState({ entries: [] });
  useZoteroStore.setState({
    apiKey: null,
    userID: null,
    username: null,
    syncedCollections: {},
    isAuthenticated: false,
    isValidating: false,
    collections: [],
  });
  vi.clearAllMocks();
});

describe("persisted state across windows", () => {
  it("saves settings immediately and receives changes without a mounted UI effect", () => {
    useSettingsStore.getState().setEditorFontSize(18);
    expect(savedState("catalex-settings").editorFontSize).toBe(18);
    writeFromAnotherWindow(
      "catalex-settings",
      {
        ...useSettingsStore.getState(),
        editorFontSize: 22,
      },
      useSettingsStore.persist.getOptions().version,
    );
    expect(useSettingsStore.getState().editorFontSize).toBe(22);
    expect(useDocumentStore.getState().projectRoot).toBe("/one");
  });
  it("retains another window's recent project when this window changes focus", () => {
    writeFromAnotherWindow("catalex-projects", {
      recentProjects: [{ path: "/two", name: "two", lastOpened: 1 }],
      lastProjectFolder: "/papers",
    });
    useProjectStore.getState().addRecentProject("/one");
    useProjectStore
      .getState()
      .setRecentProjectLastActiveFile("/one", "main.tex");
    expect(savedState("catalex-projects")).toMatchObject({
      recentProjects: [
        { path: "/one", lastActiveFile: "main.tex" },
        { path: "/two" },
      ],
      lastProjectFolder: "/papers",
    });
  });

  it("refreshes proposals for this window without switching its active project", () => {
    useProposedChangesStore.getState().addChange(change("stale"));
    writeFromAnotherWindow(
      "catalex-proposed-changes",
      {
        changesByProject: {
          "/one": [change("updated")],
          "/two": [change("remote")],
        },
        workspaceReviewsByProject: {},
      },
      1,
    );
    expect(useProposedChangesStore.getState()).toMatchObject({
      activeProjectRoot: "/one",
      changes: [{ id: "updated" }],
    });
    useProposedChangesStore.getState().addChange(change("local"));
    expect(
      savedState("catalex-proposed-changes").changesByProject,
    ).toMatchObject({
      "/one": [{ id: "updated" }, { id: "local" }],
      "/two": [{ id: "remote" }],
    });
  });

  it("retains another project's review when this window checkpoints chat edits", () => {
    const session: AgentWorkspaceSession = {
      version: 2,
      sessionId: "remote-review",
      projectRoot: "/two",
      tabId: "remote-tab",
      mode: "ask",
      status: "review",
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/draft/candidate",
      warnings: [],
    };
    writeFromAnotherWindow("catalex-agent-review-queue", {
      entries: [
        {
          session,
          phase: "review",
          conflicts: [],
          editedContents: { main: "kept" },
        },
      ],
    });
    useAgentReviewQueueStore.getState().captureEdits();
    expect(savedState("catalex-agent-review-queue").entries).toMatchObject([
      {
        session: { sessionId: "remote-review" },
        editedContents: { main: "kept" },
      },
    ]);
  });

  it("keeps an in-flight settlement locked when another project saves", () => {
    const session: AgentWorkspaceSession = {
      version: 2,
      sessionId: "local-review",
      projectRoot: "/one",
      tabId: "local-tab",
      mode: "ask",
      status: "review",
      createdAt: 1,
      updatedAt: 1,
      sourceCommit: "fixture-source",
      baselineCommit: "fixture-baseline",
      candidateRoot: "/draft/candidate",
      warnings: [],
    };
    const review = {
      session,
      originalChanges: [change("applying")],
      decisions: {},
      settlementError: null,
      isApplying: true,
    };
    useProposedChangesStore.setState({
      changes: [change("applying")],
      workspaceReview: review,
    });
    writeFromAnotherWindow(
      "catalex-proposed-changes",
      {
        changesByProject: { "/two": [change("remote")] },
        workspaceReviewsByProject: {},
      },
      1,
    );
    expect(useProposedChangesStore.getState()).toMatchObject({
      activeProjectRoot: "/one",
      changes: [{ id: "applying" }],
      changesByProject: { "/two": [{ id: "remote" }] },
    });
    expect(useProposedChangesStore.getState().workspaceReview).toBe(review);
    // The per-window running flag must not be copied into saved project maps.
    expect(
      savedState("catalex-proposed-changes").workspaceReviewsByProject,
    ).toEqual({});
  });

  it("shares Zotero collections and clears authentication on remote disconnect", () => {
    const collection = {
      collectionKey: "papers",
      name: "Papers",
      bibFileName: "papers.bib",
      libraryVersion: 1,
      keyMap: {},
    };
    useZoteroStore.setState({ isValidating: true });
    writeFromAnotherWindow("catalex-zotero", {
      apiKey: "test-only-placeholder",
      userID: "test-user",
      username: "Test",
      syncedCollections: {
        "/one": { papers: collection },
        "/two": { papers: collection },
      },
    });
    expect(useZoteroStore.getState()).toMatchObject({
      isAuthenticated: true,
      isValidating: true,
    });
    useZoteroStore.getState().removeCollection("papers");
    expect(savedState("catalex-zotero").syncedCollections["/two"]).toEqual({
      papers: collection,
    });
    writeFromAnotherWindow("catalex-zotero", {
      apiKey: null,
      userID: null,
      username: null,
      syncedCollections: {},
    });
    expect(useZoteroStore.getState()).toMatchObject({
      apiKey: null,
      isAuthenticated: false,
      isValidating: true,
    });
  });

  it("ignores session storage events even when their key matches", () => {
    localStorage.setItem(
      "catalex-projects",
      JSON.stringify({
        state: { recentProjects: [{ path: "/unrelated" }] },
        version: 0,
      }),
    );
    const event = new StorageEvent("storage", { key: "catalex-projects" });
    // Vitest may expose Node's Storage rather than jsdom's branded object.
    Object.defineProperty(event, "storageArea", {
      value: window.sessionStorage,
    });
    window.dispatchEvent(event);
    expect(useProjectStore.getState().recentProjects).toEqual([]);
  });
});
