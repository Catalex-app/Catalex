# Comments

Comments keep feedback attached to a passage, whether you are reading source, a rendered Markdown document, or a compiled PDF.

## Add and find feedback

Select a passage and use the comment action. The editor and previews show the same saved feedback. Use the comment controls to navigate and filter **All**, **Human**, or **Agent** comments, and hide the display when you want an uninterrupted reading view.

Edit a comment as your feedback develops, resolve it when addressed, or reopen it when more work is needed. Deleting a comment is a separate action with confirmation. Attach a comment to chat when you want an agent to work on a specific concern.

Choose a color in the selection toolbar, then click **Highlight** or **Comment** to use it. The toolbar remembers the last color you choose and shows the full palette on hover or keyboard focus. Click an existing highlight or comment, then choose a swatch to recolor it immediately. Use **Add comment** to write a note on a highlight, or save a human comment with blank text to turn it into a highlight. Highlights appear in comment navigation under their human comment number. Click **Remove highlight**, then **Delete?** to remove it. In the workspace, Undo restores the highlight. Highlights are excluded from chat attachments and agent tools.

## Keep comments with the text

Catalex tracks comment locations as the source changes, including file renames made through the app. PDF feedback is linked back to source where a source location is available. A changed or removed passage may need attention rather than an automatic match to unrelated text.

Comment text, passage anchors, author information, and resolved state are kept together in a local database. The source editor, preview, and agent tools all use that store, so they do not maintain separate copies of the same comment.

## Work with an agent

Agents can read, create, edit, resolve, and delete comments through [Catalex's document tools](agents.md#document-tools). Agent feedback records its origin so you can distinguish it from your own notes.

Comment actions are saved directly, separately from accepting a text draft. When an agent comments on a draft passage that no longer matches your source, Catalex can ask how to proceed.

When an agent addresses a comment with text it proposes, it can ask for that comment to be resolved on acceptance. The comment stays open while you review. Catalex resolves it once you accept every edit the draft proposes in that file. It stays open if you reject or rewrite one of those edits, or if you edit or resolve the comment yourself first.

## Save and share

Comments stay in Catalex's local app data; they are not inserted into your `.tex` or Markdown files. They do not currently sync to Overleaf or GitHub. To preserve them along with a project, back up [Catalex's local data](sync-and-recovery.md#backups-and-local-data) as well as the source folder.
