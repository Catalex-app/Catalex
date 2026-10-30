import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@/lib/desktop/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommentFileManager } from "./comment-file-manager";
import { PROJECT_COMMENTS_REFRESH_EVENT } from "@/lib/workspace-events";

vi.mock("@/lib/desktop/event", () => ({ listen: vi.fn(async () => vi.fn()) }));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it("renders the supplied snapshot without separately loading disconnected groups", async () => {
  vi.mocked(invoke).mockReset().mockResolvedValue({});
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const comments = Array.from({ length: 1000 }, (_, index) => ({
    id: `c-${index}`,
    from: index,
    to: index + 1,
    line: 1,
    text: `Feedback ${index}`,
  }));
  const render = (items: typeof comments) =>
    act(async () =>
      root.render(
        <TooltipProvider>
          <CommentFileManager
            root="/manager-performance"
            files={{ "main.tex": items }}
            groups={{}}
            disabled={false}
          />
        </TooltipProvider>,
      ),
    );
  try {
    await render(comments);
    expect(invoke).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Feedback 0");
    await render(
      comments.map((c) => ({ ...c, from: c.from + 1, to: c.to + 1 })),
    );
    expect(invoke).not.toHaveBeenCalled();
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="Expand comments in main.tex"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(host.textContent).toContain("Feedback 999");
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="Collapse comments in main.tex"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(host.textContent).not.toContain("Feedback 0");
    await render(comments.slice(1));
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it.each([
  false,
  true,
])("requests a renderer refresh only after failure (failed=%s)", async (failed) => {
  vi.mocked(invoke).mockReset();
  if (failed)
    vi.mocked(invoke).mockRejectedValue(new Error("Selection changed"));
  else vi.mocked(invoke).mockResolvedValue({ cleared: 1 });
  const refresh = vi.fn();
  window.addEventListener(PROJECT_COMMENTS_REFRESH_EVENT, refresh);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <CommentFileManager
            root="/manager-refresh"
            files={{}}
            groups={{
              "gone.tex": [
                { id: "gone", from: 0, to: 1, line: 1, text: "Feedback" },
              ],
            }}
            disabled={false}
          />
        </TooltipProvider>,
      ),
    );
    await act(async () =>
      (
        host.querySelector(
          '[aria-label="Select disconnected file gone.tex"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const submit = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent === "Continue",
    )!;
    await act(async () => submit.click());
    expect(invoke).toHaveBeenCalledWith(
      "manage_comment_files",
      expect.objectContaining({ preview: false, action: "clear" }),
    );
    expect(refresh).toHaveBeenCalledTimes(failed ? 1 : 0);
    expect(host.textContent).toContain(
      failed ? "Selection changed" : "comments cleared",
    );
  } finally {
    window.removeEventListener(PROJECT_COMMENTS_REFRESH_EVENT, refresh);
    await act(async () => root.unmount());
    host.remove();
  }
});
