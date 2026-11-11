import { invokeBridge } from "./desktop/bridge";
import {
  redo,
  redoDepth,
  selectAll,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { getEditorClipboardText } from "@/components/workspace/editor/editor-clipboard";

export interface ContextAction {
  label: string;
  disabled?: boolean;
  separator?: boolean;
  run: () => void | Promise<void>;
}
export interface ContextMenuRequest {
  x: number;
  y: number;
  actions: ContextAction[];
  portalContainer?: HTMLElement;
  restoreFocus: () => void;
  loadActions?: () => Promise<ContextAction[]>;
}
export const CONTEXT_MENU_EVENT = "catalex:context-menu";
export const CONTEXT_MENU_DISMISS_EVENT = "catalex:context-menu-dismiss";
type EditorContextActions = (
  position: number,
) => Promise<ContextAction[]> | null;
const editorContextActions = new WeakMap<EditorView, EditorContextActions>();
export function registerEditorContextActions(
  view: EditorView,
  actions: EditorContextActions,
) {
  editorContextActions.set(view, actions);
  return () => editorContextActions.delete(view);
}

const readableSelector =
  '[data-selectable-content], .selectable-content, .chat-markdown, .select-text, .cm-inlineCommentText, pre, [data-testid="pdf-scroll-container"], #write';
const inputSelector = 'input, textarea, [contenteditable="true"]';
const controlSelector = 'button, [role="button"], [role="menu"], select';

// Desktop denies general browser clipboard reads; only menu Paste requests text.
function readClipboardText(): Promise<string> {
  return window.catalex
    ? invokeBridge<string>("desktop:clipboard:readText")
    : navigator.clipboard.readText();
}

function editorActions(view: EditorView): ContextAction[] {
  const state = view.state;
  const editable = !state.readOnly && state.facet(EditorView.editable);
  const selected = state.selection.ranges.some((range) => !range.empty);
  const restore = () => {
    if (!view.dom.isConnected || view.state.doc !== state.doc)
      throw new Error("The document changed. Open the menu again.");
    view.focus();
    view.dispatch({ selection: state.selection });
  };
  return [
    {
      label: "Undo",
      disabled: !editable || !undoDepth(state),
      run: () => {
        restore();
        undo(view);
      },
    },
    {
      label: "Redo",
      disabled: !editable || !redoDepth(state),
      run: () => {
        restore();
        redo(view);
      },
    },
    {
      label: "Cut",
      separator: true,
      disabled: !editable || !selected,
      run: async () => {
        restore();
        await navigator.clipboard.writeText(getEditorClipboardText(view));
        restore();
        view.dispatch({
          ...view.state.replaceSelection(""),
          userEvent: "delete.cut",
          scrollIntoView: true,
        });
      },
    },
    {
      label: "Copy",
      disabled: !selected,
      run: async () => {
        restore();
        await navigator.clipboard.writeText(getEditorClipboardText(view));
      },
    },
    {
      label: "Paste",
      disabled: !editable,
      run: async () => {
        const text = await readClipboardText();
        restore();
        view.dispatch({
          ...view.state.replaceSelection(text),
          userEvent: "input.paste",
          scrollIntoView: true,
        });
      },
    },
    {
      label: "Select All",
      separator: true,
      run: () => {
        restore();
        selectAll(view);
      },
    },
  ];
}

function inputActions(element: HTMLElement): ContextAction[] {
  const doc = element.ownerDocument;
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const isInput = element.matches("input, textarea");
  const start = isInput ? input.selectionStart : null;
  const end = isInput ? input.selectionEnd : null;
  const value = isInput ? input.value : element.textContent;
  const selection = doc.getSelection();
  const range =
    !isInput && selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
  const editable = !input.disabled && !input.readOnly;
  const password = element.matches('input[type="password"]');
  const text = isInput
    ? input.value.slice(start ?? 0, end ?? 0)
    : (selection?.toString() ?? "");
  const restore = () => {
    if (
      !element.isConnected ||
      (isInput ? input.value : element.textContent) !== value
    )
      throw new Error("The text changed. Open the menu again.");
    element.focus({ preventScroll: true });
    if (isInput && start !== null && end !== null)
      input.setSelectionRange(start, end);
    else if (range) {
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  };
  restore();
  const command = (name: string, argument?: string) => {
    restore();
    // Chromium's editing commands preserve native undo and dispatch input to React.
    if (!doc.execCommand(name, false, argument))
      throw new Error("This editing action is unavailable.");
  };
  return [
    {
      label: "Undo",
      disabled:
        !editable ||
        doc.activeElement !== element ||
        !doc.queryCommandEnabled("undo"),
      run: () => command("undo"),
    },
    {
      label: "Redo",
      disabled:
        !editable ||
        doc.activeElement !== element ||
        !doc.queryCommandEnabled("redo"),
      run: () => command("redo"),
    },
    {
      label: "Cut",
      separator: true,
      disabled: !editable || password || !text,
      run: async () => {
        await navigator.clipboard.writeText(text);
        command("delete");
      },
    },
    {
      label: "Copy",
      disabled: password || !text,
      run: () => navigator.clipboard.writeText(text),
    },
    {
      label: "Paste",
      disabled: !editable,
      run: async () => {
        const text = await readClipboardText();
        restore();
        const data = new DataTransfer();
        data.setData("text/plain", text);
        // Let composers apply their existing paste handling before native insertion.
        if (
          element.dispatchEvent(
            new ClipboardEvent("paste", {
              bubbles: true,
              cancelable: true,
              clipboardData: data,
            }),
          )
        )
          command("insertText", text);
      },
    },
    {
      label: "Select All",
      separator: true,
      disabled: input.disabled,
      run: () => {
        restore();
        if (isInput) input.select();
        else {
          const all = doc.createRange();
          all.selectNodeContents(element);
          selection?.removeAllRanges();
          selection?.addRange(all);
        }
      },
    },
  ];
}

function resolveActions(target: Element): ContextAction[] {
  const link = target.closest<HTMLAnchorElement>("a[href]");
  if (link)
    return [
      {
        label: "Open Link",
        run: () => {
          if (link.isConnected) link.click();
        },
      },
      {
        label: "Copy Link",
        run: () => navigator.clipboard.writeText(link.href),
      },
    ];
  const input = target.closest<HTMLElement>(inputSelector);
  // CodeMirror widgets (comment inputs, search fields) own their text separately.
  if (input && !input.classList.contains("cm-content")) {
    if (
      input.matches(
        'input[type="checkbox"], input[type="radio"], input[type="range"], input[type="color"], input[type="file"], input[type="button"], input[type="submit"], input[type="reset"]',
      )
    )
      return [];
    return inputActions(input);
  }
  if (target.closest(controlSelector)) return [];
  const editor = target.closest<HTMLElement>(".cm-editor");
  const view = editor && EditorView.findFromDOM(editor);
  if (view) return editorActions(view);
  const region = target.closest(readableSelector);
  const doc = target.ownerDocument;
  const selection = doc.getSelection();
  if (!region || !selection?.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0).cloneRange();
  if (
    !region.contains(range.startContainer) ||
    !region.contains(range.endContainer)
  )
    return [];
  const text = selection.toString();
  return [
    {
      label: "Copy",
      run: async () => {
        if (
          !range.startContainer.isConnected ||
          !range.endContainer.isConnected
        )
          return;
        selection.removeAllRanges();
        selection.addRange(range);
        // PDF copy handlers provide source line breaks that DOM text cannot supply.
        const data = new DataTransfer();
        const event = new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        });
        region.dispatchEvent(event);
        await navigator.clipboard.writeText(
          event.defaultPrevented ? data.getData("text/plain") : text,
        );
      },
    },
  ];
}

/** Install per document: iframe events do not bubble to the app document. */
export function installContextMenus(doc: Document) {
  const down = (event: MouseEvent) => {
    if (doc !== document && event.button === 0 && !event.ctrlKey)
      window.dispatchEvent(new Event(CONTEXT_MENU_DISMISS_EVENT));
    if (
      event.button !== 2 &&
      !(event.button === 0 && event.ctrlKey && /Mac/.test(navigator.platform))
    )
      return;
    const target = event.target as Element | null;
    if (target?.closest?.(`${inputSelector}, .cm-editor, ${readableSelector}`))
      event.preventDefault();
  };
  const context = (event: MouseEvent) => {
    if (event.defaultPrevented) return; // Existing file/history menus own their event.
    event.preventDefault();
    const target = event.target as Element | null;
    if (!target?.closest) return;
    const actions = resolveActions(target);
    const editor = target.closest<HTMLElement>(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    const position = view?.posAtCoords({ x: event.clientX, y: event.clientY });
    const extra =
      view &&
      position != null &&
      (target === view.contentDOM || target.closest(".cm-line")) &&
      !target.closest("input, textarea")
        ? editorContextActions.get(view)?.(position)
        : null;
    const withExtra = (items: ContextAction[]) =>
      items.length
        ? [
            ...items,
            ...actions.map((action, i) =>
              i === 0 ? { ...action, separator: true } : action,
            ),
          ]
        : actions;
    const active =
      target.closest<HTMLElement>(inputSelector) ??
      target
        .closest<HTMLElement>(".cm-editor")
        ?.querySelector<HTMLElement>(".cm-content") ??
      target.closest<HTMLElement>('[data-testid="pdf-scroll-container"]') ??
      (doc.activeElement as HTMLElement | null);
    const frame = doc.defaultView?.frameElement?.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent<ContextMenuRequest>(CONTEXT_MENU_EVENT, {
        detail: {
          actions: extra
            ? withExtra([
                { label: "Checking spelling…", disabled: true, run: () => {} },
              ])
            : actions,
          loadActions: extra ? () => extra.then(withExtra) : undefined,
          portalContainer:
            target.closest<HTMLElement>(
              '[role="dialog"], [role="alertdialog"]',
            ) ?? undefined,
          x: event.clientX + (frame?.left ?? 0),
          y: event.clientY + (frame?.top ?? 0),
          restoreFocus: () => {
            if (active?.isConnected) active.focus({ preventScroll: true });
          },
        },
      }),
    );
  };
  const key = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    )
      return;
    const target = event.target as HTMLElement;
    const editor = target.closest<HTMLElement>(".cm-editor");
    const view = editor && EditorView.findFromDOM(editor);
    const rect =
      view?.coordsAtPos(view.state.selection.main.head) ??
      target.getBoundingClientRect();
    event.preventDefault();
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + (view ? 1 : 12),
        clientY: rect.top + (view ? 1 : 12),
      }),
    );
  };
  doc.addEventListener("mousedown", down, true);
  doc.addEventListener("contextmenu", context);
  doc.addEventListener("keydown", key);
  return () => {
    doc.removeEventListener("mousedown", down, true);
    doc.removeEventListener("contextmenu", context);
    doc.removeEventListener("keydown", key);
  };
}
