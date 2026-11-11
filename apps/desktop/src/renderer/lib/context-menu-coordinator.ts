/** Shared input ownership for context menus; ordinary popups are not registered. */
const coordinators = new WeakMap<Document, ContextMenuCoordinator>();

class ContextMenuCoordinator {
  private activeMenu: symbol | null = null;
  private content: HTMLElement | null = null;
  private background: HTMLElement[] = [];
  private listeners = new Set<() => void>();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  constructor(private readonly doc: Document) {}

  canOpen() {
    return this.activeMenu === null;
  }

  acquire(menu: symbol, content?: HTMLElement) {
    if (this.activeMenu === menu) return true;
    if (!this.canOpen()) return false;
    this.activeMenu = menu;
    this.content = content ?? null;
    // Inert blocks pointer/focus access even under pointer-events:auto and in
    // preview iframes. Keep the menu's ancestor path available to Radix.
    for (
      let branch = content;
      branch?.parentElement;
      branch = branch.parentElement
    ) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling !== branch &&
          sibling instanceof HTMLElement &&
          !sibling.inert
        ) {
          sibling.inert = true;
          this.background.push(sibling);
        }
      }
      if (branch.parentElement === this.doc.body) break;
    }
    this.doc.addEventListener("contextmenu", this.blockContextMenu, true);
    this.doc.addEventListener("pointerdown", this.blockSecondaryPointer, true);
    for (const listener of this.listeners) listener();
    return true;
  }

  release(menu: symbol) {
    // A delayed cleanup must never release a different menu's registration.
    if (this.activeMenu !== menu) return;
    this.activeMenu = null;
    this.content = null;
    for (const element of this.background) element.inert = false;
    this.background = [];
    this.doc.removeEventListener("contextmenu", this.blockContextMenu, true);
    this.doc.removeEventListener(
      "pointerdown",
      this.blockSecondaryPointer,
      true,
    );
    for (const listener of this.listeners) listener();
  }

  guardKeyboard = (event: KeyboardEvent) => {
    if (this.canOpen()) return;
    const inside = this.content?.contains(event.target as Node);
    const menuKey =
      event.key === "Escape" ||
      event.key === "Tab" ||
      event.key === "Enter" ||
      event.key === " " ||
      event.key === "Home" ||
      event.key === "End" ||
      event.key.startsWith("Arrow") ||
      event.key.length === 1;
    if (!inside || !menuKey || event.ctrlKey || event.metaKey || event.altKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  private blockContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  private blockSecondaryPointer = (event: PointerEvent) => {
    if (
      event.button === 2 ||
      (event.button === 0 &&
        event.ctrlKey &&
        /Mac/.test(this.doc.defaultView?.navigator.platform ?? ""))
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
}

export function getContextMenuCoordinator(doc: Document) {
  let coordinator = coordinators.get(doc);
  if (!coordinator) {
    coordinator = new ContextMenuCoordinator(doc);
    coordinators.set(doc, coordinator);
  }
  return coordinator;
}

/** Install before application shortcuts; Radix retains unmodified menu keys. */
export function installContextMenuKeyboardBoundary(doc: Document = document) {
  const owner = doc.defaultView;
  const coordinator = getContextMenuCoordinator(doc);
  owner?.addEventListener("keydown", coordinator.guardKeyboard, true);
  owner?.addEventListener("keyup", coordinator.guardKeyboard, true);
  return () => {
    owner?.removeEventListener("keydown", coordinator.guardKeyboard, true);
    owner?.removeEventListener("keyup", coordinator.guardKeyboard, true);
  };
}
