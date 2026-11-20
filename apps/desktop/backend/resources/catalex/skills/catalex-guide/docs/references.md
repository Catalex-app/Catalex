# References

Keep using the bibliography files already in your project, or connect Zotero to create and refresh a `.bib` file from a collection.

## Connect Zotero

Open **Zotero** in the sidebar and connect your account through the browser. You can also enter an API key with access to the library you need. The connection is optional; editing and compiling do not require it.

Browser authorization requests read access to your library. Catalex uses the connection to read bibliography data; this integration does not edit your Zotero items or upload your manuscript to Zotero.

## Import a bibliography

Choose **My Library** or a collection and use its import action. Catalex creates a `.bib` file in the current project and remembers the collection associated with it. Compile a LaTeX document that uses that bibliography as usual; a missing citation may also require the appropriate bibliography package or build setup.

Each project keeps its own imported-collection list. Connecting one Zotero account does not require every project to use the same bibliography.

## Refresh references

Use the collection's sync action after changing items in Zotero. Catalex updates the linked bibliography and tracks Zotero items and citation keys. A collection refresh can replace the generated bibliography content, so make lasting metadata corrections in Zotero rather than relying on hand edits to that generated file.

The header's refresh action reloads the collection list. **Disconnect** removes the saved account connection. Removing a collection from Catalex stops tracking that import; it does not delete the collection in Zotero or remove the project's existing `.bib` file.

Your bibliography is an ordinary project file, so it can travel through [Git or Overleaf](sync-and-recovery.md). The Zotero connection itself stays in this Catalex installation.
