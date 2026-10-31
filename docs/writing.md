# Writing

Open a file from the sidebar and start writing. Catalex saves your edits locally. Use **Artisan** for focused writing or **Duet** to work with an agent in the same workspace.

## Compile a LaTeX project

Choose the main `.tex` file that brings the document together, then use the compile control in the PDF preview. In a project with several files, compile the main document rather than an included section.

Catalex supports LaTeXmk with your local TeX installation and the bundled Tectonic backend. Setup and **Settings → Rendering** let you choose the compilation backend. Select the LaTeX engine your project needs, such as pdfLaTeX, XeLaTeX, or LuaLaTeX, when using LaTeXmk.

Turn on automatic compilation if you want the PDF to update while you edit. For a large project, compiling when you are ready can keep writing more responsive.

When a build fails, open the compilation errors and fix the first relevant error before compiling again. Check that the main file, engine, and required packages match the project. You can also attach the error to an agent conversation for help.

## Work with Markdown

Open a `.md` file to write with a rendered preview. Choose preview themes in **Settings → Rendering**; light and dark appearances can use different themes. Use the Markdown preview's PDF export when you need a shareable copy.

## Leave comments

Select a passage in the editor or PDF and add a comment. Comments keep feedback beside the relevant text; resolve them when the work is done. Agents can create and resolve comments too.

Comments are stored locally by Catalex. They do not travel with Git pushes or appear as Overleaf comments. See [Under the hood](under-the-hood.md#what-syncs) for what stays on this Mac.

## Make the workspace yours

Use **Settings → Appearance** for the workspace appearance, **Rendering** for document previews and compilation, and **Keyboard** to view or change shortcuts.

For larger edits, [ask an agent](agents.md). To recover an earlier version, use [Rewind](sync-and-recovery.md#rewind).
