import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useActionTarget } from "./use-action-target";
import {
  getAppMenuItems,
  runMenuAction,
  useAppAction,
  useAppActions,
  type AppAction,
} from "./use-app-actions";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const placement = { group: "Edit", section: 0, order: 0 } as const;
async function invoke(id: string) {
  const entry = getAppMenuItems().find((item) => item.id === id)!;
  await runMenuAction({ command: id, key: entry.key });
}

it("discovers metadata, updates labels and callbacks, and removes actions on unmount", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const first = vi.fn(),
    second = vi.fn();
  function Harness({ actions }: { actions: AppAction[] }) {
    useAppActions(actions);
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <Harness
          actions={[
            {
              id: "future-action",
              label: "First",
              run: first,
              menu: placement,
            },
          ]}
        />,
      ),
    );
    expect(getAppMenuItems()).toMatchObject([
      { id: "future-action", label: "First", enabled: true },
    ]);
    await invoke("future-action");
    expect(first).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <Harness
          actions={[
            {
              id: "future-action",
              label: "Updated",
              run: second,
              menu: placement,
            },
          ]}
        />,
      ),
    );
    await invoke("future-action");
    expect(second).toHaveBeenCalledOnce();
    expect(getAppMenuItems()[0].label).toBe("Updated");
    await act(async () =>
      root.render(
        <Harness
          actions={[
            {
              id: "future-action",
              label: "Updated",
              run: second,
              enabled: false,
              menu: placement,
            },
          ]}
        />,
      ),
    );
    await invoke("future-action");
    expect(second).toHaveBeenCalledOnce();
    await act(async () => root.render(<Harness actions={[]} />));
    expect(getAppMenuItems()).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("retains editor actions inside expanded dialogs and native blur, and targets iframe selections explicitly", async () => {
  const host = document.createElement("div"),
    panel = document.createElement("section");
  const editor = document.createElement("div"),
    frame = document.createElement("iframe"),
    input = document.createElement("input");
  panel.append(editor);
  document.body.append(host, panel, frame, input);
  const doc = frame.contentDocument!;
  const calls: string[] = [];
  function Harness() {
    const source = useActionTarget(() => editor, "source");
    const preview = useActionTarget(() => doc.body, "preview", doc);
    useAppAction(
      {
        id: "comment",
        label: "Comment",
        run: () => calls.push("editor"),
        menu: placement,
      },
      source ? "active" : "inactive",
    );
    useAppAction(
      {
        id: "comment",
        label: "Comment",
        run: () => calls.push("preview"),
        menu: placement,
      },
      preview ? "active" : "inactive",
    );
    return null;
  }
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness />));
    for (const expanded of [false, true, false]) {
      if (expanded) panel.setAttribute("role", "dialog");
      else panel.removeAttribute("role");
      await act(async () =>
        editor.dispatchEvent(new Event("pointerdown", { bubbles: true })),
      );
      window.dispatchEvent(new Event("blur"));
      expect(getAppMenuItems()[0].enabled).toBe(true);
      await invoke("comment");
    }
    await act(async () =>
      doc.body.dispatchEvent(new Event("pointerdown", { bubbles: true })),
    );
    await invoke("comment");
    await act(async () => input.focus());
    expect(getAppMenuItems()[0].enabled).toBe(false);
    await invoke("comment");
    expect(calls).toEqual(["editor", "editor", "editor", "preview"]);
  } finally {
    await act(async () => root.unmount());
    for (const node of [host, panel, frame, input]) node.remove();
  }
});

it("never chooses an ambiguous handler by registration order", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const run = vi.fn();
  function Owner() {
    useAppAction({ id: "same", label: "Same", run, menu: placement });
    return null;
  }
  try {
    await act(async () =>
      root.render(
        <>
          <Owner />
          <Owner />
        </>,
      ),
    );
    expect(getAppMenuItems()[0].enabled).toBe(false);
    await invoke("same");
    expect(run).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
