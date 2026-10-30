import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { EditorToolbar } from "./editor-toolbar";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

vi.mock("@/stores/document-store", async () => {
  const { create } = await import("zustand");
  return {
    useDocumentStore: create(() => ({
      files: [],
      activeFileId: "main.tex",
      openFileIds: ["main.tex", "notes.tex"],
      setActiveFile: vi.fn(),
      closeOpenFile: vi.fn(),
    })),
  };
});
const hintRendered = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/tooltip", () => ({
  Hint: ({ children }: any) => {
    hintRendered();
    return children;
  },
}));

it("skips body-only updates but immediately reflects tab metadata and actions", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const file = (id: string): ProjectFile => ({
    id,
    name: id,
    relativePath: id,
    absolutePath: `/tmp/${id}`,
    type: "tex",
    content: "one",
    isDirty: false,
  });
  useDocumentStore.setState({
    files: [file("main.tex"), file("notes.tex")],
    activeFileId: "main.tex",
    openFileIds: ["main.tex", "notes.tex"],
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  const committed = vi.fn();
  const render = () =>
    act(() =>
      root.render(
        <Profiler id="tabs" onRender={committed}>
          <EditorToolbar />
        </Profiler>,
      ),
    );
  const edit = (patch: Partial<ProjectFile>) =>
    act(() =>
      useDocumentStore.setState((state) => ({
        files: state.files.map((f) =>
          f.id === "main.tex" ? { ...f, ...patch } : f,
        ),
      })),
    );
  try {
    render();
    edit({ content: "first edit", isDirty: true });
    expect(host.textContent).toContain("main.tex *");
    committed.mockClear();
    edit({ content: "second edit" });
    edit({ content: "third edit" });
    expect(committed).not.toHaveBeenCalled();
    hintRendered.mockClear();
    render(); // A parent update also must not render the unchanged tab strip.
    expect(hintRendered).not.toHaveBeenCalled();
    edit({ isDirty: false });
    expect(host.textContent).not.toContain("main.tex *");
    edit({
      name: "renamed.tex",
      relativePath: "chapters/renamed.tex",
      type: "csv",
    });
    expect(
      host.querySelector('[aria-label="chapters/renamed.tex"]'),
    ).not.toBeNull();
    expect(host.textContent).toContain("renamed.tex");
    act(() =>
      (host.querySelector('[aria-label="notes.tex"]') as HTMLElement).click(),
    );
    expect(useDocumentStore.getState().setActiveFile).toHaveBeenCalledWith(
      "notes.tex",
    );
    act(() =>
      (
        host.querySelector('[aria-label="Close notes.tex"]') as HTMLElement
      ).click(),
    );
    expect(useDocumentStore.getState().closeOpenFile).toHaveBeenCalledWith(
      "notes.tex",
    );
    act(() =>
      useDocumentStore.setState({
        openFileIds: ["notes.tex", "main.tex"],
        activeFileId: "notes.tex",
      }),
    );
    expect(host.querySelector("[data-editor-file-tab]")?.textContent).toContain(
      "notes.tex",
    );
    expect(host.querySelector('[data-active="true"]')?.textContent).toContain(
      "notes.tex",
    );
    act(() => useDocumentStore.setState({ openFileIds: [] }));
    expect(host.querySelectorAll("[data-editor-file-tab]")).toHaveLength(1);
    expect(host.querySelector("[data-editor-file-tab]")?.textContent).toContain(
      "notes.tex",
    );
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
