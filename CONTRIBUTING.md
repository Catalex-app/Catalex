# Contributing to Catalex

Contributions are welcome. Start with the guide for the work you want to do:

- [Development setup](docs/development/setup.md) — dependencies, running the app, and builds.
- [Architecture](docs/development/architecture.md) — packages, process boundaries, and file locations.
- [Testing](docs/testing/README.md) — test placement, runners, and browser or Electron checks.
- [Releases](docs/development/releases.md) — versions, checks, tags, and draft releases.

For help using the app, see the [user documentation](docs/README.md).

## Making a change

1. Fork the repository and create a branch for your change.
2. Keep the change focused and update the relevant documentation.
3. Run the checks and tests for the code you changed. Inspect rendered behavior for UI changes.
4. Open a pull request with a short explanation and the checks you ran.

Use simple English and follow the existing components and styles. Frontend formatting uses Biome; Rust follows `rustfmt`. Keep generated output, credentials, and personal project data out of commits.

Useful commit prefixes are `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `ci:`. The pre-commit hook checks and formats staged files with Biome.
