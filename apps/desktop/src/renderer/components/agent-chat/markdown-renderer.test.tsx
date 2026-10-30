import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useDocumentStore } from "@/stores/document-store";
import { MarkdownRenderer } from "./markdown-renderer";

const renders = vi.hoisted(() => vi.fn());
vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    renders(children);
    return <div>{children}</div>;
  },
}));

it("does not reparse unchanged responses on parent renders or text-file updates", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const previousFiles = useDocumentStore.getState().files;
  useDocumentStore.setState({ files: [] });
  try {
    await act(async () =>
      root.render(<MarkdownRenderer content="Stable $x^2$" />),
    );
    const count = renders.mock.calls.length;
    await act(async () =>
      root.render(<MarkdownRenderer content="Stable $x^2$" />),
    );
    await act(async () =>
      useDocumentStore.setState({
        files: [
          {
            id: "a",
            name: "a.md",
            relativePath: "a.md",
            absolutePath: "/a.md",
            type: "other",
            content: "Changed editor text",
            isDirty: true,
          },
        ],
      }),
    );
    expect(renders).toHaveBeenCalledTimes(count);
    await act(async () =>
      root.render(<MarkdownRenderer content="New $x^3$" />),
    );
    expect(renders).toHaveBeenCalledTimes(count + 1);
  } finally {
    await act(async () => root.unmount());
    useDocumentStore.setState({ files: previousFiles });
  }
});
