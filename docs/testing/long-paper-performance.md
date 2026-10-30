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
