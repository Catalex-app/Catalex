# What the agent cannot change

These are the user's settings and decisions. No tool changes them. When one of them is the cause of a problem, tell the user which one and where to change it, then stop working around it.

## LaTeX root folder and main file

- **Where:** the arrow next to **Recompile** in the preview opens **Compilation options**. **LaTeX root** is the folder the compiler runs in. **Main file** is the document that is compiled.
- **Defaults:** the root is the project folder, and the main file is found automatically inside the root folder. A main file the user chose takes precedence over the open file and over magic comments.
- **What you see:** `compile` reports `rootFile` and `rootFolder`, and `workspace_state` reports `root.file` and `root.folder`, relative to `projectPath` (an empty folder means the project folder). `chosenByUser` says for each whether the user set it or the app found it.
- **Typical problems:** the build compiles a different document than the one you edited; a file is "not found" because paths resolve from the root folder; a chosen folder or file no longer exists.
- **What to do:** do not move files, add magic comments, or rewrite `\input` paths to force another root. Say what the root folder and main file are and ask the user to change them in **Compilation options**.

## Compiler and engine

- **Where:** **Compiler settings** in the same menu for this document; defaults in **Settings → Rendering**.
- `workspace_state` reports the backend and engine. `compile` reports the engine that actually ran.
- A missing TeX installation or package is fixed by the user, not by editing the document to avoid it.

## Automatic compilation

- Set per project by the user. Your `compile` tool works either way.

## Draft review and approval mode

- Your edits go to a draft. The user accepts or rejects them in the app; **Manual** or **Auto** approval is chosen in the composer.
- You cannot accept your own draft, and you learn the decisions only in the user's next message. Never assume proposed text was accepted.
- A comment that your proposed text addresses is resolved with `resolve_comment` and `when: "accepted"`.

## The project outside the draft

- Do not write to the original project folder. Work in the current working directory.
- Comments live in the app's store. Change them with the comment tools, never through files.

## Global and project instructions

- **Settings → Agent → Global Instructions** and the project's `CLAUDE.md` or `AGENTS.md` (opened from **System Prompts** in the sidebar) belong to the user. Suggest a change; edit the project file only when asked.

## Accounts, models, and limits

- Sign-in, the model list, and usage limits belong to the agent provider. The user picks the provider, model, and effort in the composer.
