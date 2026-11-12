# Browser demos

Demos open the real UI with sample data and simulated backend responses. Their
source is tracked in Git; dummy files live in memory or browser storage, not in
your manuscript folders. Browser settings can persist between demo visits.
The debug demos and onboarding demo are development-only.

Start Vite from the repository root:

```sh
pnpm -C apps/desktop dev --host 127.0.0.1 --port 4173
```

Open a starting point at `http://127.0.0.1:4173`:

| Demo | Path | Options |
| --- | --- | --- |
| Workspace — documents, previews, comments, and layouts | `/?debug=comment-workspace` | Add `&pdf` for LaTeX/PDF |
| Agent workflow — proposals, review, and revision | `/?debug=agent-file-review&textReview` | Add `&queueDemo` to start with an agent working |
| Onboarding — setup and first project | `/?onboarding-demo` | |

Use the existing app controls to continue each workflow.

<details>
<summary>Specialized test screens</summary>

These support focused regression tests. Most development work can start with
one of the three demos above. For a longer Markdown/LaTeX review project, use
`/?debug=agent-file-review&acceptanceDemo`.

Each name below opens at `/?debug=<name>`. There are 40 debug routes, plus the
onboarding demo above and the typing-performance page below. Variants in the
same route are not counted as separate demos.

### Workspace and documents

| Name | Purpose |
| --- | --- |
| `comment-workspace` | Full workspace with comments and editor/preview layouts |
| `markdown-workspace` | Full workspace with Markdown files and a theme fixture |
| `markdown-preview` | Focused Markdown rendering, themes, and scroll synchronization |
| `csv-workspace` | CSV editing and preview |
| `pdf-preview` | PDF preview behavior |
| `pdf-comments` | PDF comment selection, positioning, and navigation |
| `editor-comments` | Editor comment anchors, selections, and edits |
| `editor-diff` | Editor proposals, conflicts, and review positioning |
| `editor-search` | Editor search |
| `editor-scroll` | Editor scrolling |
| `editor-minimap` | Minimap markers and navigation |
| `latex-scroll-sync` | LaTeX editor/PDF synchronization |
| `latex-multifile-scroll-sync` | Synchronization across LaTeX source files |
| `external-files` | External file handling |

### Agent and chat

| Name | Purpose |
| --- | --- |
| `agent-file-review` | File proposals, acceptance, feedback, and revision |
| `agent-three-way` | Conflicts between source edits and agent changes |
| `agent-pause` | Agent pause, stop, and continuation |
| `agent-concurrency` | Concurrent agent work |
| `agent-activity` | Agent activity display |
| `agent-verify-skill` | Agent skill verification |
| `chat-images` | Images in chat |
| `chat-branching` | Conversation branching |
| `session-navigation` | Switching chat sessions |
| `input-transfer` | Composer transfer between drawer and workspace |
| `claude-models` | Model selection |

### Projects, history, and Git

| Name | Purpose |
| --- | --- |
| `new-project` | New-project flow |
| `project-navigation` | Project switching through the app |
| `history-workspace` | History inside the workspace |
| `history-management` | History management controls |
| `git-actions` | Git actions and recovery cases |
| `git-three-way` | Git conflict resolution |
| `git-buffers` | Git changes and editor buffers |
| `git-credentials` | Git authentication controls |

### Settings and UI details

| Name | Purpose |
| --- | --- |
| `updater` | Update UI states |
| `storage-settings` | Storage settings |
| `markdown-settings` | Markdown settings |
| `sidebar-animation` | Sidebar motion and overlap |
| `focus` | Focus handling |
| `context-menu` | Context menus |
| `tooltips` | Tooltips |

Typing performance has a separate page: `/dev/typing-performance.html?performance`.

## Where things live

- Routes: `apps/desktop/src/renderer/dev/render-debug-window.tsx`.
- Demo implementations: `apps/desktop/src/renderer/dev/harnesses/`.
- Shared sample documents: `apps/desktop/src/renderer/dev/fixtures/`.
- Browser regression tests: `apps/desktop/e2e/`.
- Generated screenshots and recordings: `output/playwright/` (local, Git-ignored).
- Built-in project templates: `apps/desktop/public/examples/` (product content,
  not disposable demo output).

Reuse an existing demo when it covers the case. Keep focused demos when their
layout or fixture serves a distinct regression test; similar names alone do not
make them duplicates. Update this list when adding or removing an entry point.

</details>
