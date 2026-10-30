# Text selection boundaries

The desktop shell is non-selectable by default. New buttons, tabs, labels, and
navigation controls inherit this behavior; no per-control class is required.

## Readable content

Use `data-selectable-content` (or the `selectable-content` class) on the content
boundary of a new readable component. Keep its controls outside that boundary
where possible. Buttons remain non-selectable even within readable content.

Shared Markdown rendering, inline comment bodies, code blocks, inputs, and
CodeMirror editors already opt in. Do not enable selection on a whole panel just
to make its document body copyable.

## Keyboard and PDF behavior

Editors handle their own selection. Shell Select All is prevented; for ordinary
readable content it is scoped to the current content boundary. The PDF viewport
owns Select All and mouse dragging. Its drag controller computes endpoints from
SVG glyph positions, clamps whitespace to a row boundary, and scrolls at pane
edges. Native DOM Selection remains the representation used for highlights and
copying; there is no selectionchange repair loop.

PDF text is retained on selection to preserve anchors across virtualized pages;
offscreen canvases are not rendered for this purpose. Copy exports selected PDF
text only, with line breaks, excluding comment cards and app controls. Canvas
backgrounds never receive native selection highlighting. Keyboard selection and
native double-click word selection remain available.

Regression coverage: `e2e/pdf-selection-position-harness.spec.ts` and
`e2e/pdf-comment-selection-harness.spec.ts`, run in Chromium and WebKit.

## Focus and chat context

Changing focus alone preserves the selected range and hides its action popup.
PDF selections use a darker inactive gray; the first click back into the PDF
restores the saved range, and a subsequent click can replace it. A new nonempty
selection emits `SELECTION_OWNER_EVENT` and clears the other pane's range.

PDF chat context uses `PDF p.2 · “selected text…”` until source matching succeeds,
then uses `PDF p.2 · @main.tex:42:1-45:12`. The selected PDF text remains the attached
content, with source location metadata when available. Matching reuses the comment
availability check. Turning off comments in the PDF skips source-text matching
and keeps the fallback badge. This toggle does not suppress the SyncTeX lookup.

AI selection actions are visible in Duet and Vibe and hidden in Artisan.
