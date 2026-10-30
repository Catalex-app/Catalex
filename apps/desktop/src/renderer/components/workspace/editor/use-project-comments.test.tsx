import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { toast } from "sonner";
import { useProjectComments } from "./use-project-comments";
import type { CommentChangeEvent } from "./inline-comment-storage";
import type { InlineEditorComment } from "./inline-comments";

const mocks = vi.hoisted(() => ({
  reconnected: undefined as
    | ((event: { payload: { projectRoot: string } }) => void)
    | undefined,
  handler: undefined as
    | ((event: { payload: CommentChangeEvent }) => void)
    | undefined,
}));
vi.mock("@/lib/desktop/event", () => ({
  listen: vi.fn(async (_event, handler) => {
    if (_event === "catalex-comments-changed") mocks.handler = handler;
    if (_event === "catalex-comments-reconnected") mocks.reconnected = handler;
    return vi.fn();
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const human: InlineEditorComment = {
  id: "human",
  number: 1,
  from: 0,
  to: 4,
  line: 1,
  text: "Human",
};
const agent: InlineEditorComment = {
  ...human,
  id: "agent",
  origin: { provider: "claude", sessionId: "session" },
};
let result: ReturnType<typeof useProjectComments>;
let root: Root;
let container: HTMLDivElement;
function Harness({
  project = "/project",
  manager = false,
}: {
  project?: string | null;
  manager?: boolean;
}) {
  result = useProjectComments(project, undefined, manager);
  return null;
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async () => ({
      files: { "main.tex": [human] },
      sources: {},
      counters: [8, 3],
    }));
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shares an initial pending snapshot between mounted views", async () => {
  vi.mocked(invoke).mockClear();
  const views: ReturnType<typeof useProjectComments>[] = [];
  function View({ index }: { index: number }) {
    views[index] = useProjectComments("/shared-views");
    return null;
  }
  await act(async () =>
    root.render(
      <>
        <View index={0} />
        <View index={1} />
      </>,
    ),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "read_project_comments_anchored"),
  ).toHaveLength(1);
  expect(views[0][0]["main.tex"]).toEqual([human]);
  expect(views[1][0]["main.tex"]).toEqual([human]);
});

it("preserves an empty local draft during a native manager refresh", async () => {
  const { clearCommentDraftHistory } = await import("./comment-draft-history");
  try {
    await act(async () =>
      result[1]((files) => ({
        ...files,
        "main.tex": [
          ...files["main.tex"],
          { ...human, id: "empty-native-draft", text: "", isEditing: true },
        ],
      })),
    );
    vi.mocked(invoke).mockClear();
    await act(async () =>
      mocks.reconnected?.({ payload: { projectRoot: "/project" } }),
    );
    expect(result[0]["main.tex"]).toContainEqual(
      expect.objectContaining({
        id: "empty-native-draft",
        isEditing: true,
        text: "",
      }),
    );
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "read_project_comments_anchored"),
    ).toHaveLength(1);
  } finally {
    clearCommentDraftHistory();
  }
});

it("loads manager groups in one snapshot and refreshes both views together", async () => {
  const detached = { ...human, id: "detached" };
  vi.mocked(invoke)
    .mockClear()
    .mockImplementation(async () => ({
      files: { "main.tex": [human] },
      disconnected: { "gone.tex": [detached] },
      sources: {},
      counters: [8, 3],
    }));
  await act(async () => root.render(<Harness manager />));
  expect(result[5]).toEqual({ "gone.tex": [detached] });
  expect(invoke).toHaveBeenCalledWith("read_project_comments_anchored", {
    projectRoot: "/project",
    includeDisconnected: true,
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke)
    .mockClear()
    .mockImplementation(async () => ({
      files: { "main.tex": [human, detached] },
      disconnected: {},
      sources: {},
      counters: [8, 3],
    }));
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: "/project" },
      }),
    ),
  );
  expect(result[5]).toEqual({});
  expect(result[0]["main.tex"]).toHaveLength(2);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("does not retain a delayed manager snapshot after closing", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => root.render(<Harness manager />));
  // A null root is how the manager stops subscribing when closed.
  await act(async () => root.render(<Harness project={null} manager />));
  await act(async () =>
    finish({
      files: {},
      disconnected: { "gone.tex": [human] },
      sources: {},
      counters: [8, 3],
    }),
  );
  expect(result[5]).toEqual({});
  expect(result[3]).toBe(false);
});

it("does not reuse an old pending snapshot when the same project reopens", async () => {
  let finish!: (value: unknown) => void;
  const fresh = { ...human, text: "Updated while closed" };
  vi.mocked(invoke)
    .mockClear()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      files: { "main.tex": [fresh] },
      sources: {},
      counters: [8, 3],
    });
  await act(async () => root.render(<Harness project="/reopened-project" />));
  await act(async () => root.render(<Harness project={null} />));
  await act(async () => root.render(<Harness project="/reopened-project" />));
  const { isCommentDetached } = await import("./comment-paths");
  await act(async () =>
    finish({
      files: {},
      orphanedIds: [human.id],
      sources: {},
      counters: [8, 3],
    }),
  );
  expect(result[3]).toBe(true);
  expect(result[0]["main.tex"]).toEqual([fresh]);
  expect(isCommentDetached("/reopened-project", human.id)).toBe(false);
});

it("does not write for loads or incoming additions batched with a local edit", async () => {
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => {
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: agent.id,
          before: null,
          after: agent,
        },
      },
    });
    result[1]((files) => ({
      ...files,
      "main.tex": files["main.tex"].map((c) =>
        c.id === human.id ? { ...c, text: "Edited" } : c,
      ),
    }));
  });
  expect(result[0]["main.tex"]).toEqual([{ ...human, text: "Edited" }, agent]);
  const writes = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "update_project_comment");
  expect(writes).toHaveLength(1);
  expect(writes[0][1]).toMatchObject({ patch: { id: "human" } });
});

it("preserves sequential local edits before React rerenders", async () => {
  await act(async () => {
    result[1]((files) => ({
      ...files,
      "main.tex": [...files["main.tex"], { ...human, id: "second" }],
    }));
    result[1]((files) => ({
      ...files,
      "main.tex": files["main.tex"].map((c) => ({ ...c, from: 10, to: 14 })),
    }));
  });
  expect(result[0]["main.tex"]).toHaveLength(2);
  expect(result[0]["main.tex"].every((c) => c.from === 10)).toBe(true);
});

it("ignores other projects and retries retained edits before saving later changes", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("comment_conflict"));
  await act(async () =>
    result[1]({ "main.tex": [{ ...human, text: "Unsaved" }] }),
  );
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("not saved"),
    expect.objectContaining({
      action: expect.objectContaining({ label: "Retry saving" }),
    }),
  );
  const count = vi.mocked(invoke).mock.calls.length;
  await act(async () => {
    mocks.handler?.({
      payload: {
        projectRoot: "/other",
        patch: {
          filePath: "main.tex",
          id: agent.id,
          before: null,
          after: agent,
        },
      },
    });
    result[1]({ "main.tex": [{ ...human, text: "Keep for copying" }] });
  });
  expect(invoke).toHaveBeenCalledTimes(count + 2);
  expect(result[0]["main.tex"]).toHaveLength(1);
});

it("buffers notifications while loading, without saving them back", async () => {
  let resolve!: (value: object) => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  expect(result[3]).toBe(true);
  await act(async () => root.render(<Harness project="/next" />));
  expect(result[3]).toBe(false);
  await act(async () => {
    mocks.handler?.({
      payload: {
        projectRoot: "/next",
        patch: {
          filePath: "main.tex",
          id: agent.id,
          before: null,
          after: agent,
        },
      },
    });
    resolve({ files: { "main.tex": [human] }, sources: {}, counters: [8, 3] });
  });
  expect(result[0]["main.tex"]).toEqual([human, agent]);
  expect(result[3]).toBe(true);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.every(([command]) =>
        command.startsWith("read_project_comment"),
      ),
  ).toBe(true);
});

it("previews the persisted counter plus one without writing or consuming discarded drafts", async () => {
  const draft = {
    ...human,
    id: "draft",
    number: undefined,
    text: "",
    isEditing: true,
  };
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": [...files["main.tex"], draft],
    })),
  );
  expect(result[0]["main.tex"][1].expectedNumber).toBe(9);
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => result[1]({ "main.tex": [human] }));
  await act(async () =>
    result[1]({
      "main.tex": [
        human,
        draft,
        { ...draft, id: "agent-draft", origin: agent.origin },
      ],
    }),
  );
  expect(result[0]["main.tex"].map((c) => c.expectedNumber)).toEqual([
    undefined,
    9,
    4,
  ]);
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () =>
    result[1]((files) => ({
      "main.tex": files["main.tex"].map((c) =>
        c.id === "draft" ? { ...c, text: "Saved" } : c,
      ),
    })),
  );
  const write = vi
    .mocked(invoke)
    .mock.calls.find(([command]) => command === "update_project_comment");
  expect(write?.[1]).toMatchObject({ patch: { after: { text: "Saved" } } });
  expect(
    (write?.[1] as { patch: { after: object } }).patch.after,
  ).not.toHaveProperty("expectedNumber");
});

it("preserves identity for unchanged notifications, including predicted drafts", async () => {
  await act(async () =>
    result[1]({
      "main.tex": [
        human,
        {
          ...human,
          id: "draft",
          number: undefined,
          text: "",
          isEditing: true,
        },
      ],
    }),
  );
  const before = result[0];
  await act(async () =>
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: human.id,
          before: human,
          after: { ...human },
        },
      },
    }),
  );
  expect(result[0]).toBe(before);
  expect(result[0]["main.tex"][1].expectedNumber).toBe(9);
});

it("updates real changes and draft predictions when authoritative numbers arrive", async () => {
  await act(async () =>
    result[1]({
      "main.tex": [
        human,
        {
          ...human,
          id: "draft",
          number: undefined,
          text: "",
          isEditing: true,
        },
      ],
    }),
  );
  const before = result[0];
  const numbered = { ...human, id: "remote", number: 12, text: "Remote" };
  await act(async () =>
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: numbered.id,
          before: null,
          after: numbered,
        },
      },
    }),
  );
  expect(result[0]).not.toBe(before);
  expect(result[0]["main.tex"][0]).toBe(before["main.tex"][0]);
  expect(result[0]["main.tex"][1].expectedNumber).toBe(13);
  expect(result[0]["main.tex"][2]).toMatchObject(numbered);
  const acknowledged = result[0];
  await act(async () =>
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: numbered.id,
          before: null,
          after: numbered,
        },
      },
    }),
  );
  expect(result[0]).toBe(acknowledged);
});

it("does not inspect unchanged comment numbers during body, anchor or status updates in a large project", async () => {
  const saved = Array.from({ length: 998 }, (_, index) => ({
    ...human,
    id: `saved-${index}`,
    number: index + 2,
  }));
  const other = Array.from({ length: 1_000 }, (_, index) => ({
    ...agent,
    id: `other-${index}`,
    number: index + 1,
  }));
  vi.mocked(invoke).mockResolvedValue({
    files: { "main.tex": [human, ...saved], "other.tex": other },
    sources: {},
    counters: [999, 1_000],
  });
  await act(async () =>
    root.render(<Harness project="/large-number-preview" />),
  );
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": [
        ...files["main.tex"],
        { ...human, id: "draft", number: undefined, text: "", isEditing: true },
      ],
    })),
  );
  const numberRead = vi.fn();
  for (const comment of [...saved, ...other]) {
    const number = comment.number;
    Object.defineProperty(comment, "number", {
      enumerable: true,
      get: () => {
        numberRead();
        return number;
      },
    });
  }
  const draft = result[0]["main.tex"][result[0]["main.tex"].length - 1];
  const edit = async (change: Partial<InlineEditorComment>, range = false) =>
    act(async () =>
      result[1](
        (files) => ({
          ...files,
          "main.tex": files["main.tex"].map((comment) =>
            comment.id === human.id ? { ...comment, ...change } : comment,
          ),
        }),
        range,
      ),
    );
  await edit({ text: "Edited" });
  await edit({ from: 2, to: 6 }, true);
  await edit({ resolved: true });
  const previous = result[0]["main.tex"][0];
  await act(async () =>
    mocks.handler?.({
      payload: {
        projectRoot: "/large-number-preview",
        patch: {
          filePath: "main.tex",
          id: human.id,
          before: previous,
          after: {
            ...previous,
            text: "Agent edit",
            from: 3,
            to: 7,
            resolved: false,
          },
        },
      },
    }),
  );
  expect(result[0]["main.tex"][0]).toMatchObject({
    text: "Agent edit",
    from: 3,
    to: 7,
    resolved: false,
  });
  expect(numberRead).not.toHaveBeenCalled();
  expect(result[0]["other.tex"]).toBe(other);
  expect(result[0]["main.tex"][result[0]["main.tex"].length - 1]).toBe(draft);
  expect(draft?.expectedNumber).toBe(1_000);
});

it("recalculates mixed-author draft previews after acknowledgement, reordering and discard", async () => {
  const draft = { ...human, number: undefined, text: "", isEditing: true };
  await act(async () =>
    result[1]({
      "main.tex": [
        human,
        { ...draft, id: "first" },
        { ...draft, id: "second" },
        { ...draft, id: "agent-draft", origin: agent.origin },
      ],
    }),
  );
  const first = result[0]["main.tex"][1];
  await act(async () =>
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: first.id,
          before: null,
          after: { ...first, number: 12, text: "Saved elsewhere" },
        },
      },
    }),
  );
  expect(result[0]["main.tex"].map((c) => c.expectedNumber)).toEqual([
    undefined,
    9,
    13,
    4,
  ]);
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": [...files["main.tex"], { ...draft, id: "third" }],
    })),
  );
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": [
        files["main.tex"][0],
        files["main.tex"][1],
        files["main.tex"][4],
        files["main.tex"][2],
        files["main.tex"][3],
      ],
    })),
  );
  expect(result[0]["main.tex"].map((c) => [c.id, c.expectedNumber])).toEqual([
    ["human", undefined],
    ["first", 9],
    ["third", 13],
    ["second", 14],
    ["agent-draft", 4],
  ]);
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": files["main.tex"].filter((c) => c.id !== "third"),
    })),
  );
  expect(
    result[0]["main.tex"].find((c) => c.id === "second")?.expectedNumber,
  ).toBe(13);
  expect(
    result[0]["main.tex"].find((c) => c.id === "agent-draft")?.expectedNumber,
  ).toBe(4);
});

it("renumbers remaining empty drafts when the shared draft is closed", async () => {
  const { setCommentDraft, clearCommentDraftHistory } = await import(
    "./comment-draft-history"
  );
  const draft = { ...human, number: undefined, text: "", isEditing: true };
  try {
    await act(async () =>
      result[1]({
        "main.tex": [
          human,
          { ...draft, id: "discard" },
          { ...draft, id: "keep" },
        ],
      }),
    );
    await act(async () => {
      const scope = { root: "/project", filePath: "main.tex" };
      setCommentDraft(scope, "discard", {
        comment: { ...draft, id: "discard" },
        text: "",
      });
      setCommentDraft(scope, "discard", null);
    });
    expect(result[0]["main.tex"].map((c) => c.id)).toEqual(["human", "keep"]);
    expect(result[0]["main.tex"][1].expectedNumber).toBe(9);
    expect(invoke).toHaveBeenCalledTimes(1);
  } finally {
    clearCommentDraftHistory();
  }
});

it("uses assigned numbers from another pane and conflict recovery for subsequent previews", async () => {
  const { COMMENT_HISTORY_EVENT } = await import("./comment-draft-history");
  const { COMMENT_CONFLICT_RESOLVED_EVENT } = await import(
    "./inline-comment-storage"
  );
  const draft = { ...human, number: undefined, text: "", isEditing: true };
  await act(async () =>
    result[1]({
      "main.tex": [
        human,
        { ...draft, id: "human-draft" },
        { ...draft, id: "agent-draft", origin: agent.origin },
      ],
    }),
  );
  const agentPatch = {
    filePath: "other.tex",
    id: "remote-agent",
    before: null,
    after: { ...agent, id: "remote-agent", number: 8 },
  };
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(COMMENT_HISTORY_EVENT, {
        detail: { root: "/project", patches: [agentPatch] },
      }),
    ),
  );
  expect(result[0]["main.tex"].map((c) => c.expectedNumber)).toEqual([
    undefined,
    9,
    9,
  ]);
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent(COMMENT_CONFLICT_RESOLVED_EVENT, {
        detail: {
          projectRoot: "/project",
          patch: {
            filePath: "main.tex",
            id: human.id,
            before: human,
            after: { ...human, number: 12 },
          },
        },
      }),
    ),
  );
  expect(
    result[0]["main.tex"].find((c) => c.id === "human-draft")?.expectedNumber,
  ).toBe(13);
  expect(
    result[0]["main.tex"].find((c) => c.id === "agent-draft")?.expectedNumber,
  ).toBe(9);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("reloads external comments on project refresh while preserving unsaved typing", async () => {
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  const { setCommentDraft, clearCommentDraftHistory } = await import(
    "./comment-draft-history"
  );
  try {
    await act(async () =>
      setCommentDraft({ root: "/project", filePath: "main.tex" }, human.id, {
        comment: human,
        text: "Unsaved typing",
      }),
    );
    vi.mocked(invoke).mockImplementation(async () => ({
      files: {
        "main.tex": [{ ...human, text: "Externally edited" }, agent],
      },
      sources: {},
      counters: [8, 3],
    }));
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
          detail: { projectRoot: "/other" },
        }),
      ),
    );
    expect(result[0]["main.tex"]).toHaveLength(1);
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
          detail: { projectRoot: "/project" },
        }),
      ),
    );
    expect(result[0]["main.tex"]).toHaveLength(2);
    expect(result[0]["main.tex"][0]).toMatchObject({
      text: "Externally edited",
      draftText: "Unsaved typing",
      isEditing: true,
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "update_project_comment"),
    ).toBe(false);
  } finally {
    clearCommentDraftHistory();
  }
});

it("keeps comments visible while a refresh read is pending", async () => {
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  let finish!: (files: Record<string, InlineEditorComment[]>) => void;
  const pending = new Promise<Record<string, InlineEditorComment[]>>(
    (resolve) => {
      finish = resolve;
    },
  );
  vi.mocked(invoke).mockImplementation(async () =>
    pending.then((files) => ({ files, sources: {}, counters: [8, 3] })),
  );
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: "/project" },
      }),
    );
  });
  expect(result[0]["main.tex"]).toEqual([human]);
  await act(async () =>
    finish({ "main.tex": [{ ...human, text: "Refreshed" }] }),
  );
  expect(result[0]["main.tex"][0].text).toBe("Refreshed");
});

it("keeps saving during reload and discards a stale read", async () => {
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  let finish!: (value: unknown) => void;
  const slow = new Promise((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  let disk = { "main.tex": [human] };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "read_project_comments_anchored")
      return {
        files: ++reads === 1 ? await slow : disk,
        sources: {},
        counters: [8, 3],
      };
    if (command === "update_project_comment")
      disk = { "main.tex": [args.patch.after] };
  });
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: "/project" },
      }),
    );
  });
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": files["main.tex"].map((c) => ({
        ...c,
        text: "Saved during refresh",
      })),
    })),
  );
  expect(result[0]["main.tex"][0].text).toBe("Saved during refresh");
  await act(async () => finish({ "main.tex": [human] }));
  expect(result[0]["main.tex"][0].text).toBe("Saved during refresh");
  // The storage refresh re-reads after the save supersedes its snapshot.
  expect(reads).toBe(3);
});

it("keeps comment controls usable after a failed reload", async () => {
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  vi.mocked(invoke).mockRejectedValue(new Error("Invalid comments JSON"));
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: "/project" },
      }),
    );
  });
  expect(result[3]).toBe(true);
  await act(async () =>
    result[1]((files) => ({
      ...files,
      "main.tex": files["main.tex"].map((c) => ({ ...c, isEditing: true })),
    })),
  );
  expect(result[0]["main.tex"][0].isEditing).toBe(true);
  expect(toast.error).toHaveBeenCalled();
});

it("does not resurrect a comment deleted during refresh", async () => {
  const { PROJECT_COMMENTS_REFRESH_EVENT } = await import(
    "@/lib/workspace-events"
  );
  let finish!: (value: unknown) => void;
  const slow = new Promise((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "read_project_comments_anchored")
      return {
        files: ++reads === 1 ? await slow : { "main.tex": [] },
        sources: {},
        counters: [8, 3],
      };
  });
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PROJECT_COMMENTS_REFRESH_EVENT, {
        detail: { projectRoot: "/project" },
      }),
    );
  });
  await act(async () => result[1]({ "main.tex": [] }));
  await act(async () => finish({ "main.tex": [human] }));
  expect(result[0]["main.tex"]).toEqual([]);
  // A stale snapshot is re-read before any anchor repair can be written.
  expect(reads).toBe(3);
});

it("skips disconnected replay and offers Manage", async () => {
  const { detachComments } = await import("./comment-paths");
  const { OPEN_COMMENT_MANAGER_EVENT } = await import("@/lib/workspace-events");
  const opened = vi.fn();
  window.addEventListener(OPEN_COMMENT_MANAGER_EVENT, opened);
  detachComments("/project", [human.id]);
  try {
    const count = vi.mocked(invoke).mock.calls.length;
    await act(async () =>
      result[2]({
        filePath: "main.tex",
        id: human.id,
        before: human,
        after: null,
      }),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      "Undo/redo skipped a disconnected comment.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Manage" }),
      }),
    );
    const options = vi.mocked(toast.warning).mock.calls[
      vi.mocked(toast.warning).mock.calls.length - 1
    ][1];
    (options?.action as unknown as { onClick: () => void }).onClick();
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { projectRoot: "/project" } }),
    );
    expect(invoke).toHaveBeenCalledTimes(count);
  } finally {
    detachComments("/project", []);
    window.removeEventListener(OPEN_COMMENT_MANAGER_EVENT, opened);
  }
});

it("retains failed replay and retries it after pending saves", async () => {
  let failing = true;
  const order: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "update_project_comment") {
      order.push("save");
      if (failing) throw new Error("disk unavailable");
    }
    if (command === "replay_project_comment") {
      order.push("replay");
      return args!.patch;
    }
    return { files: { "main.tex": [human] }, sources: {}, counters: [8, 3] };
  });
  const edited = { ...human, text: "Retained edit" };
  await act(async () => result[1]({ "main.tex": [edited] }));
  await act(async () =>
    result[2]({
      filePath: "main.tex",
      id: human.id,
      before: edited,
      after: human,
    }),
  );
  expect(order).not.toContain("replay");
  const options = vi.mocked(toast.error).mock.calls[
    vi.mocked(toast.error).mock.calls.length - 1
  ][1];
  expect(options?.action).toEqual(
    expect.objectContaining({ label: "Retry saving" }),
  );
  failing = false;
  await act(async () =>
    (options?.action as unknown as { onClick: () => void }).onClick(),
  );
  expect(order.slice(-2)).toEqual(["save", "replay"]);
  const { getUnsavedCommentFiles } = await import("./inline-comment-storage");
  expect(getUnsavedCommentFiles("/project")).toEqual([]);
});

it("reloads unavailable comments from the replay toast", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Read failed"));
  await act(async () => root.render(<Harness project="/unavailable" />));
  await act(async () =>
    result[2]({
      filePath: "main.tex",
      id: human.id,
      before: human,
      after: human,
    }),
  );
  const [, options] = vi.mocked(toast.error).mock.calls[
    vi.mocked(toast.error).mock.calls.length - 1
  ];
  expect(options?.action).toEqual(
    expect.objectContaining({ label: "Reload comments" }),
  );
  vi.mocked(invoke).mockImplementation(async () => ({
    files: { "main.tex": [human] },
    sources: {},
    counters: [8, 3],
  }));
  await act(async () =>
    (options?.action as unknown as { onClick: () => void }).onClick(),
  );
  expect(result[3]).toBe(true);
  expect(result[0]["main.tex"]).toEqual([human]);
});

it("applies every anchor in a batch notification without saving it again", async () => {
  await act(async () => {
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: agent.id,
          before: null,
          after: agent,
        },
      },
    });
  });
  const patches = [human, agent].map((comment) => ({
    filePath: "main.tex",
    id: comment.id,
    before: comment,
    after: { ...comment, from: 1, to: 5 },
  }));
  vi.mocked(invoke).mockClear();
  await act(async () => {
    mocks.handler?.({
      payload: { projectRoot: "/project", patch: patches[0], patches },
    });
  });
  expect(
    result[0]["main.tex"].map((comment) => [
      comment.id,
      comment.from,
      comment.to,
    ]),
  ).toEqual([
    [human.id, 1, 5],
    [agent.id, 1, 5],
  ]);
  expect(invoke).not.toHaveBeenCalled();
});

it("does not resurrect a locally deleted comment when its delayed creation arrives", async () => {
  const draft = {
    ...human,
    id: "quick",
    number: undefined,
    text: "Quick comment",
  };
  const saved = { ...draft, number: 9, anchorRevision: "source" };
  let release!: () => void;
  vi.mocked(invoke).mockImplementation(async (_command, args) => {
    const patch =
      args?.patch as import("./inline-comment-storage").CommentPatch;
    if (!patch.before) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...patch, after: saved };
    }
    expect(patch.before).toEqual(saved);
    return patch;
  });
  await act(async () => result[1]({ "main.tex": [human, draft] }));
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => result[1]({ "main.tex": [human] }));
  await act(async () => {
    mocks.handler?.({
      payload: {
        projectRoot: "/project",
        patch: {
          filePath: "main.tex",
          id: draft.id,
          before: null,
          after: saved,
        },
      },
    });
  });
  expect(result[0]["main.tex"]).toEqual([human]);
  await act(async () => {
    release();
    const { flushProjectCommentWrites } = await import(
      "./inline-comment-storage"
    );
    await flushProjectCommentWrites("/project");
  });
  expect(result[0]["main.tex"]).toEqual([human]);
  expect(toast.error).not.toHaveBeenCalled();
});

it("keeps the save warning when a no-op refresh follows a failed edit", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Storage unavailable"));
  await act(async () =>
    result[1]({ "main.tex": [{ ...human, text: "Unsaved feedback" }] }),
  );
  expect(toast.error).toHaveBeenCalledWith(
    expect.stringContaining("not saved"),
    expect.anything(),
  );
  vi.mocked(toast.dismiss).mockClear();
  await act(async () => result[1]((files) => ({ ...files })));
  expect(toast.dismiss).not.toHaveBeenCalled();
  const { flushProjectCommentWrites } = await import(
    "./inline-comment-storage"
  );
  await act(async () => flushProjectCommentWrites("/project"));
});
