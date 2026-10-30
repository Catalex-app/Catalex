# PDF performance stress test

This opt-in benchmark opens generated image-heavy PDFs in the actual production
Electron app. It exercises native file loading, MuPDF, React layout, and canvases.
It complements the deterministic scheduling and cache regressions; it does not
set hardware-independent timing thresholds.

## Running

From the repository root, with the desktop host/native helper already built:

```sh
# Fixture generation requires Python with numpy and Pillow >= 10.1.
python3 apps/desktop/e2e/pdf-performance-fixture.py output/playwright/pdf-performance/fixtures

# Refresh the production renderer after renderer changes.
npx --yes corepack pnpm -C apps/desktop build

CATALEX_PDF_PERF_RUN=local node apps/desktop/e2e/electron/pdf-performance-smoke.mjs
```

Use `pnpm build:desktop` first when host/native assets also need rebuilding.
Set `CATALEX_PDF_PERF_CASES=100p-4k` to run one case. The generator accepts
`--case 100p-4k` as well. Generated PDFs, JSON results, and screenshots stay under
ignored `output/playwright/pdf-performance/`; the three PDFs consume about
2.42 GiB. Existing fixtures are reused.

Each case starts a fresh Electron process with an isolated temporary profile,
opens a real project/PDF, and fixes the window at 1440 × 1000 after workspace
restoration. The test performs three six-click zoom bursts (40 ms apart),
400% and 1200% zoom, three pans across an embedded figure at 1200%, a simulated
pinch, window resizes, five seconds of continuous scrolling, a visit to every
page, and a return to the first page. It verifies all pages obtain pixels and
that no uncaught renderer errors occur. Screenshots show ordinary zoom, a
high-zoom figure region, and the last page.

Opening time runs from initiating the PDF click until the first canvas publishes
pixels. Zoom response tracks the first animation frame with changed page width;
sharpness time ends when the requested raster scale is published. These timings
include automation/polling overhead. Worker measurements span dispatch to reply,
excluding time waiting in the client queue. `requestAnimationFrame` intervals
measure main-thread frame scheduling, not GPU presentation or physical display
FPS. Clicks, wheel events, and scrolling are automated rather than physical input.

Memory samples use Electron's per-process working set and CDP main-renderer heap
metrics. Canvas estimates are backing width × height × four bytes. These samples
are not continuous peaks or a disjoint accounting of physical RAM. The Tab
process includes the renderer's worker; CDP heap figures do not account for all
MuPDF worker/WASM/native allocations. The last sample forces main-renderer GC,
without clearing the PDF or its worker cache.
