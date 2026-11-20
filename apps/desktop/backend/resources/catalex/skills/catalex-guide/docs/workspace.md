# Your workspace

The workspace keeps writing and preview in two main panes. Agent interaction can stay compact until you need more room for a conversation.

## Artisan and Duet

Choose **Artisan** for focused writing or **Duet** for writing with an agent. In Duet, use **Mini**, **Half**, and **Full** to change how much space the chat occupies. You can adjust the layout without starting another conversation or losing the message you are composing.

Catalex remembers the workspace mode and chat layout for each project, so a paper and a notebook can open differently.

## Files and navigation

Use **Files** to open and organize the project. The **Outline** follows document headings so you can jump between sections. The editor's minimap gives a compact view of a longer document; its controls let you choose which layers to display.

Open another window when you need a second project. Catalex tracks which window owns a project to avoid opening two independent editing sessions on the same folder. Files changed in another editor are watched; conflicting saves ask you to reconcile the versions rather than silently replace the newer file.

## Appearance

In **Settings → Appearance**, choose light, dark, or system appearance, adjust app zoom, and set the editor font size and color scheme. **Artisan Theme** and **Duet Theme** each support **Classic** or **Modern**, independently of light and dark appearance.

The same section has spell-check, minimap, tooltip, and **Solarize** controls. [Markdown preview themes](writing.md#markdown) are separate from the workspace theme.

The **Cat** settings let you choose static text, your own text, or a conference-deadline countdown. For a countdown, choose a conference, time zone, and display precision. Deadline listings come from CCFDDL; check the conference's own information before relying on a date.

## Keyboard shortcuts

**Settings → Keyboard** lists configurable app shortcuts. Select a shortcut and press a new combination; use its reset control to restore the default. Search settings to jump to a control. Editor and chat keys also depend on the focused pane.

Common macOS defaults:

| Where | Shortcut | Action |
| --- | --- | --- |
| Editor | ⌘S | Save the active file |
| LaTeX editor | ⌘Enter | Recompile |
| Editor | ⌘F | Find in the active document |
| App | ⌘, | Open settings |
| App | ⌘⇧N | Open a new window |
| App | ⌘+ / ⌘− / ⌘0 | Adjust / reset app zoom |
| Chat | Enter / Shift+Enter | Send / insert a new line |
| Idle chat | Shift+Tab | Switch Manual / Auto review |
| Chat picker | ↑ / ↓, Enter or Tab, Esc | Navigate, select, close |

Type [`@` to add project files or `/` to discover commands and skills](agents.md#add-context). These pickers handle navigation keys while open, so Enter selects an item before sending your message.
