# Writing

Open a source file and start writing. Catalex saves edits automatically after a short pause; **⌘S** saves immediately. Source files stay in your project folder, while compilation output is kept in Catalex's cache.

## LaTeX

Choose the main `.tex` file that brings the document together, then click **Recompile** or press **⌘Enter** in the editor. In a project with several files, compile the root document rather than an included section. The preview's root controls let you work with more than one document in a project.

Catalex supports **LaTeXmk** with your local TeX installation and the bundled **Tectonic** backend. Choose defaults in **Settings → Rendering**, and use the compilation options for the current document. LaTeXmk supports **pdfLaTeX**, **XeLaTeX**, and **LuaLaTeX**; Tectonic uses a XeTeX-based engine. **Auto** engine selection uses the document's engine hints. An explicit choice takes precedence, and Catalex remembers the choice for that root document.

Automatic compilation is set per project. Change its default for new projects in Rendering settings. For a large paper, turning it off and recompiling when ready can keep editing more responsive.

### Read and navigate the PDF

The PDF toolbar has page navigation, zoom, fit-width, fit-height, and export controls. Source/PDF navigation uses SyncTeX, and scroll synchronization can keep the two views near the same passage. Generated material may not map exactly to a source location.

Select text in the source or PDF to [leave a comment](comments.md) or [give an agent context](agents.md#add-context). The preview also supports opening an existing PDF without a LaTeX source project.

### Fix compilation errors

Open the compilation diagnostics and start with the first relevant error. Check the selected root, engine, installation, and missing packages. Attach an error to an agent conversation when you want help; the agent can use Catalex's compiler and inspect the resulting pages.

The app compiles a working copy outside your source folder. A failed build is reported as a failure rather than presented as a newly compiled PDF. LaTeXmk still uses the capabilities and configuration of your installed toolchain.

## Markdown

Markdown has a rendered preview, including math and tables, and can be exported to PDF. Use the formatting toolbar or familiar editing shortcuts while keeping the file as ordinary Markdown.

In **Settings → Rendering**, choose a preview theme. You can assign separate light and dark themes and load themes from a Typora theme folder. These settings change the preview's presentation, not your document's Markdown.

## Editing tools

Use find and replace to work through a document, and the outline or minimap to move through longer files. The formatting toolbar provides common text, heading, list, link, and math actions appropriate to the active document.

Spell check supports US and UK English and runs locally. In **Settings → Appearance**, enable it and choose the language. Use spelling suggestions or teach Catalex a word you want it to remember; code, commands, and other non-prose regions are handled separately from ordinary text.

For citations, use your existing `.bib` files or connect [Zotero](references.md). For feedback, see [Comments](comments.md). Earlier file versions are available in [Rewind](sync-and-recovery.md#rewind).
