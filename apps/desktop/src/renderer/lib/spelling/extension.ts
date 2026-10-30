import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { StateEffect, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings-store";
import { broadcastSettingsChanged } from "@/components/settings/solar-mode-effect";
import {
  registerEditorContextActions,
  type ContextAction,
} from "@/lib/context-menu";
import { retainSpellingClient } from "./client";
import {
  proseWords,
  spellingDocument,
  type SpellingDocument,
  type SpellingWord,
} from "./prose";

const spellingResults = StateEffect.define<SpellingWord[]>();
const resetSpelling = StateEffect.define<void>();
const theme = EditorView.baseTheme({
  ".cm-spelling-error": {
    textDecoration: "underline wavy #dc2626",
    textUnderlineOffset: "3px",
    textDecorationThickness: "1px",
  },
});

class EditorSpelling {
  decorations: DecorationSet = Decoration.none;
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private destroyed = false;
  private failed = false;
  private retained?: ReturnType<typeof retainSpellingClient>;
  private unsubscribe: () => void;
  private unregister: () => void;

  constructor(
    private view: EditorView,
    private kind: SpellingDocument,
  ) {
    this.unregister = registerEditorContextActions(view, (position) =>
      this.menu(position),
    );
    this.unsubscribe = useSettingsStore.subscribe((next, previous) => {
      if (
        next.spellCheck !== previous.spellCheck ||
        next.spellingLanguage !== previous.spellingLanguage ||
        next.spellingWords !== previous.spellingWords
      ) {
        // Settings can change while another editor transaction is being handled.
        this.generation++;
        queueMicrotask(() => {
          if (!this.destroyed) {
            this.failed = false;
            this.view.dispatch({ effects: resetSpelling.of() });
            this.configure();
          }
        });
      }
    });
    this.configure();
  }

  private enabled() {
    return (
      useSettingsStore.getState().spellCheck &&
      !this.view.state.readOnly &&
      this.view.state.facet(EditorView.editable)
    );
  }

  private configure() {
    if (this.enabled()) {
      this.retained ??= retainSpellingClient();
      this.schedule(0);
    } else {
      clearTimeout(this.timer);
      this.retained?.release();
      this.retained = undefined;
    }
  }

  update(update: ViewUpdate) {
    for (const tr of update.transactions) {
      if (tr.docChanged) {
        // Keep unaffected underlines steady; remove the word currently edited.
        this.decorations = this.decorations
          .update({ filter: (from, to) => !tr.changes.touchesRange(from, to) })
          .map(tr.changes);
      }
      for (const effect of tr.effects) {
        if (effect.is(spellingResults))
          this.decorations = Decoration.set(
            effect.value.map((word) =>
              Decoration.mark({
                class: "cm-spelling-error",
                word: word.text,
              }).range(word.from, word.to),
            ),
            true,
          );
        if (effect.is(resetSpelling)) this.decorations = Decoration.none;
      }
    }
    if (
      update.startState.readOnly !== update.state.readOnly ||
      update.startState.facet(EditorView.editable) !==
        update.state.facet(EditorView.editable)
    ) {
      this.generation++;
      this.decorations = Decoration.none;
      this.configure();
    } else if (update.docChanged) {
      this.schedule(1000);
    } else if (update.viewportChanged) {
      this.schedule(150);
    } else if (
      syntaxTree(update.startState) !== syntaxTree(update.state) &&
      !this.timer
    ) {
      this.schedule(0);
    }
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = undefined;
    const generation = ++this.generation;
    if (!this.enabled() || this.failed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check(generation);
    }, delay);
  }

  private async check(generation: number) {
    const { view } = this;
    const state = view.state;
    // CodeMirror's background parser will dispatch an update when ready.
    if (this.kind !== "text" && !syntaxTreeAvailable(state, view.viewport.to))
      return;
    const settings = useSettingsStore.getState();
    const learned = new Set(settings.spellingWords);
    const words = proseWords(state, view.visibleRanges, this.kind).filter(
      (word) => !learned.has(word.text),
    );
    try {
      const incorrect = new Set(
        await this.retained!.client.check(
          [...new Set(words.map((word) => word.text))],
          settings.spellingLanguage,
        ),
      );
      if (
        this.destroyed ||
        generation !== this.generation ||
        state.doc !== view.state.doc ||
        !this.enabled()
      )
        return;
      view.dispatch({
        effects: spellingResults.of(
          words.filter((word) => incorrect.has(word.text)),
        ),
      });
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.failed = true;
      toast.error("Spell check unavailable", {
        id: "spellcheck-unavailable",
        description: "Turn Spell Check off and on in Settings to retry.",
      });
      console.error("Spell check:", error);
    }
  }

  private menu(position: number): Promise<ContextAction[]> | null {
    if (!this.enabled() || !this.retained) return null;
    let match: SpellingWord | undefined;
    this.decorations.between(position, position, (from, to, value) => {
      if (position >= from && position <= to)
        match = { from, to, text: value.spec.word };
    });
    if (!match) return null;
    const word = match;
    const doc = this.view.state.doc;
    const language = useSettingsStore.getState().spellingLanguage;
    const current = () =>
      !this.destroyed &&
      this.enabled() &&
      this.view.state.doc === doc &&
      useSettingsStore.getState().spellingLanguage === language;
    return this.retained.client
      .suggest(word.text, language)
      .then((suggestions) => {
        if (!current()) return [];
        const actions: ContextAction[] = suggestions.map((suggestion) => ({
          label: suggestion,
          run: () => {
            if (!current()) return;
            this.view.dispatch({
              changes: { from: word.from, to: word.to, insert: suggestion },
              selection: { anchor: word.from + suggestion.length },
              userEvent: "input.spelling",
            });
            this.view.focus();
          },
        }));
        if (!actions.length)
          actions.push({
            label: "No spelling suggestions",
            disabled: true,
            run: () => {},
          });
        actions.push({
          label: "Add to Dictionary",
          separator: true,
          run: () => {
            if (!current()) return;
            useSettingsStore.getState().learnSpellingWord(word.text);
            broadcastSettingsChanged();
          },
        });
        return actions;
      });
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.unsubscribe();
    this.unregister();
    this.retained?.release();
  }
}

export function spellCheckExtension(path: string): Extension {
  const kind = spellingDocument(path);
  return kind
    ? [
        theme,
        ViewPlugin.define((view) => new EditorSpelling(view, kind), {
          decorations: (plugin) => plugin.decorations,
        }),
      ]
    : [];
}
