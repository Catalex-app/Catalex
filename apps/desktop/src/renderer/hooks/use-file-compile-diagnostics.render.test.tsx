import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  useDocumentStore,
  resolveTexRoot,
  type ProjectFile,
} from "@/stores/document-store";
import { useFileCompileDiagnostics } from "./use-file-compile-diagnostics";

vi.mock("@/stores/document-store", async () => {
  const { create } = await import("zustand");
  return {
    useDocumentStore: create(() => ({
      files: [],
      compileErrorCache: new Map(),
      compileDiagnosticsCache: new Map(),
      cursorPosition: 0,
    })),
    resolveTexRoot: vi.fn(
      (id, files) =>
        files.find((file: ProjectFile) => file.id === id)?.content || id,
    ),
  };
});

it("reuses root checks on cursor updates and immediately picks up edited roots and diagnostics", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const child = {
    id: "child.tex",
    relativePath: "child.tex",
    content: "a.tex",
  } as ProjectFile;
  const warning = (message: string) => ({
    severity: "warning" as const,
    message,
    file: "child.tex",
  });
  useDocumentStore.setState({
    files: [child],
    compileErrorCache: new Map(),
    compileDiagnosticsCache: new Map([
      ["a.tex", [warning("A")]],
      ["b.tex", [warning("B")]],
    ]),
  });
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe() {
    const diagnostics = useFileCompileDiagnostics("child.tex");
    return <span>{diagnostics.map((item) => item.message).join(",")}</span>;
  }
  try {
    act(() => root.render(<Probe />));
    expect(host.textContent).toBe("A");
    vi.mocked(resolveTexRoot).mockClear();
    act(() => useDocumentStore.setState({ cursorPosition: 1 }));
    act(() => useDocumentStore.setState({ cursorPosition: 2 }));
    expect(resolveTexRoot).not.toHaveBeenCalled();
    act(() =>
      useDocumentStore.setState({ files: [{ ...child, content: "b.tex" }] }),
    );
    expect(host.textContent).toBe("B");
    expect(resolveTexRoot).toHaveBeenCalledTimes(1);
    act(() =>
      useDocumentStore.setState({
        compileDiagnosticsCache: new Map([
          ["b.tex", [warning("New diagnostic")]],
        ]),
      }),
    );
    expect(host.textContent).toBe("New diagnostic");
    expect(resolveTexRoot).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
