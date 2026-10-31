<p align="center"><img src="apps/desktop/build/icons/128x128.png" width="88" height="88" alt="Catalex app icon" /></p>

<h1 align="center">Catalex</h1>

<p align="center"><strong>A catalyst for your next paper.</strong><br />An open-source, local-first LaTeX workspace with agent assistance.</p>

<p align="center"><img src="assets/readme/reaction.svg" width="620" alt="Human research plus agent collaboration, catalyzed by Catalex, produces a paper." /></p>

<p align="center"><img src="https://img.shields.io/badge/Download-available_soon-27272a?style=for-the-badge&amp;logo=apple&amp;logoColor=white&amp;labelColor=27272a" alt="Download available soon for macOS" /></p>

![Reviewing agent changes in a sample LaTeX project, with the proposed edits and compiled PDF visible.](assets/readme/agent-review.png)

## Why Catalex?

- **Built for writing.** A clean, polished workspace that keeps writing in focus and makes working with agents feel natural.
- **Bring your own agent.** Use local Claude Code, Codex, or Pi with your existing subscriptions and skills, connected to your project and Catalex's writing tools.
- **Draft first, approve later.** Agents prepare changes in a private draft; you choose what to apply.

| | Catalex | OpenAI Prism | ClaudePrism | IDE + extensions |
| --- | :---: | :---: | :---: | :---: |
| Dedicated writing app | ✓ | ✓ | ✓ | |
| Local files and compilation | ✓ | | ✓ | ✓ |
| LaTeXmk support | ✓ | — | | ✓ |
| Switch agent providers in one chat | ✓ | | | |
| Built-in agent worktrees | ✓ | | | ✓ |
| Agents can create and resolve comments | ✓ | | | |
| Edit history and recovery | ✓ | ✓ | ✓ | ✓ |
| Overleaf / GitHub sync through the app's Git GUI | ✓ | | | ✓ |
| Live co-editing | | ✓ | | |

## Documentation

See the [user guide](https://ricercarg.github.io/catalex.github.io/docs/) for setup, writing, agents, and syncing your project.

## Current limitations

- **macOS only.** Current releases support Apple Silicon Macs.
- **Comments stay local.** Catalex comments do not sync to Overleaf or GitHub.
- **No live collaboration.** Catalex is local-first. Collaborators can sync project files through GitHub, but shared multi-user editing is not supported.

## Acknowledgments

Catalex started from [ClaudePrism](https://github.com/delibae/claude-prism), which builds on [Open Prism](https://github.com/assistant-ui/open-prism). Its writing workflow takes inspiration from [OpenAI Prism](https://openai.com/index/introducing-prism/), [Overleaf](https://www.overleaf.com/), and [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop).

Special thanks to [OpenAI Codex](https://openai.com/codex/) for helping bring Catalex to life.

The icon was drawn in Figma by [RicercarG](https://github.com/RicercarG), inspired by the [reference illustration](assets/icon-source/assets/cat-reference.png) below.

<img src="assets/icon-source/assets/cat-reference.png" width="112" height="63" alt="Online cat illustration used as a reference for the Catalex icon" />

Cheers!
