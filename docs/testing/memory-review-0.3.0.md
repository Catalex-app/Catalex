# v0.3.0 memory review

Review for [Catalex-tasks #396](https://github.com/Catalex-app/Catalex-tasks/issues/396),
2026-11-14. Compared `v0.2.1` with `v0.3.0`, then checked current `dev`
(`92a9a9d`). The follow-up changes the standalone PDF comment caches and adds
regression tests and diagnostics.

## Findings

### 1. Compiled PDF comments can activate whole-document SyncTeX allocation

**Major contributor observed in the long-project follow-up; implementation
predates v0.3.0.** The first compiled-PDF comment activates the lookup in
[`pdf-comments.tsx`](../../apps/desktop/src/renderer/components/workspace/preview/pdf-comments.tsx#L907).
The lookup requests the complete document's source map, then constructs another
complete page/box/source graph in
[`pdf-comment-lookup.ts`](../../apps/desktop/src/renderer/components/workspace/preview/pdf-comment-lookup.ts#L24).
Both the raw map and derived graph remain cached for that compiled revision.
Deleting or deselecting comments does not reset the resolved promises.
Scroll synchronization can load the shared map earlier, so the incremental cost
of adding a comment depends on the preceding navigation.

The native command in
[`latex.rs`](../../apps/desktop/backend/src/latex.rs#L1492) decompresses and parses
the entire SyncTeX file. Serialization creates large JSON representations,
including an additional JSON response-envelope copy in
[`service.rs`](../../apps/desktop/backend/src/service.rs#L1026), followed by
serialized bytes, Electron JSON parsing, and renderer IPC transport. The prepared
Lurie fixture's SyncTeX expands from about 8.7 MiB to 40.0 MiB; Tong's expands
from about 1.1 MiB to 4.9 MiB. Parsed object graphs are substantially larger than
these text files.

Native RSS remaining high after the request does not establish a live native
map leak: this native path has no persistent parsed-map cache. Allocator
high-water retention is a plausible explanation. The renderer's raw and derived
map caches are explicit live retention while that compiled revision is active.
The lookup, allocation path, and zero-comments activation condition are unchanged
between v0.2.1 and v0.3.0. They explain a significant workload-dependent cost
without establishing a newly introduced release regression.

**Recommended follow-up:** page-scoped comment-map loading/transport, avoiding
duplicate whole-document renderer graphs, and avoiding native response-envelope
cloning. Verify these changes against the long-project workload below, including
project closure and a full restart.

### 2. Chat Find can leave a substantially higher process memory footprint

**Measured contributor, introduced in `28675cd`.** Each saved-history query
creates a new worker in
[`main/index.ts`](../../apps/desktop/src/main/index.ts#L140). The worker runs
[`searchSavedChat`](../../apps/desktop/src/main/chat-checkpoints.ts#L242), which
reads and JSON-decodes each complete checkpoint chunk before filtering messages.
Chunks are limited to 100 messages, with no byte limit. Tool results are decoded
even though their content is not searched.

Search also constructs Markdown syntax trees to obtain visible text
([`chat-message-search.ts`](../../apps/desktop/src/chat-message-search.ts#L52)).
An open Find query is debounced by 180 ms; each subsequent query repeats the
saved-history scan in another worker. This is transient allocation plus observed
resident-memory retention after the worker exits, rather than evidence of an
unbounded retained-object leak.

The saved diagnostic bundles the real search implementation and runs it in
Electron 44.4.2's Node runtime. Each scenario uses a fresh process, synthetic
checkpoints, and an absent query. Samples after workers exit force parent GC;
the final sample waits another five seconds.

| Scenario | Input | Baseline RSS | Settled RSS | Increase |
| --- | --- | ---: | ---: | ---: |
| Import checkpoint/search bundle without searching | No messages | 61.0 MiB | 65.5 MiB | 4.5 MiB |
| Eight sequential searches | 600 assistant messages; 2,548,696 JSON bytes | 61.1 MiB | 132.3 MiB | 71.2 MiB |
| Three sequential searches | 600 tool-result messages; 39,375,006 JSON bytes | 61.0 MiB | 170.6 MiB | 109.6 MiB |

The Markdown run was already at 130.1 MiB after the first worker exited and
subsequently plateaued. Its parent JS heap settled at 2.5 MiB. The ignored-tool
run returned no matches, but its largest sampled worker heap was 74.7 MiB and
sampled process RSS reached 210.8 MiB. Samples can miss synchronous allocation
peaks. This makes full JSON decoding a useful optimization target independently
of Markdown parsing.

These are isolated search measurements, **not** whole-app measurements or an
installed v0.2.1 versus v0.3.0 comparison. RSS includes allocator/runtime memory;
parent GC cannot reclaim allocations owned by other live isolates. The workers
in these samples had exited. The numbers do not prove which allocator or runtime
subsystem kept the resident pages. The import measurement does not establish the
same incremental cost in an app that already loaded overlapping dependencies.

**Recommended follow-up:** store or derive a compact searchable-text projection
instead of repeatedly decoding full tool payloads. Preserve message offsets,
Markdown matching, and existing checkpoint compatibility. Measure worker reuse
with an idle release policy before choosing it over per-query workers. Propagate
cancellation when Find closes or its window/project disappears; currently
renderer cleanup ignores the reply, while the host worker can continue until
completion or its 10-second timeout.

### 3. Standalone PDF comment resizing retained all touched page text

**Confirmed retention path, introduced in `a6bcc11`.** The long-project sequence
below measures annotation-related heap growth, but does not isolate this cache's
exact size from other retained UI/history state.
[`use-pdf-file-comment-resize.ts`](../../apps/desktop/src/renderer/components/workspace/preview/use-pdf-file-comment-resize.ts#L27)
previously created `cache.pages` for the lifetime of a PDF source. Selecting a resizable
comment loads its pages; dragging across pages loads every intervening page.
Entries contain full structured text, including per-character geometry.

Deselecting, ending/canceling a drag, or deleting a comment did not clear these
entries. Visiting more commented pages therefore retained more geometry even
after their normal visible text layers were released. The cache was released when
the source changed or the owning overlay unmounted. Growth was bounded by the
pages touched in that source, without a page or byte budget.

**Implemented follow-up.** Preparation now retains compact endpoint offsets and
immediately releases full page geometry. An active drag loads the required pages
and releases them on completion or cancellation. Changing or dismissing the
selected anchor, deletion, source replacement, and unmount invalidate pending
loads. Request identity checks prevent an old completion from deleting a newer
pending request. Regression tests cover these lifetimes and React StrictMode.

This applies to standalone PDF anchors. It does not explain increased memory
when working exclusively with a compiled LaTeX preview.

### 4. PDF selection badges cached old comment anchor versions

**Confirmed retention path, introduced in `e0fa0d0`; likely smaller than #3.**
[`comment-chat-context.ts`](../../apps/desktop/src/renderer/lib/comment-chat-context.ts#L112)
previously stored recovered ranges in a `WeakMap<PdfSource, Map<string, Promise<...>>>`.
The inner key serializes the quoted text and regions. Resizing a comment and
then selecting overlapping text produced another key. Older versions remained
after subsequent edits or deletion, without inner-map bounds or pruning.

Weak ownership frees the map only after its source becomes unreachable. The
document cache can retain that source after switching files. These entries hold
serialized quote/geometry keys and compact ranges, not full page text. The
function's separate per-call `pageText` map is temporary and is not this finding.

**Implemented follow-up.** Each composer now owns recovery for its live PDF
selection, keyed by immutable anchor identity. It prunes deleted, resolved, and
replaced anchors and clears on selection dismissal, disabled attachments,
source changes, and unmount. Pending work checks its generation before requesting
text and before parsing recovered ranges. Late replies cannot refill a cleared
cache. Multiple composers keep independent lifetimes. Regression tests cover
reuse, pruning, independent owners, source changes, dismissal, and pending replies.

## Other substantial memory consumers

The following behaviors predate v0.3.0 and should not be presented as newly
introduced leaks:

- The compiled preview keeps up to five viewers alive. Each has a soft 128 MiB
  canvas budget; visible/nearby pages are protected and can exceed that budget.
  These are independent budgets, so 128 MiB is not an app-wide ceiling. See
  [`pdf-preview.tsx`](../../apps/desktop/src/renderer/components/workspace/preview/pdf-preview.tsx#L154)
  and [`pdf-canvas-cache.ts`](../../apps/desktop/src/renderer/components/workspace/preview/pdf-canvas-cache.ts#L1).
- The MuPDF cache retains up to five documents. WASM/renderer process memory can
  have a higher resident footprint than the main-renderer JS heap suggests.
  Page, structured-text, pixmap, link, and transferred-bitmap cleanup exists.
  Project close clears the document cache and terminates its worker.
- Active chat transcripts remain in store even when their DOM is virtualized.
  Collapsing Half mode still unmounts the message list outside transitions;
  `7d6392d` changed list sizing, not that lifetime. Project-chat lifecycle
  retention is unchanged from v0.2.1.
- The editor caches document text and undo history for visited files without an
  entry/byte budget. Its unmount cleanup also writes the final editor state after
  `closeProject` has called `clearEditorStateCache`, so that ordering deserves a
  separate lifecycle check. See
  [`latex-editor.tsx`](../../apps/desktop/src/renderer/components/workspace/editor/latex-editor.tsx#L3710)
  and [`document-store.ts`](../../apps/desktop/src/renderer/stores/document-store.ts#L1079).
  This is a pre-existing source-level concern, not a measured v0.3.0 regression.

The new native action registry removes owners/subscribers on unmount, native
menu state is replaced per window and removed on close, and project navigation
clears snapshot animations when transitions finish. No comparable persistent
accumulation was found in those paths. This bounded review is not proof that
every lifecycle is leak-free.

## Reproduction and verification

Run the opt-in search diagnostic from the repository root:

```sh
node apps/desktop/e2e/electron/chat-search-memory.mjs
```

It uses the installed Electron executable in Node mode, starts no GUI or agent,
creates synthetic checkpoints in temporary storage, and removes them afterward.
Raw byte counts and samples are written to ignored
`output/playwright/chat-search-memory/results.json`. It has no machine-dependent
memory threshold; compare the scenarios and retained heap versus RSS separately.

Checks completed for this review:

- Biome CI: passed with existing repository warnings/information.
- Electron main/preload typecheck: passed.
- Frontend TypeScript/Vite build, desktop build, and local desktop packaging:
  passed. Packaging used ad-hoc signing, without notarization or publishing.
- Comment context, PDF passage recovery, and MuPDF client tests: 25 passed.
- Electron main/host tests: 117 passed. Root script tests: 37 passed.
- Search diagnostic: passed all three scenarios with no matches and natural
  worker exits. Search production code was unchanged.

## Long-project comment measurements

The follow-up ran the actual packaged macOS ARM64 application, Electron 44.4.2,
with the production renderer/native service from `92a9a9d` on an M4 Max with
128 GiB RAM. Each project had its own temporary profile and project copy. No
builds or other benchmarks ran concurrently. Both cases passed, including
native comment readback, project closure, worker termination, restart, and source
hash checks. Screenshots of the standalone highlights/badges were inspected.

| Project | PDF pages | Saved compiled-preview comments | Saved standalone comments | Resize interactions |
| --- | ---: | ---: | ---: | ---: |
| Lurie, Higher Topos Theory | 735 | 24 | 40 | 30 |
| Tong, Lectures on String Theory | 217 | 3 | 40 | 30 |

Forty body pages were visited before annotations, then the same pages were
attempted for compiled comments. Source matching failed for 16 Lurie and 37 Tong
selections after trying up to five prose lines; those pages are recorded in the
raw report and are not counted as saved comments. All 40 standalone comments in
each case were saved and read back. The standalone PDF was copied from that
case's actual native compilation. Two full comment-revisit passes and 30 resize
interactions followed, then all comments were deleted.
Badge assertions check presence and the PDF filename, rather than every matched
comment ID. The probe measures the interaction sequence, not exact per-anchor
cache occupancy or the number of distinct persisted resize versions.

Two Lurie archive files (`highertopoi.tex`, `chap2sec1-leftfib.tex`) contain legacy
Windows-1252 bytes. The temporary copies were converted to UTF-8 for current
pdfLaTeX and the native comment reader; pinned archives/supplied fixtures were
unchanged. Final hashes checked against these prepared copies. Earlier raw-byte
pilots exposed the encoding/readback problem and were excluded from the final
table. Showing each test window before waiting for renderer readiness also
resolved a startup stall encountered during pilot runs.

All values below are MiB. Renderer RSS includes its PDF worker; the heap column
is only main-renderer JS heap after two forced collections. Native RSS is the
Rust process. Working sets are sampled, not allocation peaks or disjoint
physical-memory accounting. Browser/GPU/utility samples are in the raw report.

| Project / stage | Renderer RSS | Native RSS | JS heap | Canvas estimate |
| --- | ---: | ---: | ---: | ---: |
| Lurie: navigation, no comments | 789.0 | 27.9 | 119.4 | 104.1 |
| Lurie: selection alone, no comments | 841.4 | 27.9 | 123.6 | 104.1 |
| Lurie: compiled comments, deselected | 1,301.9 | 462.8 | 178.4 | 104.1 |
| Lurie: standalone navigation control | 1,309.0 | 462.7 | 182.4 | 104.1 |
| Lurie: 40 standalone comments | 1,345.0 | 465.8 | 189.0 | 104.1 |
| Lurie: comments deleted | 1,507.6 | 468.2 | 190.9 | 104.1 |
| Lurie: project closed | 1,163.8 | 468.2 | 87.1 | 0 |
| Lurie: full restart, Welcome | 170.8 | 18.8 | 9.6 | 0 |
| Tong: navigation, no comments | 714.5 | 92.6 | 102.7 | 125.8 |
| Tong: selection alone, no comments | 714.8 | 92.7 | 102.8 | 125.8 |
| Tong: compiled comments, deselected | 888.8 | 95.6 | 110.2 | 125.8 |
| Tong: standalone navigation control | 884.2 | 95.3 | 104.1 | 125.8 |
| Tong: 40 standalone comments | 921.2 | 97.0 | 124.5 | 125.8 |
| Tong: comments deleted | 1,029.0 | 97.9 | 126.2 | 125.8 |
| Tong: project closed | 688.9 | 97.9 | 21.9 | 0 |
| Tong: full restart, Welcome | 172.5 | 18.7 | 9.6 | 0 |

The clearest new observation is Lurie's native jump from 27.9 to 462.8 MiB when
compiled comments activate the whole-document mapping path, with no canvas
increase. Selection alone did not produce that jump. Tong had already paid most
of its native map-loading cost during preview/navigation: native RSS was
26.6 MiB after source opening and 92.6 MiB by the navigation control. Its extra
cost on adding comments was correspondingly smaller. It would be incorrect to
attribute Tong's entire native increase to adding comments.

Forty standalone comments increased live main-renderer heap by 6.6 MiB on Lurie
and 20.4 MiB on Tong relative to their standalone navigation controls. Two
revisit passes changed those heaps from 189.0 to 190.9 MiB and 124.5 to
125.7 MiB, respectively. Deleting comments did not reclaim that increase in this
sequence, consistent with the known page/range caches and other UI/history
retention. These deltas do not isolate the exact cache objects or prove
unbounded growth. Renderer RSS rose further while heap/canvas counts changed
much less; worker/runtime/allocator retention is outside the main-heap metric.

Closing each project removed all PDF canvases and the MuPDF worker, but sampled
RSS and some JS heap stayed above the initial Welcome level. These close samples
were taken about 2.5 seconds after returning to Welcome, with forced renderer
GC; they do not test a long idle interval or memory pressure. A full restart
returned both cases to a small Welcome footprint. Retainer snapshots would be
needed to identify precisely what kept the remaining post-close JS heap alive.

Reproduce with:

```sh
CATALEX_LONG_COMMENT_RUN=local \
  node apps/desktop/e2e/electron/long-paper-comment-memory.mjs
```

The measured run is saved under ignored
`output/playwright/long-paper-comments/long-40-utf8.json`, with screenshots beside
it. See [long-paper performance](long-paper-performance.md#pdf-comment-memory)
for fixture reuse, host/executable selection, and workload options.

Priority after this follow-up: reduce whole-document SyncTeX allocation and
transport first, then bound standalone comment caches and investigate post-close
heap retainers. The release-tag comparison below subsequently tested the shared
PDF workload. No Windows/Linux runtime claim is made here.

## Exact v0.2.1 versus v0.3.0 comparison

Both versions were built locally from Git archives of the exact annotated tags,
without switching the development checkout or creating Git worktrees:

- v0.2.1: `c52c5f510ddfbe81ba3034d763a80080718668d3`
- v0.3.0: `f679300b36f185b2b96ba7cf2114e217c9b2fc63`

Both use Electron 44.4.2, byte-identical dependency lockfiles, and the same
installed JS dependencies and compiler toolchain. Native helpers were rebuilt
from each tag, and packaged/native versions were asserted during each run. The
local ad-hoc signatures passed verification; these were not downloaded official
installers or newly published releases. ASAR/native hashes are recorded in
`output/playwright/long-paper-comments/release-build-provenance.json`.

One sequential run per version covered both projects, with fresh profiles and
the same prepared sources, 1440 × 1000 viewport at DPR 2, 40 navigation pages,
fixed compiled-comment pages (24 Lurie, 3 Tong), 40 standalone comments, two
revisit passes, deletion, close, and restart. All four cases passed. Native
readback verified each standalone comment's intended page. The two runs have
the same driver SHA-256 and page plan; page counts and canvas estimates match.

The comparison excludes resizing, which v0.2.1 does not support. It also does
not require automatic selection-comment badges in v0.2.1, where they do not
exist, while retaining the same text-selection actions in both versions. This
driver explicitly clears old selection context with a blank-area click, and
checks saved anchor pages. It is stricter than the earlier broad probe; use this
matched pair for cross-version numbers, rather than mixing either version with
the earlier `92a9a9d` run or excluded compatibility pilots.

The subsequent cache-fix verification found that the release-tag driver could
dismiss revisit selections before the viewer's 300 ms debounce published them.
Creation and native anchor readback completed in these recorded runs. The later
paired cache-fix workload waits for published selection UI and verifies every
persisted resize before continuing.

### Matched observations

All values are MiB, sampled after main-renderer forced GC. Renderer RSS includes
the worker; native RSS is the Rust service. Heap is main-renderer JS only.

| Project / stage | Renderer RSS 0.2.1 → 0.3.0 | Native RSS 0.2.1 → 0.3.0 | JS heap 0.2.1 → 0.3.0 |
| --- | ---: | ---: | ---: |
| Lurie: navigation, no comments | 756.1 → 781.7 | 28.1 → 28.2 | 118.4 → 119.4 |
| Lurie: compiled comments | 1,137.7 → 1,277.1 | 463.0 → 462.6 | 179.2 → 179.0 |
| Lurie: 40 standalone comments | 1,163.6 → 1,316.6 | 465.6 → 465.3 | 179.1 → 204.8 |
| Lurie: comments deleted | 1,373.8 → 1,504.9 | 468.5 → 468.0 | 161.6 → 187.0 |
| Lurie: project closed | 1,010.6 → 1,092.1 | 468.5 → 468.1 | 86.7 → 87.3 |
| Lurie: full restart, Welcome | 171.9 → 169.8 | 18.9 → 19.0 | 9.6 → 9.6 |
| Tong: navigation, no comments | 700.9 → 708.8 | 92.8 → 93.0 | 101.6 → 102.7 |
| Tong: compiled comments | 741.2 → 751.3 | 95.5 → 94.8 | 98.4 → 99.7 |
| Tong: 40 standalone comments | 818.1 → 832.2 | 96.7 → 96.1 | 96.7 → 115.3 |
| Tong: comments deleted | 900.3 → 858.1 | 97.5 → 96.7 | 97.8 → 115.4 |
| Tong: project closed | 578.2 → 598.7 | 97.5 → 96.7 | 20.7 → 21.4 |
| Tong: full restart, Welcome | 170.2 → 169.6 | 19.0 → 19.1 | 9.6 → 9.6 |

The large SyncTeX-related native footprint is already present in v0.2.1. On
Lurie, adding compiled comments raised native RSS from about 28 to 463 MiB in
both versions. Compiled-comment live JS heap was also nearly identical. Tong's
map was already loaded during preview/navigation in both runs.

There is a measurable additional main-renderer heap cost in v0.3.0 during the
standalone-comment workload. After 40 comments, the version difference was
25.7 MiB on Lurie and 18.6 MiB on Tong. After deletion, the differences remained
25.4 and 17.6 MiB. This supports the new source-lifetime page/range caches being
an additional cost, but is not an isolated measurement of those objects alone.
After project closure, the heap differences shrank to roughly 0.6–0.7 MiB;
after restart both were about 9.6 MiB.

Resident-memory differences are less uniform. Lurie's renderer RSS was higher
in v0.3.0, including before standalone comments, despite nearly equal compiled
comment heap/canvas measurements. Tong's renderer RSS was slightly higher after
40 comments but lower immediately after deletion. These samples include
worker/WASM, Blink/graphics, and allocator effects outside the main JS heap.
They do not establish that the new caches account for every RSS difference or
that v0.3.0 universally consumes a fixed percentage more RAM. Worker/graphics
allocation profiling and repeated order-balanced runs would be needed to assign
the remaining resident difference precisely. This is one matched run per
version/project, not a statistical estimate across machines or all workloads.

The common comparison excludes chat-history Find, which does not exist in
v0.2.1; the separate search measurements above still apply when that feature is
used. The comparison confirms a large pre-existing PDF mapping cost alongside
additional v0.3.0 annotation-related heap retention.

Raw reports: `compare-v021.json`, `compare-v030.json`, and
`release-comparison-summary.json` under ignored
`output/playwright/long-paper-comments/`. Reproduce with the common-feature mode
and fixed plan documented in
[long-paper performance](long-paper-performance.md#pdf-comment-memory), pointing
`CATALEX_LONG_COMMENT_EXECUTABLE` at each separately built release-tag app.

## Cache-lifetime fix verification

The implemented fix is described in findings 3 and 4. Full page geometry now
lives through preparation or an active drag. Preparation retains endpoint
offsets and releases geometry immediately. Completed/canceled drags, dismissal,
deletion, source replacement, and unmount release cached pages. Selection-range
recovery belongs to each composer while its PDF selection is live, with pruning
for removed, resolved, and replaced anchors. Generation and request-identity
checks discard stale work.

The final paired runs used the preserved pre-fix renderer from `92a9a9d` and the
fixed renderer built from that commit plus the uncommitted cache changes. Both
use Electron 44.4.2. The fixed build's native helper was copied into the
temporary pre-fix app, which was re-signed and verified, to make the backend
byte-identical. Main and preload bundles also match byte for byte. The provenance
file records ASAR, native, main, and preload hashes.

Both projects passed on both builds with separate temporary profiles, 40 control
and standalone-comment pages, 24 Lurie or 3 Tong compiled comments, two revisit
passes, 30 saved resizes across 20 distinct anchors, deletion, project closure,
worker shutdown, restart, and source hash verification. Builds and other tests
were stopped during measurement. Viewports were 1440 × 1000 at DPR 2.

The probe now awaits published selection UI after the viewer's debounce and
checks dismissal of badges and resize handles. Resize targets use explicit SVG
glyph positions at non-whitespace boundaries, with enough trailing text to keep
the handles separately accessible. Every drag must move the preview and change
its native saved anchor. Deletion must clear native comments and rendered
highlights before sampling. Earlier coordinate pilots are excluded from this
comparison.

The compiled setup has two observed differences. One Lurie selection on page
647 had 107 characters before the fix and 108 afterward. Tong's generated PDFs
were 1,309,964 and 1,309,966 bytes. Page plans, page counts, all 40 standalone
selection lengths, all 30 persisted resize text transitions, viewport, and
canvas samples matched within each project. The input sources were hash-verified.

### Observed memory

Values are MiB. Heap is main-renderer JS after two forced collections. The
deletion sample below includes a further five-second idle interval. Renderer
RSS includes the PDF worker. Native RSS is the Rust service.

| Project / stage | JS heap before → fixed | Renderer RSS before → fixed | Native RSS before → fixed |
| --- | ---: | ---: | ---: |
| Lurie / standalone navigation control | 182.1 → 182.0 | 1,256.5 → 1,185.7 | 468.2 → 461.1 |
| Lurie / 40 comments, dismissed | 209.1 → 184.6 | 1,327.9 → 1,226.0 | 470.6 → 465.6 |
| Lurie / idle after deletion | 189.4 → 164.8 | 1,520.4 → 1,436.3 | 474.4 → 468.6 |
| Lurie / project closed | 86.7 → 86.7 | 1,094.1 → 1,037.7 | 474.4 → 468.6 |
| Lurie / restarted Welcome | 9.6 → 9.6 | 170.4 → 169.7 | 18.7 → 18.7 |
| Tong / standalone navigation control | 102.3 → 102.3 | 770.9 → 762.1 | 98.9 → 94.7 |
| Tong / 40 comments, dismissed | 115.7 → 97.9 | 853.0 → 831.3 | 100.6 → 97.9 |
| Tong / idle after deletion | 118.0 → 100.2 | 937.5 → 935.7 | 101.6 → 99.5 |
| Tong / project closed | 21.0 → 21.0 | 615.8 → 603.2 | 101.6 → 99.5 |
| Tong / restarted Welcome | 9.6 → 9.6 | 170.5 → 169.9 | 18.9 → 18.7 |

The observed retained-heap reduction after deletion was **24.6 MiB on Lurie and
17.8 MiB on Tong**. Similar reductions persisted through the revisit and resize
stages. Pre-annotation control heaps closely matched, and post-close heaps
converged. These measurements support releasing the additional annotation cache
retention while the PDF remains open. They measure the combined cache fix.

Renderer RSS already differed before standalone comments by about 70.8 MiB on
Lurie and 8.8 MiB on Tong. After deletion its differences were 84.1 and 1.8 MiB.
The full resident differences therefore cannot be assigned to the cache changes.
PDF-worker/WASM, rendering, native SyncTeX allocation, and allocator effects
contribute to the remaining footprint. This is one sequential paired run per
build/project on macOS ARM64.

### Checks for the fix

- Renderer tests passed with 1,565 tests, including the new cache-lifetime cases.
- Electron main/host tests passed with 117 tests. Root script tests passed with
  37 tests.
- Biome CI, branding/version checks, Electron main/preload types, frontend
  TypeScript/Vite build, desktop build, and local packaging passed. Packaging
  used ad-hoc signing.
- All five PDF browser cases passed, including multiline resize, undo,
  selection-badge overlap, focus-outline identity, sharing, and deletion.
  The settled selection-badge screenshot was inspected and retained as
  `output/playwright/long-paper-comments/cache-fix-selection-badges.png`.
- The actual Electron PDF smoke passed resize undo/redo, selection badges,
  same-name isolation, cross-window sharing, restart persistence, binary
  immutability, and replacement disconnection.
- The combined browser run had 16 passes and four failures in the broader chat
  harness. All four cases also failed on unchanged v0.3.0 source. They concern
  custom-answer selected text, a badge-removal count, a removed PDF card lookup,
  and an inset-style assertion. The custom-answer case also had an intermittent
  earlier focus failure. Its isolated rerun reproduced the baseline truncated
  text assertion at line 133. Detailed logs are retained in the task's temporary
  verification files.

Raw reports are `cache-before-final.json`, `cache-fixed-final.json`,
`cache-comparison-summary.json`, and `cache-build-provenance.json` under ignored
`output/playwright/long-paper-comments/`. Both final runs have driver SHA-256
`94edac0a757dc86712752674a0c3ec81af4a3af534da2e731e5093beb5c43a7f`.
The earlier `cache-before.json` and `cache-resize-pilot*.json` files are pilot
records. The comparison summary records the compiled-input differences above.

A subsequent review removed redundant anchor-based cache replacement, duplicate
comment eligibility checks, and a generation check already covered by promise
identity. Cleanup still invalidates anchor changes and late requests. After this
cleanup, all 1,565 renderer tests, TypeScript, Biome CI, five PDF browser cases,
and the native Electron PDF smoke passed. The packaged builds and memory tables
above precede this behavior-preserving cleanup.

A second review added three race cases covering overlapping dismissed/replacement
requests, direct anchor replacement during page loading, and deletion after one
anchor resolves while another page is pending. All 1,568 renderer tests,
TypeScript, Biome CI, and diff checks passed. The reviewed production code passed
these additional cases.
