import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { useDocumentStore } from "@/stores/document-store";
import { useSearchComments } from "./search-comments";

vi.mock("@/lib/desktop/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("loads comments only while a nonempty comment search is enabled", async () => {
  vi.mocked(invoke)
    .mockReset()
    .mockResolvedValue({
      files: {
        "main.tex": [
          { id: "h", number: 1, from: 0, to: 1, line: 1, text: "Feedback" },
        ],
      },
      sources: {},
      counters: [1, 0],
    });
  useDocumentStore.setState({
    projectRoot: "/search-load",
    agentWorkspaceRoot: null,
    files: [],
  });
  let results: ReturnType<typeof useSearchComments>["results"] = [];
  function Harness({ enabled, text }: { enabled: boolean; text: string }) {
    results = useSearchComments(
      { text, caseSensitive: false, wholeWord: false, regex: false },
      enabled,
      true,
    ).results;
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<Harness enabled={false} text="Feedback" />),
    );
    await act(async () => root.render(<Harness enabled text="" />));
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled text="Feedback" />));
    expect(results).toHaveLength(1);
    vi.mocked(invoke).mockClear();
    await act(async () => root.render(<Harness enabled text="Feed" />));
    expect(results).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled={false} text="Feed" />));
    expect(results).toHaveLength(0);
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent("catalex:project-comments-refresh", {
          detail: { projectRoot: "/search-load" },
        }),
      ),
    );
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    useDocumentStore.setState({ projectRoot: null });
    host.remove();
  }
});
