# Agent harnesses

Catalex supports Claude Code, Codex, and opt-in Pi. Enable Pi in **Settings → Agent → Pi** after installing and configuring it in the terminal. Pi must support native MCP and the scoped-model extension API; the integration is checked against Pi 1.2.0. Catalex does not install Pi or manage its credentials.

## Boundaries

`src/renderer/lib/agent-harness.ts` holds the small app-facing lifecycle and capability registry. The chat store owns conversation handoff, draft preparation, review and persistence. Each native adapter owns its CLI protocol and emits app chat events. Pi uses the existing activity and completion handlers, including background-tab routing and draft reconciliation.

Pi model selections encode a pair of model service and model ID. This distinguishes identically named models from different services without treating those services as additional Catalex harnesses. Existing Claude/Codex settings and session fields remain compatible.

The model selectors use Pi's resolved scoped models (`enabledModels`, managed through `/scoped-models` in Pi), preserving their order. With no scope configured, they use Pi's available models. Discovery reads the selected user configuration through a temporary extension, with project-local Pi resources disabled just as in chat. Switching projects does not change the catalog. It does not cycle models or rewrite Pi settings.

Thinking choices follow each resolved model's `thinkingLevelMap`, using Pi's supported-level and clamping rules. Switching models preserves a supported effort or selects the next supported level, falling back to the highest lower level. Non-reasoning models hide the control and use `off`. Model selectors contain only concrete models. New or legacy default selections resolve to Pi's configured model when it is in scope, otherwise the first scoped model.

## Pi paths and skills

**Settings → Agent → Pi** has **Pi executable** and **Config folder** dropdowns. Their first choices are detected automatically: the executable from PATH and the usual install locations, and the config folder from `PI_CODING_AGENT_DIR` when set, otherwise `~/.pi/agent`. **Add new** opens a file picker for the executable (`pi`, including symlinks, or `pi.exe`/`pi.cmd` on Windows) and a folder picker for the config. Previously saved installation folders still resolve `pi` directly or from `bin/`. Custom config folders must exist.

Each path has a remove button that only removes it from the saved list. Removing the selected path selects the first remaining choice; removing the last leaves the selection empty until another path is added. Removed defaults are not re-added automatically. Verification runs on selection and shows the installed version, with a refresh button to check again. Invalid choices show an error instead of falling back silently.

The selected executable path is preserved, including symlinks. Launching also searches the symlink targets and installation prefix for the Node runtime so GUI launches can work with a minimal PATH.

Version probes belong to setup verification. Messages, resumed turns and compaction launch Pi directly, retaining path validation and normal process/RPC error reporting without a separate `pi --version` process.

The executable picker preserves the selected symlink path on macOS. The dropdown, saved selection, and Pi launch use that path, so changing the symlink target is reflected on the next launch. Previously saved resolved target paths must be reselected to use the symlink instead.

Both choices persist across windows and restarts. Status checks, scoped model discovery, skill discovery, and new/resumed chat turns all receive the same selected paths. Changing paths clears the old model catalog and refreshes discovery; late results from the previous setup are ignored. Running turns keep their launch configuration, and existing conversations remain in Catalex's session storage.

The slash picker asks the selected Pi once for `get_commands` and shows its loaded user skills, including nested skills, configured resource paths and package resources. Discovery and chat execution both use Pi's native `--no-approve` option, skipping project-local Pi settings, skills, extensions and MCP configuration. User-configured extensions still load. Names and source scopes come from Pi. The same Catalex skills are supplied during discovery and chat execution. Other Pi terminal commands and extension dialogs are not added to the picker.

Selected skills keep `/skill:name` at the beginning of the request, outside the attached context and history wrappers. Pi performs the skill lookup and expansion. Catalex tool guidance uses Pi's `--append-system-prompt` option.

## Pi runtime

The Rust service runs the selected `pi --mode rpc --no-approve` directly in the current draft. The selected config folder is passed as `PI_CODING_AGENT_DIR`; Pi loads its user settings, skills, extensions and packages natively. Project-local Pi configuration is skipped even when mirrored into the draft. Context files are separate: Pi still reads `AGENTS.md` and related instruction files from the selected agent directory, the draft and its ancestors. Original-project instructions reach Pi through the ordinary draft copy, not a separate source-project lookup. Catalex does not duplicate those instructions in prompts. Its optional global prompt and document-tool guidance still apply.

A subprocess is scoped to one turn; subsequent turns resume its native JSONL session in Catalex's `pi-sessions` data directory. Only Catalex-owned session files can be resumed. New and resumed session paths use the same canonical identity, preventing concurrent use through path aliases. On resume, the session header points to the current draft and the conversation log is preserved. After acceptance, the next turn starts in the new draft with the same conversation. Instructions and user extensions load again at startup. Historical paths remain in the transcript; guidance identifies the current working directory.

Pi normally saves sessions under `<agent-dir>/sessions/`, grouped by working directory. Catalex supplies an explicit `--session <file>` so a conversation has one stable file across drafts. On macOS this is `~/Library/Application Support/com.catalex.desktop/pi-sessions/<id>.jsonl`; Pi handles the native session contents and persistence. Catalex also saves the visible chat and provider references through its shared chat storage under `projects/<project-id>/sessions/` in the same app data directory. Neither depends on keeping an accepted draft.

An embedded extension registers the existing authenticated Catalex MCP endpoint. Its credential is scoped to the active turn and revoked on completion or cancellation. Compilation, PDF inspection, comments and user questions use the same backend services as the other harnesses. User Pi configuration is not rewritten.

Pi runs with normal user permissions, like the installed CLI. Catalex adds no sandbox extension, file-tool guards or shell wrappers. Native tools use the draft as their working directory, and prompt guidance asks Pi to keep project edits there for review. This is not an OS restriction: Pi and its user extensions can access or modify other paths permitted by the user's account. Catalex's authenticated MCP service retains its existing host-side permissions and validation. Arbitrary terminal extension dialogs are not rendered in Catalex: they produce a clear error, while Catalex's `ask_user` remains available.

`/compact` resumes the current Pi session and calls its native compaction RPC. It uses the selected executable, config, model and supported thinking level, running in temporary scratch space so compaction remains available after the draft is accepted or removed. The next normal turn updates the session working directory to its current draft. The context meter uses Pi's estimated tokens after compaction when available. As with the other agents, text after `/compact` is queued as a normal follow-up; failure or cancellation keeps it paused. The visible transcript and provider handoff cursors are preserved. Pi's own automatic compaction remains native to Pi. Its compaction/retry events update the chat status and context meter. Extension hook errors and compaction/retry failures appear in the transcript without stopping a turn that Pi can continue; discovery hook errors are reported by setup.

The integration does not expose subscription usage or terminal extension UI. Model requests can still fail for missing/expired credentials; model discovery is not a paid authentication probe.

## Verification

- Renderer tests cover Pi launch/resume routing, session restoration and cross-harness handoff, background events, errors, pause/cancel and draft reconciliation.
- `e2e/pi-provider.spec.ts` checks opt-in setup, saved path selection/addition/removal, cancellation, duplicate and invalid paths, and model/effort selection in the existing rendered harness.
- `e2e/electron/pi-smoke.mjs` uses an isolated profile and a deterministic Pi protocol fixture with the actual Electron/Rust/MCP stack. It checks automatic and custom executable/config paths (including spaces), loaded skill metadata, native compaction/cancellation/failure, session resume after restart, and that Pi's version probe cannot alter the service input pipe while other requests arrive. It also verifies that messages and compaction add no version probes, while explicit verification still runs them. It does not make paid model requests.
- Rust Pi tests check protocol parsing, session boundaries and native adapter behavior. Installed-Pi probes are separate from deterministic protocol tests.
- `e2e/electron/pi-native-smoke.mjs` uses the installed Pi with a local scripted provider. It checks the selected user configuration, ignored project resources, native user/draft instructions, draft writes/edits and shell execution, and source reads without paid inference. The Electron smoke checks the MCP connection and conversation resume after acceptance and restart into a new draft.

After `npx --yes corepack pnpm build:desktop`, run the Electron smoke from the repository root with an installed `latexmk` and `pdflatex`:

```sh
CATALEX_SERVICE_PATH="$PWD/apps/desktop/dist/native/catalex-desktop" node apps/desktop/e2e/electron/pi-smoke.mjs
node apps/desktop/e2e/electron/pi-native-smoke.mjs
```

Runtime verification is on macOS. Windows/Linux build support does not establish runtime parity.
