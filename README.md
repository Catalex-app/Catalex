<p align="center"><img src="apps/desktop/build/icons/128x128.png" width="88" height="88" alt="Catalex app icon" /></p>

<h1 align="center">Catalex</h1>

<p align="center"><strong>A catalyst for your next paper.</strong><br />An open-source, local-first LaTeX workspace with agent assistance.</p>

<p align="center"><img src="assets/readme/reaction.svg" width="620" alt="Human research plus agent collaboration, catalyzed by Catalex, produces a paper." /></p>

<p align="center"><a href="https://github.com/RicercarG/Catalex-public/releases/download/v0.1.0/Catalex-0.1.0-arm64.dmg"><img src="https://img.shields.io/badge/Download-v0.1.0-27272a?style=for-the-badge&amp;logo=apple&amp;logoColor=white&amp;labelColor=27272a" alt="Download v0.1.0 for macOS (Apple Silicon)" /></a> <a href="https://ricercarg.github.io/catalex.github.io/"><img src="https://img.shields.io/badge/Website-555555?style=for-the-badge" alt="Website" /></a></p>

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

## Desktop development and builds

See [Contributing](CONTRIBUTING.md), [build commands](docs/desktop-setup.md#desktop-development-and-builds), and [the repository map](docs/architecture.md).

## Current limitations

- **macOS only.** Current releases support Apple Silicon Macs.
- **Comments stay local.** Catalex comments do not sync to Overleaf or GitHub.
- **No live collaboration.** Catalex is local-first. Collaborators can sync project files through GitHub, but shared multi-user editing is not supported.

## Acknowledgments

Catalex builds on and takes inspiration from:

- [ClaudePrism](https://github.com/delibae/claude-prism), our starting point.
- [Open Prism](https://github.com/assistant-ui/open-prism), ClaudePrism's foundation.
- [OpenAI Prism](https://openai.com/index/introducing-prism/)
- [Overleaf](https://www.overleaf.com/)
- [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop)
