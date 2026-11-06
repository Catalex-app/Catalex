import { piModelLabel } from "@/lib/pi-models";
import "@/components/agent-chat/context-badge-list.css";
import { toast } from "sonner";
import {
  resetCommentPosition,
  mapDocumentComments as mapInlineCommentsThroughChanges,
  sameCommentAnchor,
  CommentDocument,
} from "./comment-document-model";
import {
  applyCommentAnchorRestores,
  commentAnchorHistory,
  restoreCommentAnchors,
  type AnchorInverse,
} from "./comment-anchor-history";
import { isComposingKey } from "@/lib/keyboard-events";
import { EDIT_ICON_PATHS } from "@/lib/edit-icon";
import { isCommentSaving, subscribeCommentSaving } from "./comment-save-state";
import {
  typeCommentDraft,
  closeCommentDraft,
  breakCommentTypingGroup,
  type CommentHistoryScope,
} from "./comment-draft-history";
import { commentRangeExtension } from "./comment-range-extension";
import { commentRangePreviewEffect, type CommentRange } from "./comment-range";
import { renderDomHint, destroyDomHint } from "@/components/ui/dom-hint";
import {
  EditorState,
  StateField,
  StateEffect,
  Facet,
  type ChangeDesc,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  ViewPlugin,
} from "@codemirror/view";

export interface PdfCommentAnchor {
  fingerprint: string;
  text: string;
  regions: Array<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}

export interface InlineEditorComment {
  pdf?: PdfCommentAnchor;
  id: string;
  number?: number;
  expectedNumber?: number;
  // Retained legacy drafts; never displayed or applied automatically.
  proposal?: unknown;
  anchorRevision?: string;
  positionReset?: boolean;
  removedAnchor?: import("@/lib/document-model").DocumentAnchor["removedAnchor"];
  from: number;
  to: number;
  line: number;
  text: string;
  draftText?: string;
  createdAt?: string;
  isEditing?: boolean;
  resolved?: boolean;
  origin?: {
    provider: "claude" | "codex" | "pi";
    sessionId: string;
    model?: string;
    thinkingEffort?: string;
  };
}

export interface NormalizedInlineCommentRange {
  from: number;
  to: number;
  line: number;
}

export interface InlineCommentActions {
  hidden?: boolean;
  historyScope?: CommentHistoryScope;
  fullWidth?: boolean;
  onToggleFullWidth?: () => void;
  selectedCommentIds?: readonly string[];
  onAttach?: (comment: InlineEditorComment) => void;
  onSave?: (commentId: string, text: string) => void;
  onResize?: (commentId: string, range: CommentRange) => void;
  onResolve?: (commentId: string) => void;
  onEdit?: (commentId: string) => void;
  onDelete?: (commentId: string) => void;
  onCancel?: (commentId: string) => void;
}

const MAX_INLINE_COMMENT_SELECTION_LENGTH = 20_000;

interface InlineCommentRenderModel {
  comment: InlineEditorComment;
  displayIndex: number;
  from: number;
  to: number;
  lineEnd: number;
  text: string;
}

type InlineCommentIconName =
  | "check"
  | "edit"
  | "trash"
  | "undo"
  | "expand"
  | "copy";

const INLINE_COMMENT_ICON_PATHS: Record<InlineCommentIconName, string[]> = {
  copy: ["M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"],
  expand: [
    "M16 12h6",
    "M8 12H2",
    "M12 2v2",
    "M12 8v2",
    "M12 14v2",
    "M12 20v2",
    "m19 15 3-3-3-3",
    "m5 9-3 3 3 3",
  ],
  check: ["M20 6 9 17l-5-5"],
  undo: ["m9 14-5-5 5-5", "M4 9h10a6 6 0 0 1 0 12h-2"],
  edit: EDIT_ICON_PATHS,
  trash: [
    "M3 6h18",
    "M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6",
    "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2",
    "M10 10v7",
    "M14 10v7",
  ],
};

const inlineCommentDeleteConfirmationCleanups = new WeakMap<
  HTMLElement,
  () => void
>();

const inlineCommentControlTransitionFrames = new WeakMap<HTMLElement, number>();
const inlineCommentLeaveCleanups = new WeakMap<HTMLElement, () => void>();
const inlineCommentConfirmationReturnTimers = new WeakMap<
  HTMLElement,
  number
>();

const inlineCommentCardTransitionCleanups = new WeakMap<
  HTMLElement,
  () => void
>();
const inlineCommentSaveCleanups = new WeakMap<HTMLElement, () => void>();
const inlineCommentCopyState = new WeakMap<
  HTMLElement,
  { button: HTMLButtonElement; dispose: () => void }
>();

const INLINE_COMMENT_CARD_TRANSITION_DURATION_MS = 160;
const INLINE_COMMENT_LEAVE_DURATION_MS = 120;

export function commentLabel(comment: InlineEditorComment): string {
  return `${comment.origin ? "A" : "H"}-${comment.number ?? comment.expectedNumber ?? 1}`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export class InlineCommentCardWidget extends WidgetType {
  constructor(
    readonly comment: InlineEditorComment,
    readonly displayIndex: number,
    readonly actions: InlineCommentActions = {},
  ) {
    super();
  }

  eq(other: InlineCommentCardWidget): boolean {
    return (
      other.comment.id === this.comment.id &&
      other.comment.from === this.comment.from &&
      other.comment.to === this.comment.to &&
      other.comment.number === this.comment.number &&
      other.comment.expectedNumber === this.comment.expectedNumber &&
      other.comment.text === this.comment.text &&
      other.comment.positionReset === this.comment.positionReset &&
      other.comment.draftText === this.comment.draftText &&
      other.comment.createdAt === this.comment.createdAt &&
      other.comment.isEditing === this.comment.isEditing &&
      other.comment.origin?.provider === this.comment.origin?.provider &&
      other.comment.origin?.model === this.comment.origin?.model &&
      other.comment.origin?.thinkingEffort ===
        this.comment.origin?.thinkingEffort &&
      Boolean(other.actions.selectedCommentIds?.includes(this.comment.id)) ===
        Boolean(this.actions.selectedCommentIds?.includes(this.comment.id)) &&
      Boolean(other.actions.onAttach) === Boolean(this.actions.onAttach) &&
      other.actions.fullWidth === this.actions.fullWidth &&
      Boolean(other.actions.onToggleFullWidth) ===
        Boolean(this.actions.onToggleFullWidth) &&
      other.actions.historyScope?.root === this.actions.historyScope?.root &&
      other.actions.historyScope?.filePath ===
        this.actions.historyScope?.filePath &&
      other.displayIndex === this.displayIndex
    );
  }

  toDOM(view: Pick<EditorView, "requestMeasure">): HTMLElement {
    const card = document.createElement("div");
    card.className = "cm-inlineCommentCard";
    card.tabIndex = -1;
    // Card controls prevent the editor's default mouse handling. Explicitly
    // take keyboard focus so shortcuts do not remain in chat or search.
    card.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) return;
        const target = event.target as Element;
        // Focus changes a lost card's metadata. Let Copy finish its click
        // before taking focus so the target cannot move under the pointer.
        if (target.closest(".cm-inlineCommentCopyButton")) return;
        if (
          target.closest("textarea, input, [contenteditable='true']") &&
          target.closest("textarea, input, [contenteditable='true']") !==
            card.closest(".cm-content")
        )
          return;
        card.focus({ preventScroll: true });
      },
      true,
    );
    card.addEventListener(
      "click",
      (event) => {
        if (!card.classList.contains("cm-inlineCommentUnplaced")) return;
        const target = event.target as Element;
        if (target.closest(".cm-inlineCommentControls, textarea, input"))
          return;
        card.focus({ preventScroll: true });
        const glow = card.querySelector<HTMLElement>(
          ".cm-inlineCommentPlacementHint [data-context-glow]",
        );
        if (!glow || prefersReducedMotion()) return;
        // Reuse the context-pill attention wave when the card is selected.
        glow.style.animation = "none";
        void glow.offsetWidth;
        glow.style.animation = "context-badge-attention 2000ms linear 1";
      },
      true,
    );
    card.classList.toggle("cm-inlineCommentAgent", !!this.comment.origin);
    card.classList.toggle(
      "cm-inlineCommentUnplaced",
      !!this.comment.positionReset,
    );
    if (this.comment.isEditing) {
      card.classList.add("cm-inlineCommentCardEditing");
    }
    card.dataset.inlineCommentId = this.comment.id;
    if (this.actions.historyScope)
      card.dataset.fileHistoryScope = JSON.stringify(this.actions.historyScope);

    const header = this.createHeader();
    card.appendChild(header);

    const content = document.createElement("div");
    content.className = "cm-inlineCommentContent";
    const { body, editor } = this.createBody(view);
    header.appendChild(
      editor ? this.createEditControls(editor) : this.createControls(),
    );
    content.appendChild(body);
    card.appendChild(content);

    this.configureAttach(card);
    if (editor) this.scheduleEditorFocus(editor, view);

    return card;
  }

  updateDOM(
    card: HTMLElement,
    view: Pick<EditorView, "requestMeasure">,
  ): boolean {
    if (
      !card.classList.contains("cm-inlineCommentCard") ||
      card.dataset.inlineCommentId !== this.comment.id
    ) {
      return false;
    }
    if (inlineCommentLeaveCleanups.has(card)) return true;
    const currentEditor = card.querySelector<HTMLTextAreaElement>(
      ".cm-inlineCommentEditor",
    );
    if (
      this.comment.isEditing &&
      currentEditor &&
      card.classList.contains("cm-inlineCommentCardEditing")
    ) {
      const value = this.comment.draftText ?? this.comment.text;
      if (currentEditor.value !== value) {
        currentEditor.value = value;
        currentEditor.setSelectionRange(value.length, value.length);
        resizeInlineCommentTextarea(currentEditor);
      }
      const save = card.querySelector<HTMLButtonElement>(
        ".cm-inlineCommentSaveButton",
      );
      if (save) this.updateSaveButton(save, currentEditor);
      this.updateHeader(card);
      this.configureAttach(card);
      this.configureWidthControl(
        card.querySelector(".cm-inlineCommentControls"),
      );
      view.requestMeasure();
      return true;
    }

    // Assigning a number after the first save must not replace the returning
    // pill or interrupt the card transition when its content has not changed.
    if (
      !this.comment.isEditing &&
      !card.classList.contains("cm-inlineCommentCardEditing") &&
      card.querySelector(".cm-inlineCommentText")?.textContent ===
        this.comment.text
    ) {
      const updated = this.updateHeader(card);
      this.configureWidthControl(
        card.querySelector(".cm-inlineCommentControls"),
      );
      this.configureAttach(card);
      view.requestMeasure();
      return updated;
    }

    this.cleanupCardTransition(card);
    this.cleanupConfirmationReturn(card);

    const header = card.querySelector<HTMLElement>(".cm-inlineCommentHeader");
    const content = card.querySelector<HTMLElement>(".cm-inlineCommentContent");
    const previousBody = content?.firstElementChild;
    if (!header || !content || !(previousBody instanceof HTMLDivElement)) {
      return false;
    }

    // Measure the intact card: removing the header controls shrinks its height.
    const previousCardHeight = card.getBoundingClientRect().height;
    const previousBodyHeight = previousBody.getBoundingClientRect().height;
    const previousBackground = getComputedStyle(content).backgroundColor;

    const previousControls = header.querySelector<HTMLElement>(
      ".cm-inlineCommentControls",
    );
    if (previousControls) {
      this.cleanupDeleteConfirmation(previousControls);
      this.cleanupControlTransition(previousControls);
      previousControls.remove();
    }

    const wasEditing = card.classList.contains("cm-inlineCommentCardEditing");
    const isEditing = Boolean(this.comment.isEditing);
    const shouldAnimate = wasEditing !== isEditing && !prefersReducedMotion();

    if (!this.updateHeader(card)) return false;
    card.classList.toggle("cm-inlineCommentCardEditing", isEditing);

    const { body: nextBody, editor } = this.createBody(view);
    header.appendChild(
      editor
        ? this.createEditControls(editor, shouldAnimate)
        : this.createControls(shouldAnimate),
    );
    if (shouldAnimate) {
      nextBody.classList.add("cm-inlineCommentBodyEntering");
    }
    content.appendChild(nextBody);
    if (editor) resizeInlineCommentTextarea(editor);

    if (shouldAnimate) {
      const nextBodyHeight = nextBody.getBoundingClientRect().height;
      const nextBackground = getComputedStyle(content).backgroundColor;
      const nextCardHeight =
        previousCardHeight - previousBodyHeight + nextBodyHeight;
      this.startCardTransition(
        card,
        content,
        previousBody,
        nextBody,
        previousCardHeight,
        nextCardHeight,
        previousBackground,
        nextBackground,
        view,
      );
    } else {
      content.replaceChildren(nextBody);
    }

    this.configureAttach(card);
    if (editor) this.scheduleEditorFocus(editor, view);
    view.requestMeasure();
    return true;
  }

  private updateBadge(badge: HTMLElement): void {
    const label = commentLabel(this.comment);
    if (badge.textContent !== label) badge.textContent = label;
  }

  private updateTime(time: HTMLElement): void {
    let timestamp = time.querySelector<HTMLElement>(
      ".cm-inlineCommentTimestamp",
    );
    if (!timestamp) {
      timestamp = document.createElement("span");
      timestamp.className = "cm-inlineCommentTimestamp";
      time.appendChild(timestamp);
    }
    const label = formatCommentTime(this.comment.createdAt);
    if (timestamp.textContent !== label) timestamp.textContent = label;
    const hint = time.querySelector(".cm-inlineCommentPlacementHint");
    // Retain a previously used hint so placement can fade it out without timers.
    if (this.comment.positionReset && !hint) {
      const label = "Drag the marker to reattach to text.";
      const placementHint = document.createElement("span");
      placementHint.className = "cm-inlineCommentPlacementHint";
      placementHint.dataset.contextLabel = "true";
      placementHint.textContent = label;
      const glow = document.createElement("span");
      glow.dataset.contextGlow = "true";
      glow.setAttribute("aria-hidden", "true");
      glow.textContent = label;
      placementHint.appendChild(glow);
      time.appendChild(placementHint);
    }
  }

  private updateHeader(card: HTMLElement): boolean {
    const badge = card.querySelector<HTMLElement>(".cm-inlineCommentBadge");
    const time = card.querySelector<HTMLElement>(".cm-inlineCommentTime");
    if (!badge || !time) return false;
    this.updateBadge(badge);
    this.updateTime(time);
    const origin = card.querySelector<HTMLElement>(".cm-inlineCommentOrigin");
    if (origin && this.comment.origin) {
      renderDomHint(
        origin,
        this.originLabel(),
        `Created by ${this.comment.origin.provider}`,
      );
    }
    card.classList.toggle("cm-inlineCommentAgent", !!this.comment.origin);
    card.classList.toggle(
      "cm-inlineCommentUnplaced",
      !!this.comment.positionReset,
    );
    const controls = card.querySelector<HTMLDivElement>(
      ".cm-inlineCommentControls",
    );
    if (
      controls &&
      !this.comment.isEditing &&
      controls.dataset.unplaced !== String(Boolean(this.comment.positionReset))
    )
      this.renderControls(controls, false);
    return true;
  }

  private createHeader(): HTMLDivElement {
    const header = document.createElement("div");
    header.className = "cm-inlineCommentHeader";

    const badge = document.createElement("span");
    badge.className = "cm-inlineCommentBadge";
    this.updateBadge(badge);

    const time = document.createElement("div");
    time.className = "cm-inlineCommentTime";
    this.updateTime(time);

    const meta = document.createElement("div");
    meta.className = "cm-inlineCommentMeta";
    meta.appendChild(badge);
    meta.appendChild(time);
    if (this.comment.origin) {
      const origin = document.createElement("span");
      origin.className = "cm-inlineCommentOrigin";
      renderDomHint(
        origin,
        this.originLabel(),
        `Created by ${this.comment.origin.provider}`,
      );
      meta.appendChild(origin);
    }
    header.appendChild(meta);

    return header;
  }

  private originLabel(): string {
    return [
      this.comment.origin?.provider === "pi"
        ? piModelLabel(this.comment.origin.model ?? null)
        : this.comment.origin?.model?.trim() || "Agent",
      this.comment.origin?.thinkingEffort?.trim(),
    ]
      .filter(Boolean)
      .join(" · ");
  }

  private createBody(view: Pick<EditorView, "requestMeasure">): {
    body: HTMLDivElement;
    editor: HTMLTextAreaElement | null;
  } {
    if (this.comment.isEditing) {
      const editBody = document.createElement("div");
      editBody.className = "cm-inlineCommentEditBody";
      const editor = this.createTextarea({
        className: "cm-inlineCommentEditor",
        inputType: "comment",
        label: "Comment text",
        placeholder: "Write a comment...",
        value: this.comment.draftText ?? this.comment.text,
        onResize: () => view.requestMeasure(),
        onSubmit: (value) => this.saveComment(value),
      });
      editBody.appendChild(editor);
      return { body: editBody, editor };
    }

    const text = document.createElement("div");
    text.className = "cm-inlineCommentText";
    text.textContent = this.comment.text;

    const body = document.createElement("div");
    body.className = "cm-inlineCommentBody";
    body.appendChild(text);

    return { body, editor: null };
  }

  private isSaving(): boolean {
    const scope = this.actions.historyScope;
    return Boolean(scope && isCommentSaving(scope.root, this.comment.id));
  }

  private configureSaving(card: HTMLElement): void {
    inlineCommentSaveCleanups.get(card)?.();
    inlineCommentSaveCleanups.delete(card);
    const refresh = () => {
      const saving = this.isSaving();
      card.setAttribute("aria-busy", String(saving));
      const controls = card.querySelector<HTMLDivElement>(
        ".cm-inlineCommentControls",
      );
      // The outgoing textarea remains mounted during the read/edit animation.
      const editor = card.classList.contains("cm-inlineCommentCardEditing")
        ? card.querySelector<HTMLTextAreaElement>(".cm-inlineCommentEditor")
        : null;
      if (!controls) return;
      // A save in the other pane also cancels an open confirmation here.
      // Otherwise its outside-click handler could restore enabled controls.
      if (saving && inlineCommentDeleteConfirmationCleanups.has(controls)) {
        if (editor) this.renderEditControls(controls, editor, false);
        else this.renderControls(controls, false);
      }
      if (editor) {
        editor.readOnly = saving;
        const button = controls.querySelector<HTMLButtonElement>(
          ".cm-inlineCommentSaveButton",
        );
        if (button) {
          this.updateSaveButton(button, editor);
          button.style.display = saving ? "none" : "";
        }
      }
      if (saving) {
        if (!controls.querySelector(".cm-inlineCommentSaving")) {
          const status = document.createElement("span");
          status.className = "cm-inlineCommentSaving";
          status.setAttribute("role", "status");
          status.setAttribute("aria-label", "Saving comment");
          status.textContent = "Saving…";
          const slot = controls.querySelector(".cm-inlineCommentPrimarySlot");
          if (slot) {
            if (editor) slot.appendChild(status);
            else slot.replaceChildren(status);
          } else controls.appendChild(this.createPrimarySlot(status));
          this.startControlsTransition(controls, true);
        }
      } else if (controls.querySelector(".cm-inlineCommentSaving")) {
        if (editor) controls.querySelector(".cm-inlineCommentSaving")?.remove();
        else this.renderControls(controls, false);
        this.startControlsTransition(controls, true);
      }
      for (const button of controls.querySelectorAll<HTMLButtonElement>(
        "button",
      )) {
        if (
          ["full-width", "copy"].includes(
            button.dataset.inlineCommentAction ?? "",
          )
        )
          continue;
        if (button.classList.contains("cm-inlineCommentSaveButton") && editor)
          continue;
        button.disabled = saving;
      }
    };
    const scope = this.actions.historyScope;
    if (scope)
      inlineCommentSaveCleanups.set(
        card,
        subscribeCommentSaving(scope.root, this.comment.id, refresh),
      );
    refresh();
  }

  private configureAttach(card: HTMLElement): void {
    this.configureSaving(card);
    this.configureCopy(card);
    this.configureWidthControl(card.querySelector(".cm-inlineCommentControls"));
    const attach = !this.comment.isEditing && this.actions.onAttach;
    let button = card.querySelector<HTMLButtonElement>(
      ".cm-inlineCommentAttach",
    );
    const selected = Boolean(
      attach && this.actions.selectedCommentIds?.includes(this.comment.id),
    );
    card.classList.toggle("cm-inlineCommentSelectable", Boolean(attach));
    card.classList.toggle("cm-inlineCommentSelected", selected);
    if (!attach) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "cm-inlineCommentAttach";
      card.appendChild(button);
    }
    button.setAttribute(
      "aria-label",
      `Add comment ${commentLabel(this.comment)} to chat`,
    );
    button.setAttribute("aria-pressed", String(selected));
    button.onmousedown = stopEditorMouseEvent;
    button.onclick = (event) => {
      event.stopPropagation();
      attach(this.comment);
    };
  }

  private configureCopy(card: HTMLElement): void {
    const controls = card.querySelector<HTMLElement>(
      ".cm-inlineCommentControls",
    );
    if (!controls) return;
    const place = (button: HTMLButtonElement) => {
      const trash = controls.querySelector(
        '[data-inline-comment-action="delete"]',
      );
      if (trash) {
        if (button.nextElementSibling !== trash)
          controls.insertBefore(button, trash);
      } else if (button.parentElement !== controls) controls.prepend(button);
    };
    const existing = inlineCommentCopyState.get(card);
    if (existing) {
      place(existing.button);
      return;
    }
    let disposed = false;
    let request = 0;
    let timer: number | undefined;
    const readText = () =>
      card.classList.contains("cm-inlineCommentCardEditing")
        ? (card.querySelector<HTMLTextAreaElement>(".cm-inlineCommentEditor")
            ?.value ?? "")
        : (card.querySelector(".cm-inlineCommentText")?.textContent ?? "");
    const reset = () => {
      button.setAttribute("aria-label", "Copy comment text");
      button.replaceChildren(createInlineCommentIcon("copy"));
    };
    const button = this.createButton(
      "copy",
      "copy",
      "Copy comment text",
      async () => {
        button.focus({ preventScroll: true });
        const currentRequest = ++request;
        const text = readText();
        window.clearTimeout(timer);
        try {
          await navigator.clipboard.writeText(text);
          if (disposed || currentRequest !== request || !card.isConnected)
            return;
          if (readText() !== text) {
            reset();
            return;
          }
          button.setAttribute("aria-label", "Copied comment text");
          button.replaceChildren(createInlineCommentIcon("check"));
        } catch {
          if (disposed || currentRequest !== request || !card.isConnected)
            return;
          button.setAttribute("aria-label", "Copy failed — try again");
          button.replaceChildren(createInlineCommentIcon("copy"));
          toast.error("Could not copy comment. Try again.");
        }
        timer = window.setTimeout(reset, 2000);
      },
    );
    button.classList.add("cm-inlineCommentCopyButton");
    place(button);
    inlineCommentCopyState.set(card, {
      button,
      dispose: () => {
        disposed = true;
        window.clearTimeout(timer);
      },
    });
  }

  private scheduleEditorFocus(
    editor: HTMLTextAreaElement,
    view: Pick<EditorView, "requestMeasure">,
  ): void {
    requestAnimationFrame(() => {
      resizeInlineCommentTextarea(editor);
      view.requestMeasure();
      editor.focus();
    });
  }

  private startCardTransition(
    card: HTMLElement,
    content: HTMLElement,
    previousBody: HTMLDivElement,
    nextBody: HTMLDivElement,
    previousHeight: number,
    nextHeight: number,
    previousBackground: string,
    nextBackground: string,
    view: Pick<EditorView, "requestMeasure">,
  ): void {
    previousBody.classList.add("cm-inlineCommentBodyLeaving");
    previousBody.setAttribute("aria-hidden", "true");
    previousBody.setAttribute("inert", "");

    const backgroundWipe = document.createElement("div");
    backgroundWipe.className = "cm-inlineCommentBackgroundWipe";
    backgroundWipe.style.backgroundColor = nextBackground;
    content.style.backgroundColor = previousBackground;
    content.prepend(backgroundWipe);

    card.classList.add("cm-inlineCommentCardTransitioning");
    card.style.height = `${previousHeight}px`;

    let finished = false;
    let frame = 0;
    let timeout = 0;

    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
      card.removeEventListener("transitionend", handleTransitionEnd);
      nextBody.classList.remove("cm-inlineCommentBodyEntering");
      // Keep the new body attached so finishing the animation does not blur
      // its focused textarea.
      previousBody.remove();
      backgroundWipe.remove();
      content.style.backgroundColor = "";
      card.classList.remove("cm-inlineCommentCardTransitioning");
      card.style.height = "";
      inlineCommentCardTransitionCleanups.delete(card);
      view.requestMeasure();
    };

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === card && event.propertyName === "height") finish();
    };

    card.addEventListener("transitionend", handleTransitionEnd);
    inlineCommentCardTransitionCleanups.set(card, finish);

    // Commit the entering/leaving start styles before advancing to their
    // final state on the next frame.
    void card.offsetHeight;
    frame = requestAnimationFrame(() => {
      nextBody.classList.remove("cm-inlineCommentBodyEntering");
      backgroundWipe.classList.add("cm-inlineCommentBackgroundWipeActive");
      card.style.height = `${nextHeight}px`;
      view.requestMeasure();
    });
    timeout = window.setTimeout(
      finish,
      INLINE_COMMENT_CARD_TRANSITION_DURATION_MS + 80,
    );
  }

  private cleanupCardTransition(card: HTMLElement): void {
    inlineCommentCardTransitionCleanups.get(card)?.();
  }

  destroy(dom: HTMLElement): void {
    inlineCommentCopyState.get(dom)?.dispose();
    inlineCommentCopyState.delete(dom);
    inlineCommentSaveCleanups.get(dom)?.();
    inlineCommentSaveCleanups.delete(dom);
    const origin = dom.querySelector<HTMLElement>(".cm-inlineCommentOrigin");
    if (origin) destroyDomHint(origin);
    inlineCommentLeaveCleanups.get(dom)?.();
    this.cleanupCardTransition(dom);
    this.cleanupConfirmationReturn(dom);
    for (const controls of dom.querySelectorAll<HTMLElement>(
      ".cm-inlineCommentControls",
    )) {
      this.cleanupDeleteConfirmation(controls);
      this.cleanupControlTransition(controls);
    }
  }

  private clearControls(controls: HTMLElement): void {
    for (const child of Array.from(controls.children)) {
      if (!child.classList.contains("cm-inlineCommentCopyButton"))
        child.remove();
    }
  }

  private createControls(animate = false): HTMLDivElement {
    const controls = document.createElement("div");
    controls.className = "cm-inlineCommentControls";
    this.renderControls(controls, false);
    if (animate) this.startControlsTransition(controls, true);
    return controls;
  }

  private configureWidthControl(controls: HTMLElement | null): void {
    if (!controls) return;
    const card = controls.closest<HTMLElement>(".cm-inlineCommentCard");
    if (!card) return;
    this.configureCopy(card);
    const group = card.querySelector(".cm-inlineCommentMeta") ?? controls;
    let button = card.querySelector<HTMLButtonElement>(
      '[data-inline-comment-action="full-width"]',
    );
    if (!this.actions.onToggleFullWidth) {
      button?.remove();
      return;
    }
    if (!button) {
      button = this.createButton(
        "full-width",
        "expand",
        "Full comment width",
        () => {},
      );
      button.title = "Full comment width";
      button.classList.add("cm-inlineCommentFullWidthButton");
    }
    if (button.parentElement !== group) group.appendChild(button);
    button.setAttribute(
      "aria-pressed",
      String(Boolean(this.actions.fullWidth)),
    );
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.actions.onToggleFullWidth?.();
    };
  }

  private createPrimarySlot(control: HTMLElement): HTMLDivElement {
    const slot = document.createElement("div");
    slot.className = "cm-inlineCommentPrimarySlot";
    slot.appendChild(control);
    return slot;
  }

  private renderControls(controls: HTMLDivElement, animate = true): void {
    this.cleanupDeleteConfirmation(controls);
    controls.classList.remove(
      "cm-inlineCommentControlsConfirmingDelete",
      "cm-inlineCommentControlsConfirmingResolve",
    );
    this.clearControls(controls);
    controls.dataset.unplaced = String(Boolean(this.comment.positionReset));
    const primaryGroup = document.createElement("div");
    primaryGroup.className = "cm-inlineCommentPrimaryControls";
    if (this.comment.positionReset && !this.comment.isEditing) {
      const status = document.createElement("span");
      status.className = "cm-inlineCommentPlacementStatus";
      status.textContent = "Lost";
      controls.appendChild(this.createPrimarySlot(status));
    }
    if (
      this.actions.onEdit &&
      !this.comment.isEditing &&
      !this.comment.positionReset
    ) {
      primaryGroup.appendChild(
        this.createButton("edit", "edit", "Edit comment", () => {
          this.actions.onEdit?.(this.comment.id);
        }),
      );
    }
    if (
      this.actions.onResolve &&
      !this.comment.isEditing &&
      !this.comment.positionReset
    ) {
      primaryGroup.appendChild(
        this.createButton("resolve", "check", "Resolve comment", () => {
          this.showDeleteConfirmation(
            controls,
            () => this.renderControls(controls),
            "resolve",
          );
        }),
      );
    }
    if (primaryGroup.childElementCount) {
      controls.appendChild(this.createPrimarySlot(primaryGroup));
    }
    if (this.actions.onDelete) {
      const deleteButton = this.createButton(
        "delete",
        "trash",
        "Delete comment",
        () => {
          this.showDeleteConfirmation(controls, () =>
            this.renderControls(controls),
          );
        },
      );
      const copy = controls.querySelector(".cm-inlineCommentCopyButton");
      if (copy) copy.after(deleteButton);
      else controls.prepend(deleteButton);
    }
    this.configureWidthControl(controls);
    if (animate) this.startControlsTransition(controls);
  }

  private saveComment(text: string) {
    if (this.isSaving()) return;
    this.actions.onSave?.(this.comment.id, text);
    if (this.actions.historyScope)
      closeCommentDraft(this.actions.historyScope, this.comment.id);
  }

  private createEditControls(
    editor: HTMLTextAreaElement,
    animate = true,
  ): HTMLDivElement {
    const controls = document.createElement("div");
    controls.className = "cm-inlineCommentControls";
    this.renderEditControls(controls, editor, false);
    if (animate) this.startControlsTransition(controls, true);
    editor.addEventListener("input", () => {
      const button = controls.querySelector<HTMLButtonElement>(
        ".cm-inlineCommentSaveButton",
      );
      if (button) this.updateSaveButton(button, editor);
    });
    return controls;
  }

  private canCancelDraft(): boolean {
    // The model retains the saved text while the textarea holds local edits.
    return (
      !this.comment.origin &&
      this.comment.number == null &&
      !this.comment.text.trim() &&
      !!this.actions.onDelete
    );
  }

  private updateSaveButton(
    button: HTMLButtonElement,
    editor: HTMLTextAreaElement,
  ): void {
    const empty = !editor.value.trim();
    const cancel = empty && this.canCancelDraft();
    const action = cancel ? "cancel" : "save";
    const label = this.isSaving() ? "Saving…" : cancel ? "Cancel" : "Save";
    button.disabled = this.isSaving() || (empty && !cancel);
    button.dataset.inlineCommentAction = action;
    button.setAttribute(
      "aria-label",
      this.isSaving() ? "Saving comment" : `${label} comment`,
    );
    if (button.textContent !== label) {
      button.replaceChildren(label);
    }
  }

  private renderEditControls(
    controls: HTMLDivElement,
    editor: HTMLTextAreaElement,
    animate = true,
  ): void {
    this.cleanupDeleteConfirmation(controls);
    controls.classList.remove(
      "cm-inlineCommentControlsConfirmingDelete",
      "cm-inlineCommentControlsConfirmingResolve",
    );
    this.clearControls(controls);

    if (this.actions.onSave) {
      const saveButton = this.createButton("save", null, "Save comment", () => {
        if (editor.value.trim()) {
          this.saveComment(editor.value);
        } else if (this.canCancelDraft()) {
          this.leaveCard(controls.closest(".cm-inlineCommentCard"), () => {
            (this.actions.onCancel ?? this.actions.onDelete)?.(this.comment.id);
          });
        }
      });
      saveButton.classList.add("cm-inlineCommentSaveButton");
      this.updateSaveButton(saveButton, editor);
      controls.appendChild(this.createPrimarySlot(saveButton));
    }
    if (this.actions.onDelete) {
      const deleteButton = this.createButton(
        "delete",
        "trash",
        "Delete comment",
        () => {
          this.showDeleteConfirmation(controls, () =>
            this.renderEditControls(controls, editor),
          );
        },
      );
      const copy = controls.querySelector(".cm-inlineCommentCopyButton");
      if (copy) copy.after(deleteButton);
      else controls.prepend(deleteButton);
    }
    this.configureWidthControl(controls);
    if (animate) this.startControlsTransition(controls);
  }

  private showDeleteConfirmation(
    controls: HTMLDivElement,
    restoreControls: () => void,
    action: "delete" | "resolve" = "delete",
  ): void {
    this.cleanupDeleteConfirmation(controls);
    const card = controls.closest<HTMLElement>(".cm-inlineCommentCard");
    if (card) {
      this.cleanupCardTransition(card);
      this.cleanupConfirmationReturn(card);
      card.dataset.confirmAction = action;
    }
    controls.classList.add(
      action === "resolve"
        ? "cm-inlineCommentControlsConfirmingResolve"
        : "cm-inlineCommentControlsConfirmingDelete",
    );

    const confirmButton = document.createElement("button");
    confirmButton.type = "button";
    confirmButton.className = "cm-inlineCommentDeleteConfirm";
    confirmButton.dataset.inlineCommentAction = `confirm-${action}`;
    confirmButton.setAttribute("aria-label", `Confirm ${action} comment`);
    confirmButton.textContent = action === "resolve" ? "Resolve" : "Delete";
    confirmButton.addEventListener("mousedown", stopEditorMouseEvent);
    confirmButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.isSaving()) return;
      if (card && inlineCommentLeaveCleanups.has(card)) return;
      this.cleanupDeleteConfirmation(controls);
      const commit = () => {
        if (action === "resolve") this.actions.onResolve?.(this.comment.id);
        else this.actions.onDelete?.(this.comment.id);
      };
      // Keep the confirmed color while the entire card wipes away.
      if (card) card.dataset.confirmAction = action;
      this.leaveCard(card, commit);
    });

    const cancelConfirmation = () => {
      if (card && !prefersReducedMotion()) {
        card.dataset.confirmReturning = action;
        const timer = window.setTimeout(
          () => this.cleanupConfirmationReturn(card),
          INLINE_COMMENT_CARD_TRANSITION_DURATION_MS,
        );
        inlineCommentConfirmationReturnTimers.set(card, timer);
      }
      restoreControls();
    };
    const cancelButton = this.createButton(
      "cancel",
      "undo",
      `Cancel ${action}`,
      cancelConfirmation,
    );
    this.clearControls(controls);
    controls.append(cancelButton, confirmButton);
    this.startControlsTransition(controls);

    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && controls.contains(target)) return;
      cancelConfirmation();
    };
    document.addEventListener("click", handleDocumentClick, true);
    inlineCommentDeleteConfirmationCleanups.set(controls, () => {
      if (card) delete card.dataset.confirmAction;
      document.removeEventListener("click", handleDocumentClick, true);
      inlineCommentDeleteConfirmationCleanups.delete(controls);
    });
  }

  private leaveCard(card: HTMLElement | null, commit: () => void): void {
    if (card && inlineCommentLeaveCleanups.has(card)) return;
    if (card) {
      this.cleanupCardTransition(card);
      this.cleanupConfirmationReturn(card);
    }
    if (!card || prefersReducedMotion() || typeof card.animate !== "function") {
      commit();
      return;
    }
    card.inert = true;
    const animation = card.animate(
      [{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }],
      {
        duration: INLINE_COMMENT_LEAVE_DURATION_MS,
        easing: "linear",
        fill: "forwards",
      },
    );
    const highlightAnimations: Animation[] = [];
    const editorRoot = card.closest(".cm-editor");
    for (const element of editorRoot?.querySelectorAll<HTMLElement>(
      ".cm-inlineCommentMark, .cm-inlineCommentSuperscript",
    ) ?? []) {
      if (
        element.dataset.inlineCommentId !== this.comment.id ||
        typeof element.animate !== "function"
      )
        continue;
      const style = getComputedStyle(element);
      const keyframes = element.classList.contains("cm-inlineCommentMark")
        ? [
            {
              backgroundColor: style.backgroundColor,
              borderBottomColor: style.borderBottomColor,
            },
            {
              backgroundColor: "transparent",
              borderBottomColor: "transparent",
            },
          ]
        : [{ opacity: 1 }, { opacity: 0 }];
      const fade = element.animate(keyframes, {
        duration: INLINE_COMMENT_LEAVE_DURATION_MS,
        easing: "linear",
        fill: "forwards",
      });
      if (animation.startTime != null) fade.startTime = animation.startTime;
      highlightAnimations.push(fade);
    }
    const cleanup = () => {
      animation.onfinish = null;
      animation.cancel();
      for (const fade of highlightAnimations) fade.cancel();
      card.inert = false;
      delete card.dataset.confirmAction;
      inlineCommentLeaveCleanups.delete(card);
    };
    inlineCommentLeaveCleanups.set(card, cleanup);
    animation.onfinish = () => {
      animation.onfinish = null;
      try {
        commit();
        // React removes the widget asynchronously. Keep the final clipped
        // frame until destroy() so the original card cannot flash back.
      } catch (error) {
        cleanup();
        throw error;
      }
    };
  }

  private cleanupDeleteConfirmation(controls: HTMLElement): void {
    inlineCommentDeleteConfirmationCleanups.get(controls)?.();
  }

  private cleanupConfirmationReturn(card: HTMLElement): void {
    const timer = inlineCommentConfirmationReturnTimers.get(card);
    if (timer !== undefined) window.clearTimeout(timer);
    inlineCommentConfirmationReturnTimers.delete(card);
    delete card.dataset.confirmReturning;
  }

  private startControlsTransition(
    controls: HTMLElement,
    primaryOnly = false,
  ): void {
    this.cleanupControlTransition(controls);
    if (prefersReducedMotion()) return;
    const className = primaryOnly
      ? "cm-inlineCommentControlsTransitioningPrimary"
      : "cm-inlineCommentControlsTransitioning";
    controls.classList.add(className);
    const frame = requestAnimationFrame(() => {
      inlineCommentControlTransitionFrames.delete(controls);
      // Commit the entering style after newly created controls are attached.
      void controls.offsetWidth;
      controls.classList.remove(className);
    });
    inlineCommentControlTransitionFrames.set(controls, frame);
  }

  private cleanupControlTransition(controls: HTMLElement): void {
    const frame = inlineCommentControlTransitionFrames.get(controls);
    if (frame !== undefined) {
      cancelAnimationFrame(frame);
      inlineCommentControlTransitionFrames.delete(controls);
    }
    controls.classList.remove(
      "cm-inlineCommentControlsTransitioning",
      "cm-inlineCommentControlsTransitioningPrimary",
    );
  }

  private createButton(
    action: string,
    iconName: InlineCommentIconName | null,
    ariaLabel: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-inlineCommentButton";
    button.dataset.inlineCommentAction = action;
    button.setAttribute("aria-label", ariaLabel);
    if (iconName) button.appendChild(createInlineCommentIcon(iconName));
    button.addEventListener("mousedown", stopEditorMouseEvent);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (action !== "full-width" && action !== "copy" && this.isSaving())
        return;
      onClick();
    });
    return button;
  }

  private createTextarea({
    className,
    inputType,
    label,
    placeholder,
    value,
    onResize,
    onSubmit,
  }: {
    className: string;
    inputType: string;
    label: string;
    placeholder: string;
    value: string;
    onResize?: () => void;
    onSubmit: (value: string, textarea: HTMLTextAreaElement) => void;
  }): HTMLTextAreaElement {
    const textarea = document.createElement("textarea");
    textarea.className = className;
    textarea.dataset.inlineCommentInput = inputType;
    textarea.setAttribute("aria-label", label);
    textarea.placeholder = placeholder;
    textarea.rows = 1;
    textarea.defaultValue = value;
    textarea.value = value;
    textarea.wrap = "soft";
    textarea.addEventListener("mousedown", stopEditorEvent);
    textarea.addEventListener("click", stopEditorEvent);
    textarea.addEventListener("blur", breakCommentTypingGroup);
    textarea.addEventListener("input", () => {
      if (this.actions.historyScope)
        typeCommentDraft(
          this.actions.historyScope,
          this.comment,
          textarea.value,
        );
      resizeInlineCommentTextarea(textarea);
      onResize?.();
    });
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (this.isSaving()) {
        if (event.key === "Enter") event.preventDefault();
        return;
      }
      if (
        isComposingKey(event) ||
        event.defaultPrevented ||
        event.key !== "Enter"
      )
        return;
      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        insertTextareaNewline(textarea);
        return;
      }
      event.preventDefault();
      const trimmed = textarea.value.trim();
      if (trimmed) onSubmit(trimmed, textarea);
    });
    return textarea;
  }
}

class InlineCommentSuperscriptWidget extends WidgetType {
  constructor(
    readonly commentId: string,
    readonly label: string,
    readonly agent: boolean,
  ) {
    super();
  }

  eq(other: InlineCommentSuperscriptWidget): boolean {
    return (
      other.commentId === this.commentId &&
      other.label === this.label &&
      other.agent === this.agent
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-inlineCommentSuperscript";
    button.classList.toggle("cm-inlineCommentAgentSuperscript", this.agent);
    button.textContent = this.label;
    button.dataset.inlineCommentId = this.commentId;
    button.setAttribute("aria-label", `Scroll to comment ${this.label}`);
    button.addEventListener("mousedown", stopEditorMouseEvent);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      centerInlineCommentCard(view, this.commentId);
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function stopEditorMouseEvent(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
}

function stopEditorEvent(event: Event): void {
  event.stopPropagation();
}

function resizeInlineCommentTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = "auto";
  textarea.style.height = `${textarea.scrollHeight}px`;
}

function createInlineCommentIcon(
  iconName: InlineCommentIconName,
): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.classList.add("cm-inlineCommentIcon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("focusable", "false");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("viewBox", "0 0 24 24");

  if (iconName === "copy") {
    // Lucide Copy's rounded rectangle, alongside its path below.
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    for (const [key, value] of Object.entries({
      width: "14",
      height: "14",
      x: "8",
      y: "8",
      rx: "2",
      ry: "2",
    }))
      rect.setAttribute(key, value);
    icon.appendChild(rect);
  }
  for (const pathData of INLINE_COMMENT_ICON_PATHS[iconName]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    icon.appendChild(path);
  }

  return icon;
}

function insertTextareaNewline(textarea: HTMLTextAreaElement): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const nextValue = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`;
  textarea.value = nextValue;
  textarea.selectionStart = start + 1;
  textarea.selectionEnd = start + 1;
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function formatCommentTime(createdAt?: string): string {
  if (!createdAt) return "Just now";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function centerInlineCommentCard(view: EditorView, commentId: string): boolean {
  const card = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".cm-inlineCommentCard"),
  ).find((candidate) => candidate.dataset.inlineCommentId === commentId);
  if (!card) return false;

  const scroll = view.scrollDOM;
  const scrollRect = scroll.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  const delta =
    cardRect.top +
    cardRect.height / 2 -
    (scrollRect.top + scrollRect.height / 2);
  scroll.scrollTop = Math.max(
    0,
    Math.min(maxScrollTop, scroll.scrollTop + delta),
  );
  return true;
}

function clampOffset(offset: number, max: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(Math.trunc(offset), max));
}

export function isInlineCommentRangeAllowed(
  docLength: number,
  selectionStart: number,
  selectionEnd: number,
): boolean {
  if (!Number.isFinite(docLength) || docLength <= 0) return false;

  const max = Math.trunc(docLength);
  const start = clampOffset(Math.min(selectionStart, selectionEnd), max);
  const end = clampOffset(Math.max(selectionStart, selectionEnd), max);
  const length = end - start;

  if (length <= 0) return false;
  if (length >= max) return false;
  return length <= MAX_INLINE_COMMENT_SELECTION_LENGTH;
}

export function normalizeInlineCommentRange(
  doc: string,
  selectionStart: number,
  selectionEnd: number,
): NormalizedInlineCommentRange | null {
  const max = doc.length;
  const start = clampOffset(Math.min(selectionStart, selectionEnd), max);
  const end = clampOffset(Math.max(selectionStart, selectionEnd), max);

  if (start === end) return null;

  const state = EditorState.create({ doc });
  const endLine = state.doc.lineAt(Math.max(start, end - 1));

  return {
    from: start,
    to: end,
    line: endLine.number,
  };
}

function buildInlineCommentDecorations(
  state: EditorState,
  comments: InlineEditorComment[],
  actions: InlineCommentActions,
  preview?: { id: string; range: CommentRange } | null,
): DecorationSet {
  if (comments.length === 0 || actions.hidden) return Decoration.none;

  const renderModels = getInlineCommentRenderModels(state, comments);
  if (renderModels.length === 0) return Decoration.none;

  const decorations = renderModels.flatMap(
    ({ comment, displayIndex, from, lineEnd, text, to }) => [
      ...((
        preview?.id === comment.id
          ? preview.range.from < preview.range.to
          : from < to
      )
        ? [
            Decoration.mark({
              class: comment.origin
                ? "cm-inlineCommentMark cm-inlineCommentAgentMark"
                : "cm-inlineCommentMark",
              attributes: { "data-inline-comment-id": comment.id },
            }).range(
              preview?.id === comment.id ? preview.range.from : from,
              preview?.id === comment.id ? preview.range.to : to,
            ),
          ]
        : []),
      ...(from < to
        ? [
            Decoration.widget({
              widget: new InlineCommentSuperscriptWidget(
                comment.id,
                commentLabel(comment),
                !!comment.origin,
              ),
              side: 1,
            }).range(to),
          ]
        : []),
      Decoration.widget({
        widget: new InlineCommentCardWidget(
          { ...comment, text },
          displayIndex,
          actions,
        ),
        side: 10 + displayIndex,
      }).range(lineEnd),
    ],
  );

  return Decoration.set(decorations, true);
}

function getInlineCommentRenderModels(
  state: EditorState,
  comments: InlineEditorComment[],
): InlineCommentRenderModel[] {
  const validComments = comments.flatMap((comment) => {
    if (comment.resolved) return [];
    const from = clampOffset(comment.from, state.doc.length);
    const to = clampOffset(comment.to, state.doc.length);
    const text = comment.isEditing ? comment.text : comment.text.trim();
    if (from > to || (!text && !comment.isEditing)) return [];

    const lineAnchor = from < to ? Math.max(from, to - 1) : from;
    const line = state.doc.lineAt(lineAnchor);
    return [
      {
        comment,
        from,
        lineEnd: line.to,
        lineNumber: line.number,
        text,
        to,
      },
    ];
  });

  const byLine = new Map<number, typeof validComments>();
  for (const validComment of validComments) {
    const lineComments = byLine.get(validComment.lineNumber) ?? [];
    lineComments.push(validComment);
    byLine.set(validComment.lineNumber, lineComments);
  }

  return Array.from(byLine.values()).flatMap((lineComments) =>
    lineComments
      .sort(
        (a, b) =>
          a.from - b.from ||
          a.to - b.to ||
          a.comment.id.localeCompare(b.comment.id),
      )
      .map(({ lineNumber: _lineNumber, ...validComment }, index) => ({
        ...validComment,
        displayIndex: index + 1,
      })),
  );
}

export {
  resetCommentPosition,
  mapDocumentComments as mapInlineCommentsThroughChanges,
} from "./comment-document-model";

export const updateInlineCommentsEffect = StateEffect.define<{
  comments: InlineEditorComment[];
  actions?: InlineCommentActions;
}>();

type CommentState = {
  document: CommentDocument;
  actions: InlineCommentActions;
  decorations: DecorationSet;
};
const commentDocument = Facet.define<CommentState, CommentState | null>({
  combine: (values) => values[0] ?? null,
});

export function readCommentDocument(state: EditorState) {
  return state.facet(commentDocument)?.document ?? null;
}

/** Consume the transaction's authoritative anchor result. Only comments that
 * arrived after its input snapshot need an additional operation application. */
export function commentsAfterEditorUpdate(
  comments: InlineEditorComment[],
  changes: ChangeDesc,
  after: EditorState,
  before: EditorState,
): InlineEditorComment[] {
  const start = before.facet(commentDocument);
  const next = after.facet(commentDocument);
  if (!start || !next)
    return mapInlineCommentsThroughChanges(comments, changes, after, before);
  const previous = new Map(start.document.comments.map((c) => [c.id, c]));
  const mapped = new Map(next.document.comments.map((c) => [c.id, c]));
  const pending = comments.filter((c) => {
    const input = previous.get(c.id);
    return !input || !sameCommentAnchor(input, c) || !mapped.has(c.id);
  });
  for (const comment of mapInlineCommentsThroughChanges(
    pending,
    changes,
    after,
    before,
  ))
    mapped.set(comment.id, comment);
  return comments.map((comment) => {
    const result = mapped.get(comment.id)!;
    if (sameCommentAnchor(comment, result) && comment.line === result.line)
      return comment;
    return {
      ...comment,
      from: result.from,
      to: result.to,
      line: result.line,
      positionReset: result.positionReset,
      removedAnchor: result.removedAnchor,
    };
  });
}

export function createInlineCommentExtension(
  comments: InlineEditorComment[],
  actions: InlineCommentActions = {},
): Extension {
  // One extension/handle overlay for this editor lifetime. React publishes
  // metadata through an effect; typing maps existing decoration ranges first.
  let readCurrent: () => {
    comments: InlineEditorComment[];
    actions: InlineCommentActions;
  } = () => ({
    comments,
    actions,
  });
  const forwardedActions = (
    value: InlineCommentActions,
  ): InlineCommentActions => ({
    ...value,
    onAttach: value.onAttach
      ? (comment) => {
          const current = readCurrent().comments.find(
            (item) => item.id === comment.id,
          );
          if (current) readCurrent().actions.onAttach?.(current);
        }
      : undefined,
    onSave: value.onSave
      ? (id, text) => readCurrent().actions.onSave?.(id, text)
      : undefined,
    onResize: value.onResize
      ? (id, range) => readCurrent().actions.onResize?.(id, range)
      : undefined,
    onResolve: value.onResolve
      ? (id) => readCurrent().actions.onResolve?.(id)
      : undefined,
    onEdit: value.onEdit
      ? (id) => readCurrent().actions.onEdit?.(id)
      : undefined,
    onDelete: value.onDelete
      ? (id) => readCurrent().actions.onDelete?.(id)
      : undefined,
    onCancel: value.onCancel
      ? (id) => readCurrent().actions.onCancel?.(id)
      : undefined,
    onToggleFullWidth: value.onToggleFullWidth
      ? () => readCurrent().actions.onToggleFullWidth?.()
      : undefined,
  });
  const commentState = StateField.define<CommentState>({
    create(state) {
      const document = CommentDocument.open(state, comments);
      const initial = document.comments;
      return {
        document,
        actions,
        decorations: buildInlineCommentDecorations(
          state,
          initial,
          forwardedActions(actions),
        ),
      };
    },
    update(value, transaction) {
      let { document, actions, decorations } = value;
      let comments = document.comments;
      if (transaction.docChanged) {
        try {
          document = document.apply(transaction.changes, transaction.state);
          comments = document.comments;
        } catch {
          // Metadata recovery must never reject the manuscript transaction.
          const text = transaction.newDoc.toString();
          document = CommentDocument.open(
            transaction.state,
            comments.map((comment) => resetCommentPosition(comment, text)),
          );
          comments = document.comments;
        }
        decorations = decorations.map(transaction.changes);
      }
      let changed = false;
      let restores: AnchorInverse[] = [];
      const restore = () => {
        if (!restores.length) return;
        document = applyCommentAnchorRestores(
          document,
          restores,
          value.document,
          transaction,
        );
        comments = document.comments;
        changed = true;
        restores = [];
      };
      for (const effect of transaction.effects) {
        if (effect.is(restoreCommentAnchors)) restores.push(effect.value);
        if (effect.is(updateInlineCommentsEffect)) {
          restore();
          document = document.withComments(effect.value.comments);
          comments = document.comments;
          actions = effect.value.actions ?? actions;
          changed = true;
        }
      }
      restore();
      const preview = transaction.effects.find((effect) =>
        effect.is(commentRangePreviewEffect),
      );
      if (changed || preview)
        decorations = buildInlineCommentDecorations(
          transaction.state,
          comments,
          forwardedActions(actions),
          preview?.value,
        );
      return document === value.document &&
        actions === value.actions &&
        decorations === value.decorations
        ? value
        : { document, actions, decorations };
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      commentDocument.from(field),
    ],
  });
  return [
    commentState,
    commentAnchorHistory(
      (state) => state.facet(commentDocument)?.document ?? null,
    ),
    ViewPlugin.define((view) => {
      readCurrent = () => {
        const value = view.state.field(commentState);
        return { comments: value.document.comments, actions: value.actions };
      };
      return {};
    }),
    commentRangeExtension(() => {
      const value = readCurrent();
      return {
        ...value,
        comments: value.actions.hidden
          ? []
          : value.comments.filter((c) => !c.resolved),
      };
    }),
    inlineCommentTheme,
  ];
}

export const inlineCommentStyles = {
  ".cm-inlineCommentCard:focus": {
    outline: "none",
  },
  ".cm-inlineCommentMark": {
    backgroundColor:
      "color-mix(in oklab, var(--color-amber-300) 25%, transparent)",
    borderBottom:
      "2px solid color-mix(in oklab, var(--color-amber-500) 70%, transparent)",
  },
  ".cm-inlineCommentSuperscript": {
    background: "#ca8a04",
    border: "0",
    borderRadius: "999px",
    color: "#fffbeb",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-sans)",
    fontSize: "9px",
    fontWeight: "800",
    height: "14px",
    lineHeight: "1",
    margin: "0 1px 0 2px",
    position: "relative",
    top: "-0.45em",
    verticalAlign: "baseline",
    minWidth: "14px",
    padding: "0 4px",
  },
  ".cm-inlineCommentSuperscript:hover": {
    background: "#a16207",
  },
  ".cm-inlineCommentCard": {
    position: "relative",
    isolation: "isolate",
    boxSizing: "border-box",
    overflow: "hidden",
    width: "calc(100% + 10px)",
    margin: "6px 0 10px -10px",
    borderRadius: "12px",
    background: "#eab308",
    "--comment-pill-active-background": "#fffbeb",
    "--comment-pill-active-color": "#ca8a04",
    "--comment-selection-stroke":
      "color-mix(in oklch, #854d0e 18%, #eab308 82%)",
    "--comment-control-background":
      "color-mix(in oklch, #854d0e 18%, #eab308 82%)",
    boxShadow: "none",
    transition: "box-shadow 160ms ease-out",
    color: "#fff7ed",
    padding: "12px 10px 0",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    lineHeight: "1.4",
    whiteSpace: "pre-wrap",
  },
  ".cm-inlineCommentAttach": {
    position: "absolute",
    inset: "0",
    zIndex: "2",
    width: "100%",
    height: "100%",
    padding: "0",
    border: "0",
    borderRadius: "inherit",
    background: "transparent",
    cursor: "pointer",
  },
  ".cm-inlineCommentCard::after": {
    content: '""',
    position: "absolute",
    inset: "0",
    borderRadius: "inherit",
    zIndex: "4",
    pointerEvents: "none",
    boxShadow: "inset 0 0 0 2px transparent",
    transition: "box-shadow 160ms ease-out",
  },
  ".cm-scroller .cm-inlineCommentSelected": {
    boxShadow: "var(--shadow-lg)",
  },
  ".cm-inlineCommentSelected::after, .cm-inlineCommentCard:has(.cm-inlineCommentAttach:focus-visible)::after":
    {
      boxShadow: "inset 0 0 0 2px var(--comment-selection-stroke)",
    },
  ".cm-inlineCommentAttach:focus-visible": {
    outline: "none",
  },
  ".cm-inlineCommentCardTransitioning": {
    transition: `height ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 160ms ease-out`,
  },
  ".cm-inlineCommentHeader": {
    position: "relative",
    zIndex: "1",
    alignItems: "center",
    borderBottom: "1px solid color-mix(in oklch, #fffbeb 34%, transparent)",
    display: "flex",
    gap: "10px",
    justifyContent: "space-between",
    marginBottom: "0",
    paddingBottom: "8px",
    transition: `border-color ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms ease-out`,
  },
  ".cm-inlineCommentSelectable .cm-inlineCommentHeader": {
    zIndex: "3",
    pointerEvents: "none",
  },
  ".cm-inlineCommentSelectable .cm-inlineCommentControls, .cm-inlineCommentSelectable .cm-inlineCommentOrigin, .cm-inlineCommentSelectable .cm-inlineCommentFullWidthButton":
    {
      pointerEvents: "auto",
    },
  ".cm-inlineCommentCardEditing .cm-inlineCommentHeader": {
    borderBottom: "1px solid transparent",
  },
  ".cm-inlineCommentMeta": {
    alignItems: "center",
    display: "inline-flex",
    flex: "1 1 0",
    gap: "6px",
    minWidth: "0",
  },
  ".cm-inlineCommentBadge": {
    alignItems: "center",
    background: "#ca8a04",
    borderRadius: "999px",
    color: "#fffbeb",
    display: "inline-flex",
    flex: "0 0 auto",
    fontSize: "10px",
    fontWeight: "800",
    height: "18px",
    justifyContent: "center",
    lineHeight: "1",
    minWidth: "18px",
    padding: "0 5px",
    transition:
      "background-color 100ms ease-out, color 100ms ease-out, border-color 100ms ease-out",
  },
  ".cm-inlineCommentTime": {
    position: "relative",
    minWidth: "0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "#fffbeb",
    fontSize: "10px",
    fontWeight: "700",
    lineHeight: "1.15",
  },
  ".cm-inlineCommentContent": {
    background: "#eab308",
    display: "grid",
    isolation: "isolate",
    margin: "0 -10px",
    overflow: "hidden",
    position: "relative",
    width: "calc(100% + 20px)",
  },
  ".cm-inlineCommentCardEditing .cm-inlineCommentContent": {
    background: "color-mix(in oklch, #854d0e 18%, #eab308 82%)",
  },
  ".cm-inlineCommentBackgroundWipe": {
    inset: "0",
    pointerEvents: "none",
    position: "absolute",
    transform: "scaleX(0)",
    transformOrigin: "left center",
    transition: `transform ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms linear`,
    zIndex: "0",
  },
  ".cm-inlineCommentBackgroundWipeActive": {
    transform: "scaleX(1)",
  },
  ".cm-inlineCommentBody": {
    boxSizing: "border-box",
    display: "block",
    gridArea: "1 / 1",
    position: "relative",
    paddingTop: "12px",
    paddingRight: "10px",
    paddingBottom: "12px",
    paddingLeft: "10px",
    transition: `opacity ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms ease-out`,
    zIndex: "1",
  },
  ".cm-inlineCommentEditBody": {
    display: "block",
    gridArea: "1 / 1",
    position: "relative",
    transition: `opacity ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms ease-out`,
    zIndex: "1",
  },
  ".cm-inlineCommentBodyEntering": {
    opacity: "0",
    pointerEvents: "none",
  },
  ".cm-inlineCommentBodyLeaving": {
    opacity: "0",
    pointerEvents: "none",
  },
  ".cm-inlineCommentControls": {
    alignSelf: "center",
    background: "transparent",
    borderRadius: "12px",
    display: "flex",
    flex: "0 0 auto",
    gap: "6px",
    justifyContent: "flex-end",
    overflow: "hidden",
    padding: "0",
    transition: "background 120ms ease-out, box-shadow 120ms ease-out",
  },
  ".cm-inlineCommentCardEditing .cm-inlineCommentControls": {
    boxShadow: "none",
  },
  ".cm-inlineCommentPrimarySlot": {
    display: "flex",
    borderRadius: "12px",
    overflow: "hidden",
  },
  ".cm-inlineCommentPrimaryControls": {
    display: "flex",
    borderRadius: "12px",
    overflow: "hidden",
    background: "var(--comment-control-background)",
    transition: "transform 120ms ease-out",
  },
  ".cm-inlineCommentControlsConfirmingDelete": {
    "--comment-control-background": "rgba(0, 0, 0, 0.15)",
  },
  ".cm-inlineCommentButton": {
    alignItems: "center",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    boxSizing: "border-box",
    color: "#fff7ed",
    cursor: "pointer",
    display: "inline-flex",
    height: "24px",
    lineHeight: "1",
    justifyContent: "center",
    padding: "0",
    transition:
      "background 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out, transform 120ms ease-out",
    width: "24px",
  },
  // Middle pill buttons should keep the base 24px square style above.
  ".cm-inlineCommentPrimaryControls .cm-inlineCommentButton:first-child": {
    paddingLeft: "4px",
    width: "28px",
  },
  ".cm-inlineCommentPrimaryControls .cm-inlineCommentButton:last-child": {
    paddingRight: "4px",
    width: "28px",
  },
  ".cm-inlineCommentControls > .cm-inlineCommentButton": {
    borderRadius: "12px",
    background: "var(--comment-control-background)",
  },
  ".cm-inlineCommentPrimarySlot > .cm-inlineCommentSaveButton": {
    background: "var(--comment-control-background)",
    borderRadius: "12px",
    width: "56px",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "600",
  },
  ".cm-inlineCommentButton:hover:not(:disabled), .cm-inlineCommentControls > .cm-inlineCommentButton:hover:not(:disabled)":
    {
      background: "color-mix(in oklch, #713f12 28%, #eab308 72%)",
      color: "#fffbeb",
    },
  ".cm-inlineCommentFullWidthButton": {
    borderRadius: "12px",
    flex: "0 0 auto",
  },
  '.cm-inlineCommentCard .cm-inlineCommentFullWidthButton[aria-pressed="false"], .cm-inlineCommentCard .cm-inlineCommentFullWidthButton[aria-pressed="false"]:hover:not(:disabled)':
    {
      background: "transparent",
    },
  '.cm-inlineCommentCard .cm-inlineCommentFullWidthButton[aria-pressed="true"], .cm-inlineCommentCard .cm-inlineCommentFullWidthButton[aria-pressed="true"]:hover:not(:disabled)':
    {
      background: "var(--comment-control-background)",
    },
  ".cm-inlineCommentButton:disabled": {
    cursor: "default",
    filter: "grayscale(1)",
    opacity: "0.5",
  },
  '.cm-inlineCommentCard[aria-busy="true"] .cm-inlineCommentControls .cm-inlineCommentButton:disabled':
    {
      background: "transparent",
      filter: "none",
    },
  ".cm-inlineCommentSaving": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "56px",
    height: "24px",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "500",
    color: "#fff7ed",
    cursor: "default",
    transition: "transform 120ms ease-out",
  },
  ".cm-inlineCommentDeleteConfirm": {
    alignItems: "center",
    background: "var(--comment-control-background)",
    borderRadius: "12px",
    border: "0",
    color: "#fff7ed",
    cursor: "pointer",
    display: "inline-flex",
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    fontWeight: "800",
    height: "24px",
    justifyContent: "center",
    lineHeight: "1",
    padding: "0",
    transition:
      "background 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out, transform 120ms ease-out",
    width: "56px",
  },
  ".cm-inlineCommentDeleteConfirm:hover": {
    background: "rgba(0, 0, 0, 0.25)",
  },
  ".cm-inlineCommentControlsTransitioning .cm-inlineCommentButton": {
    opacity: "0",
    transform: "translateX(8px)",
  },
  ".cm-inlineCommentControlsTransitioning .cm-inlineCommentDeleteConfirm, .cm-inlineCommentControlsTransitioning .cm-inlineCommentSaveButton":
    {
      opacity: "1",
      transform: "translateX(-100%)",
    },
  ".cm-inlineCommentControlsTransitioningPrimary .cm-inlineCommentSaveButton, .cm-inlineCommentControlsTransitioningPrimary .cm-inlineCommentSaving, .cm-inlineCommentControlsTransitioningPrimary .cm-inlineCommentPrimaryControls":
    {
      transform: "translateX(-100%)",
    },
  ".cm-inlineCommentIcon": {
    display: "block",
    height: "14px",
    strokeWidth: "2.35",
    width: "14px",
  },
  ".cm-inlineCommentText": {
    flex: "1 1 0",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    margin: "0",
    minWidth: "0",
    paddingRight: "0",
    opacity: "1",
    transition: "opacity 100ms ease-out",
  },
  ".cm-inlineCommentEditor": {
    boxSizing: "border-box",
    display: "block",
    width: "100%",
    resize: "none",
    border: "0",
    borderRadius: "0",
    background: "transparent",
    color: "#fff7ed",
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    fontWeight: "500",
    lineHeight: "20px",
    margin: "0",
    minHeight: "0",
    outline: "none",
    overflow: "hidden",
    padding: "12px 10px",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
  },
  ".cm-inlineCommentCard .cm-inlineCommentControls > .cm-inlineCommentCopyButton":
    {
      transform: "none",
      opacity: "0",
      pointerEvents: "none",
      transition: "opacity 100ms ease-out, background-color 100ms ease-out",
    },
  ".cm-inlineCommentCard:hover .cm-inlineCommentCopyButton, .cm-inlineCommentCard:focus-within .cm-inlineCommentCopyButton":
    {
      opacity: "1",
      pointerEvents: "auto",
    },
  ".cm-inlineCommentControlsConfirmingDelete .cm-inlineCommentCopyButton, .cm-inlineCommentControlsConfirmingResolve .cm-inlineCommentCopyButton":
    {
      display: "none",
    },
  ".cm-inlineCommentCopyButton:focus-visible": {
    outline: "1px solid currentColor",
    outlineOffset: "1px",
  },
  ".cm-inlineCommentEditor:focus": {
    boxShadow: "none",
  },
  ".cm-inlineCommentEditor::placeholder": {
    color: "color-mix(in oklch, #fffbeb 78%, transparent)",
  },
  ".cm-inlineCommentAgent, .cm-inlineCommentAgent .cm-inlineCommentContent": {
    background: "#7252b5",
    color: "#fffaff",
  },
  ".cm-inlineCommentAgent": {
    "--comment-control-background": "color-mix(in srgb, #7252b5 85%, black)",
    "--comment-pill-active-background": "#fffaff",
    "--comment-pill-active-color": "color-mix(in srgb, #7252b5 85%, black)",
    "--comment-selection-stroke": "color-mix(in srgb, #7252b5 85%, black)",
  },
  ".cm-inlineCommentCard:is(.dark *)": {
    "--comment-selection-stroke": "currentColor",
  },
  ".cm-inlineCommentAgent .cm-inlineCommentBadge, .cm-inlineCommentAgent.cm-inlineCommentCardEditing .cm-inlineCommentContent":
    {
      background: "color-mix(in srgb, #7252b5 85%, black)",
      color: "#fffaff",
    },
  ".cm-inlineCommentSelected .cm-inlineCommentBadge": {
    background: "var(--comment-pill-active-background)",
    color: "var(--comment-pill-active-color)",
  },
  ".cm-inlineCommentAgent .cm-inlineCommentButton:hover:not(:disabled), .cm-inlineCommentAgent .cm-inlineCommentControls > .cm-inlineCommentButton:hover:not(:disabled)":
    {
      background: "color-mix(in srgb, #7252b5 70%, black)",
    },
  ".cm-inlineCommentAgent .cm-inlineCommentControlsConfirmingDelete": {
    "--comment-control-background": "rgba(0, 0, 0, 0.15)",
  },
  ".cm-inlineCommentAgentMark": {
    backgroundColor: "color-mix(in oklch, #7252b5 24%, transparent)",
    borderBottom: "2px solid #7252b5",
  },
  ".cm-inlineCommentControlsConfirmingResolve, .cm-inlineCommentAgent .cm-inlineCommentControlsConfirmingResolve":
    {
      "--comment-control-background": "rgba(0, 0, 0, 0.15)",
    },
  ".cm-inlineCommentControlsConfirmingResolve .cm-inlineCommentDeleteConfirm:hover":
    {
      background: "rgba(0, 0, 0, 0.25)",
    },
  ".cm-inlineCommentCard[data-confirm-action] .cm-inlineCommentControls > .cm-inlineCommentButton:hover":
    {
      background: "rgba(0, 0, 0, 0.25)",
    },
  ".cm-inlineCommentCard .cm-inlineCommentControls > .cm-inlineCommentCopyButton, .cm-inlineCommentCard .cm-inlineCommentControls > .cm-inlineCommentCopyButton:hover:not(:disabled)":
    {
      background: "transparent",
    },
  ".cm-inlineCommentOrigin": {
    fontSize: "10px",
    fontWeight: "700",
    whiteSpace: "nowrap",
    flexShrink: "0",
  },
  ".cm-inlineCommentUnplaced:focus-within .cm-inlineCommentOrigin": {
    display: "none",
  },
  ".cm-inlineCommentCard::before": {
    content: '""',
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    zIndex: "0",
    background: "var(--comment-confirm-color, transparent)",
    clipPath: "inset(0 100% 0 0)",
    transition: `clip-path ${INLINE_COMMENT_CARD_TRANSITION_DURATION_MS}ms linear`,
  },
  ".cm-inlineCommentCard[data-confirm-action]::before": {
    clipPath: "inset(0 0 0 0)",
  },
  '.cm-inlineCommentCard[data-confirm-action="resolve"], .cm-inlineCommentCard[data-confirm-returning="resolve"]':
    {
      "--comment-confirm-color": "#70aa50",
    },
  '.cm-inlineCommentCard[data-confirm-action="delete"], .cm-inlineCommentCard[data-confirm-returning="delete"]':
    {
      "--comment-confirm-color": "#dc2626",
    },
  ".cm-inlineCommentCard[data-confirm-action] .cm-inlineCommentContent, .cm-inlineCommentCard[data-confirm-returning] .cm-inlineCommentContent":
    {
      background: "transparent",
    },
  ".cm-inlineCommentCard[data-confirm-action]:not(.cm-inlineCommentSelected) .cm-inlineCommentBadge":
    {
      background: "rgba(0, 0, 0, 0.15)",
    },

  ".cm-inlineCommentCard.cm-inlineCommentUnplaced .cm-inlineCommentHeader .cm-inlineCommentBadge":
    {
      background: "transparent",
      color: "inherit",
      boxSizing: "border-box",
      border: "1px solid currentColor",
    },
  ".cm-inlineCommentUnplaced:not([data-confirm-action]):not([data-confirm-returning]) .cm-inlineCommentText":
    {
      opacity: "0.75",
    },
  ".cm-inlineCommentTimestamp": {
    display: "block",
    opacity: "1",
    visibility: "visible",
    transition: "opacity 100ms ease-out, visibility 0s linear",
  },
  ".cm-inlineCommentPlacementHint": {
    display: "block",
    position: "absolute",
    top: "0",
    left: "0",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    opacity: "0",
    visibility: "hidden",
    transition: "opacity 100ms ease-out, visibility 0s linear 100ms",
  },
  ".cm-inlineCommentUnplaced:focus-within .cm-inlineCommentTimestamp": {
    position: "absolute",
    top: "0",
    left: "0",
    opacity: "0",
    visibility: "hidden",
    transition: "opacity 100ms ease-out, visibility 0s linear 100ms",
  },
  ".cm-inlineCommentUnplaced:focus-within .cm-inlineCommentPlacementHint": {
    position: "relative",
    opacity: "1",
    visibility: "visible",
    transition: "opacity 100ms ease-out, visibility 0s linear",
  },
  ".cm-inlineCommentCard.cm-inlineCommentUnplaced:focus-within .cm-inlineCommentHeader .cm-inlineCommentBadge, .cm-inlineCommentUnplaced:focus-within .cm-inlineCommentPlacementStatus":
    {
      background: "var(--comment-pill-active-background)",
      color: "var(--comment-pill-active-color)",
      borderColor: "transparent",
    },
  ".cm-inlineCommentPlacementHint [data-context-glow]": {
    color: "#fff",
    textShadow: "0 0 5px #fff, 0 0 10px rgb(255 255 255 / 70%)",
  },
  ".cm-inlineCommentPlacementStatus": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    background: "transparent",
    border: "1px solid currentColor",
    borderRadius: "12px",
    width: "56px",
    height: "24px",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    fontWeight: "600",
    pointerEvents: "none",
    transition:
      "background-color 100ms ease-out, color 100ms ease-out, border-color 100ms ease-out",
  },
  // The status area shares the card's click target; real controls stay usable.
  ".cm-inlineCommentUnplaced .cm-inlineCommentControls": {
    pointerEvents: "none",
  },
  ".cm-inlineCommentUnplaced .cm-inlineCommentControls button": {
    pointerEvents: "auto",
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-inlineCommentPlacementHint [data-context-glow]": {
      animation: "none !important",
    },
    ".cm-inlineCommentText, .cm-inlineCommentTimestamp, .cm-inlineCommentPlacementHint, .cm-inlineCommentBadge, .cm-inlineCommentPlacementStatus, .cm-inlineCommentCopyButton":
      { transition: "none !important" },
    ".cm-inlineCommentCard::before": { transition: "none" },
    ".cm-inlineCommentCard, .cm-inlineCommentCard::after, .cm-inlineCommentAttach":
      { transition: "none" },
  },
  ".cm-inlineCommentAgentSuperscript": { background: "#7252b5" },
  ".cm-inlineCommentAgentSuperscript:hover": {
    background: "color-mix(in srgb, #7252b5 70%, black)",
  },
};

// CodeMirror retains mounted style modules for the lifetime of the document.
// Reuse this module when comments or their anchors change.
const inlineCommentTheme = EditorView.theme(inlineCommentStyles);
