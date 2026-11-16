# Long LaTeX project performance

This opt-in benchmark exercises real arXiv sources in the production Electron application. This complements
the generated image-heavy [PDF benchmark](pdf-performance.md).

## Reproduction

From the repository root:

```sh
npx --yes corepack pnpm build:desktop
CATALEX_LONG_PAPER_RUN=local CATALEX_LONG_PAPER_ALL_PAGES=1 \
  CATALEX_LONG_PAPER_EXECUTABLE="$PWD/apps/desktop/release/mac-arm64/Catalex.app/Contents/MacOS/Catalex" \
  node apps/desktop/e2e/electron/long-paper-performance-smoke.mjs
```

Preparation requires Python with `tarfile`'s data extraction filter (Python
3.12+), internet access, and an installed TeX distribution for compilation.
Source archives and the additional legacy package have pinned SHA-256 hashes.
Each benchmark run downloads them into a fresh OS temporary directory and uses
isolated projects and Electron profiles inside it. A `finally` block removes that
directory after success or failure. Only reports and screenshots remain under
`output/playwright/long-paper/`; the papers are not stored in the repository.
Your own downloaded projects can live anywhere and are never used by this test.
A force-killed process may leave its temporary directory for OS cleanup.

Omit `CATALEX_LONG_PAPER_EXECUTABLE` to run the built production renderer through
the development Electron host. `CATALEX_LONG_PAPER_CASES=higher-topos` selects one
case. `CATALEX_LONG_PAPER_CYCLES=60` extends the default 20 view transitions.
`CATALEX_LONG_PAPER_PROFILE=1` captures typing CPU profiles; run profiling
separately from timing comparisons. Stop other builds/tests during measurement.

| Fixture | Pinned source | Source workload | Compiler |
| --- | --- | --- | --- |
| Jacob Lurie, *Higher Topos Theory* | [math/0608040v4](https://arxiv.org/abs/math/0608040v4) | 29 `.tex` files, 3,010,709 bytes; edit the 463,948-byte appendix | latexmk / pdfLaTeX |
| David Tong, *Lectures on String Theory* | [0908.0333v3](https://arxiv.org/abs/0908.0333v3) | One 495,378-byte `.tex` file; 55 original files including figures and class | latexmk / XeLaTeX |

The Lurie submission needs [CTAN multind 1.1b](https://ctan.org/pkg/multind), which
is downloaded into the fixture alongside the original source. XeLaTeX handles
Tong's EPS figures. The manifest records every input's byte count and checksum.
Original manuscript content is unchanged; the test inserts only LaTeX comments
in its temporary copies and checks the entire saved file against the expected text.

## PDF comment memory

Use the production desktop build for the comment workload:

```sh
CATALEX_LONG_COMMENT_RUN=local \
  node apps/desktop/e2e/electron/long-paper-comment-memory.mjs
```

On macOS this defaults to the built `release/mac-arm64/Catalex.app`. Set
`CATALEX_LONG_COMMENT_EXECUTABLE` for another packaged executable, or
`CATALEX_LONG_COMMENT_HOST=1` for the Electron host with production renderer and
native resources. It does not use Vite. `CATALEX_LONG_COMMENT_CASES` selects
`higher-topos`, `string-theory`, or both; `CATALEX_LONG_COMMENT_PAGES` defaults to
40 spread-out body pages. An already prepared root containing `fixtures/` can
be supplied with `CATALEX_LONG_COMMENT_FIXTURES`; originals are hash-verified
before copying.

The probe uses isolated project copies and profiles. Two Lurie source files have
legacy Windows-1252 bytes; only their temporary copies are converted to UTF-8 for
modern compilation and the native comment document reader. The report records
those paths, and final hashes verify no further source changes. Source archives
and supplied fixtures are unchanged.

Each case compiles through the real backend, visits the selected pages without
comments, measures a text selection alone, and adds comments through the PDF UI.
Compiled selections that cannot map to source are recorded separately; progress
labels count attempted pages, while `compiledComments` gives successful saves.
The exact compiled PDF is then copied into the test project as `reference.pdf`.
The probe adds standalone comments on the same pages, checks selection badges,
revisits the comments twice, performs 30 resize interactions, deletes comments,
closes the project, and restarts the application. Project closure must release
the MuPDF worker, and comment counts are read back through the native service.

Samples force main-renderer GC and record per-process working sets, native RSS,
renderer heap, DOM counters, worker URLs, and canvas backing estimates. They are
not continuous allocation peaks or disjoint physical-memory totals; renderer
heap excludes the PDF worker's WASM/native memory. Run without competing builds
or other benchmarks. Reports and screenshots stay under ignored
`output/playwright/long-paper-comments/`. See the
[v0.3.0 memory review](memory-review-0.3.0.md) for observations and limitations.

For comparisons with v0.2.1, set `CATALEX_LONG_COMMENT_COMMON=1` for **both**
versions. This keeps creation, selection, highlight activation, revisits,
deletion, close, and restart, while skipping resize controls and automatic
selection-badge assertions introduced later. Native readback still checks that
every standalone comment was saved on its intended page.

The driver waits for the viewer to publish its debounced selection before
continuing. Dismissal checks that comment badges and resize handles disappear.
Full-mode resize interactions must each produce a saved anchor change, with at
least 20 distinct anchors across 30 interactions. Deletion checks the native
count and removal of rendered highlights before memory sampling.

Use `CATALEX_LONG_COMMENT_PAGE_PLAN` with
`apps/desktop/e2e/electron/fixtures/long-paper-comment-plan.json` to attempt the
same 24 Lurie and 3 Tong compiled-comment pages in both versions. Keep the default
40 control/standalone pages with this plan. Set
`CATALEX_LONG_COMMENT_EXPECTED_VERSION` to verify the packaged and native
versions, and `CATALEX_LONG_COMMENT_REVISION` to the app's source commit when it
differs from the benchmark checkout. Reports include the driver hash, viewport,
page plan, and observed versions; compare runs with matching inputs and driver
hash. Build both versions before measuring and run them sequentially.
