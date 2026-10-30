# Keyboard interaction conventions

Use `src/renderer/lib/keyboard-events.ts` for application keyboard handlers.

- IME composition owns Enter and Escape. The renderer installs `installImeKeyBoundary` before popup handlers; it stops JavaScript propagation without cancelling the browser action. Check `isComposingKey` before application actions; leave native composition behavior intact. Shared `Input` and `Textarea` do this for their callbacks. Raw controls and capture listeners must do it themselves.
- Attach interaction handlers to their owning element or pane. Avoid window/document listeners for local dismissal, and never forward synthetic keyboard events between panes or iframe documents.
- Check `defaultPrevented` before acting. Once an action handles a key, call `consumeKey` (prevent default and stop propagation). Other listeners on the same node must also respect `defaultPrevented`.
- Modal and menu primitives own their interactions. Background pane Escape handlers use `canHandleEscape` to yield to visible modals. Do not infer keyboard priority from numeric CSS z-index.
- Open search consumes Escape inside its own pane before ordinary pane dismissal. `canCloseSearchOnEscape` intentionally ignores tooltip prevention so a tooltip cannot steal search dismissal. It still yields to IME and modals. Other panes remain unchanged.
- Enter stays specific to the focused control: submit, select, or newline as appropriate. Do not add a global Enter action.

For new interactions, cover IME, a handled key reaching an ancestor, and two open panes where relevant. Shared controls provide the default safeguards; custom keyboard listeners still need to follow these conventions.
