# Private draft snapshots

Private history and agent drafts use `backend/src/private_files.rs` for internal directories, generated LaTeX files, OS files, and recorded PDF output. Ordinary source files and binary assets remain included even when the user's `.gitignore` excludes them. A `.gz` asset is retained; `.synctex.gz` is generated output. A PDF is excluded only when a sibling `.fls` recorder identifies it as output.

Explicit unsaved/new editor buffers are overlaid on the agent baseline and remain reviewable even with a generated-file suffix. Internal directories remain forbidden. Draft inventory additionally excludes root-level comment sidecars: agents edit comments through the comment service, not manuscript file review. Rewind records comments through its separate metadata coverage; existing root-level project comment files remain covered by history.

Preview scans candidate files afresh, writes their Git blobs one at a time, compares immutable trees, and materializes only changed baseline/candidate/source blobs. There is no persistent filesystem cache. Source/proposal revision guards, binary comparison, and Git rename detection remain in place. This change does not combine source/baseline commits.

## Reproducible measurement

Run the ignored native test `measure_large_project_preview` with the native dependency environment described in the project test setup. It uses 128 distinct 512 KiB binary assets, an 8 MiB generated `.aux` file, and one changed text file. It reports the median of five previews and the sum of private file lengths after those previews. This is logical file size, not filesystem allocated blocks or process memory.

## Old drafts

Only known version-1 copied-folder drafts are retired. No source edits are replayed or rolled back. An external retirement marker permits retry after partial private-directory deletion. Existing project files, comments, chat messages, elapsed time, and version-2 worktrees are preserved; unknown versions are not deleted. The renderer clears old review/queue/pause references and persists that cleanup, using the existing toast component for the notice.

Coverage includes native publication/rename/binary regressions, exclusion and explicit-buffer tests, interrupted retirement and unknown-version tests, renderer state cleanup tests, the paused-resume browser harness, and the Electron worktree smoke's mixed old/current restart scenario.
