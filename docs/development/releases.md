# Releases

1. Run `pnpm version:set <version>` with the approved version.
2. Add `## [<version>]` at the top of `CHANGELOG.md` and write the user-facing
   changes underneath it. Use `## [Unreleased]` for notes not assigned a version
   yet; move those notes into the version entry before releasing.
3. Run the required checks and `pnpm package:mac:signed` for stable releases
   (`pnpm package:desktop` for previews). Verify the signed installer as described
   below. The version command synchronizes
   the native crate version in Cargo.lock so locked builds can verify it. Commit the version files,
   changelog, and changes together on `main`.
4. Create an annotated tag on that commit:

   ```bash
   git tag -a v<version> -m "Catalex v<version>"
   ```

5. Click **Push origin** in GitHub Desktop; it includes annotated tags with
   their commits. For ordinary command-line pushes, enable this once per clone:

   ```bash
   git config --local push.followTags true
   ```

   Then `git push origin main` includes the annotated version tag. To push only
   the intended branch and release tag explicitly, use
   `git push --atomic origin main v<version>`.

Use annotated release tags, not lightweight tags. Never recreate a tag that has
already reached GitHub just to change its type.

The current GitHub workflow builds preview macOS ARM64 DMGs for prerelease tags.
Stable tags do not trigger this unsigned workflow. For a stable release, run
`pnpm package:mac:signed`, verify and test the signed installer, push the annotated
tag, then create a draft with that exact DMG and the matching changelog entry.
GitHub Actions signing credentials must be configured before automating stable
release packaging. Windows and Linux
are not included in its build matrix.
It copies only that version's `CHANGELOG.md` entry into the release notes.
A mismatched tag/version, missing notes, or failing build prevents draft preparation.
Tags containing a prerelease suffix, such as `v0.1.0-beta`, prepare drafts
marked as prereleases. A version bump without a pushed tag does not prepare a release.
Use `0.1.0-beta` internally and `v0.1.0-beta` for the tag; the release title is
`Catalex Beta 0.1.0`. Further previews can increase the base version, such as
`0.1.1-beta`, without a separate beta counter. Each release gets a new version
and installer. Signing status is stated separately in the release notes.

The release job leaves the installer and changelog in a **draft release**. It
never publishes a release or changes which published version is Latest. Once the
workflow finishes, download the draft's DMG with maintainer access, test it, and
review the release notes. In GitHub Releases, edit the draft, choose its prerelease
and Latest status, then click **Publish release** when ready.

Rerun a failed workflow from GitHub Actions to retry. A rerun resumes incomplete
drafts and leaves completed drafts or published releases unchanged. Temporary
Actions installers expire after one day and are deleted sooner once their release
asset upload is verified, including while the release is still a draft. This does
not delete the release's installer. Keep Actions artifact usage within the account
allowance; starting a new private repository does not reset that allowance.

Manual runs against a branch only build; runs against a version tag can prepare
a draft. Release tags must point to a commit containing the release workflow.
Never move an existing release tag.

GitHub supplies the release token automatically; no personal token is required.
Repository Actions policies must allow the release job's `contents: write`
permission. Preview workflow installers lack publisher signing/notarization. Stable releases
use the signed local build described below. In-app automatic updates
remain disabled. Publishing downloads does not enable automatic updates.

The app checks the public GitHub Releases API without authentication. It selects the highest newer semantic version with a matching uploaded macOS ARM64 installer, ignoring drafts and unsupported prerelease channels. Stable builds only offer stable releases; beta builds can offer newer beta or stable releases. One Electron main-process service checks once on app launch, every 24 hours while running, and after wake only when a check is due. Failed checks retry quietly after one hour. Manual refresh checks immediately and resets the daily deadline; simultaneous requests join a single in-flight check. Windows subscribe to revisioned snapshots and read the latest state on startup. Opening About and navigating between Welcome and projects never initiate a check. Known notices remain visible during checks and temporary failures. Install update opens the corresponding GitHub release page for manual installation. Skip this version saves each skipped version in shared application settings and keeps it skipped across windows, restarts, and explicit refreshes. Other versions remain eligible. View release opens a skipped release’s page while preserving its skip. This does not use an updater feed, download installers, or restart the app.

Preview builds use ad-hoc macOS signatures for bundle integrity, with notarization
explicitly disabled. They do not identify a publisher. The workflow verifies the
packaged bundle with `codesign --verify --deep --strict` before preparing a draft.
Preview installers may require a manual security override; distribute the signed
installer for stable releases.

## Local signed macOS build

Install a Developer ID Application certificate with its private key in the login
keychain, then save notarization credentials interactively:

```sh
xcrun notarytool store-credentials "catalex-notary"
```

Build on a Mac with `pnpm package:mac:signed`. This command enables certificate
discovery, requires Developer ID signing, and notarizes and staples the app before
creating the DMG in `apps/desktop/release/signed/`. It never publishes a release.
Set `CSC_NAME` to choose an identity if multiple certificates are installed, or
`APPLE_KEYCHAIN_PROFILE` to use a different saved notarization profile. Passwords
and private keys must stay outside the repository.

Verify the resulting app with `codesign --verify --deep --strict`,
`xcrun stapler validate`, and `spctl --assess --type execute --verbose`.
Gatekeeper should report `Notarized Developer ID`. Also mount the final DMG and
test the app it contains before distributing it.

Regular build commands and the GitHub workflow still use preview signing; this
local setup does not configure GitHub Actions credentials or automatic updates.
