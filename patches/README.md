# CodeMirror merge 6.12.0

The merge view caches deleted-text widgets by the chunk's changes. When an earlier
change is accepted, later chunks can move while retaining that cache key. A widget
first rendered after the acceptance then combines its captured offsets with the
current original document, displaying unrelated text.

The patch reads deleted text from the captured editor state instead, keeping the
document and offsets from the same snapshot. Accept/reject still use the current
view and chunk positions. Both ESM and CommonJS entry points are patched.

`apps/desktop/e2e/review-chunk-rendering.spec.ts` reproduces the problem with five
distant edits and an initial acceptance that grows or shrinks the document. It
checks the remaining original text and the result of mixed accept/reject decisions.
Recheck this regression when upgrading `@codemirror/merge`; remove the patch once
the upstream implementation passes it without the patch.
