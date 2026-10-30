# Sidebar Animation Harness

Use this harness to validate sidebar collapse/expand animations on real rendered UI geometry.

## Launch

Start the desktop dev server (`pnpm -C apps/desktop dev`, port `14220`) and open:

`http://127.0.0.1:14220/?debug=sidebar-animation`

Optional autorun:

`http://127.0.0.1:14220/?debug=sidebar-animation&autorun=1`

## What It Checks

- Top panel collapse/expand in `files` mode (`files` section)
- Top panel collapse/expand in `sessions` mode (`sessions` section)
- Per-frame overlap invariant across visible sidebar sections
- Target panel height change across animation frames (ensures motion actually happened)

## Programmatic API

When the harness page is open:

- `window.__runSidebarAnimationHarness()` runs checks and returns a report
- `window.__sidebarAnimationHarnessReport` holds last report

The report includes:

- pass/fail
- per-check overlap maxima
- per-check height deltas
- per-check distinct frame heights
