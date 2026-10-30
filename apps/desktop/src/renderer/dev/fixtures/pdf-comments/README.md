# Multipage PDF comment regression

`multipage.tex`, `.pdf`, and `.synctex` are a real three-page pdfTeX fixture.
Source line 6 wraps across two rendered lines on page 2. The old nearest-point
inverse lookup at those lines' centers returns source lines 5 and 7, discarding
both highlights. The selected text must instead match source coverage in both
text boxes.

Generate the PDF with `pdflatex -synctex=1 -interaction=nonstopmode multipage.tex`.
Decompress the resulting SyncTeX file and normalize its main input path to
`./multipage.tex`. `multipage-map.json` is the native `parse_source_map` result;
a Rust test checks that it stays in sync. The browser harness uses this result
at the Tauri boundary, so it exercises actual typesetting and native mapping.

Open `?debug=pdf-comments&multipage` in the Vite development server to inspect all three
pages, the wrapped agent comment, and the human comment on “selected phrase”.

`lists.pdf` and `hyperlinks.pdf` are also committed fixtures used by the PDF comments harness. Keep the explicit `.gitignore` exceptions so a fresh checkout contains these inputs on every development machine. Test harness routes are available in the Vite development server only; production debug windows show the normal diagnostics page.
