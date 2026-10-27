---
name: talemate-release
description: Release Talemate — preflight, version bump, tag, push, and monitor the GitHub Actions release that builds macOS DMGs, Windows NSIS, and Linux AppImage. Use when the user asks to release, publish, bump version, cut a version/tag, build installers, or check release status.
---

# Talemate Release

Cut a Talemate release: preflight → version bump → tag → push → GitHub Actions builds all platform
installers. The workflow lives in `.github/workflows/release.yml`; packaging config in
`desktop/electron-builder.yml`.

## Channels

| Channel | Tag | Release | When |
|---|---|---|---|
| `stable` (default) | `v0.2.0` | normal | Regular release |
| `beta` | `v0.2.0-beta` | pre-release | Preview / testing |
| `rc` | `v0.2.0-rc` | pre-release | Release candidate |

If the user does not specify, ask: stable or beta? Do not guess for a release.

## Step 1 — Preflight

```bash
git status --short
bun install --frozen-lockfile
bun run typecheck
bun test
```

- Working tree must be clean. If not, stop and ask the user to commit or stash; do not release
  uncommitted code.
- All checks must pass. Never tag on a red test.
- Optional desktop smoke build: `bun run desktop:build`.
- `bun run desktop:package -- --dir` is a local packaging smoke test; it is not required before a
  release because CI builds the real artifacts.

## Step 2 — Determine version

```bash
node -p "require('./package.json').version"
git tag --sort=-version:refname | head -5
git describe --tags --abbrev=0 2>/dev/null || true
```

If there is no tag yet, this is the first release: start at `0.1.0` (tag `v0.1.0`).

Propose the next version and show the user:

- patch: bug fix / packaging fix
- minor: user-visible feature
- major: breaking change
- beta: `<next-version>-beta`
- promote beta: same version without `-beta`

**Ask the user to confirm the exact version string before writing anything.**

## Step 3 — Bump root + desktop versions

The root `package.json` is the project version; `desktop/package.json` is the Electron app version.
Update both atomically:

Use one shell block so `VERSION` survives all the commands:

```bash
VERSION=0.2.0
export VERSION
node -e '
const fs = require("fs");
for (const file of ["package.json", "desktop/package.json"]) {
  const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
  pkg.version = process.env.VERSION;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
'
git add package.json desktop/package.json
git commit -m "Release v$VERSION"
git tag "v$VERSION"
```

Replace `0.2.0` with the confirmed version. If the command is split across separate shell calls,
re-declare `VERSION` in each. Tag format is always `v` + version (e.g. `v0.2.0-beta`).

If the same tag already exists, do not force it silently. Ask before deleting a local/remote tag; prefer
bumping to the next patch for a normal re-release.

## Step 4 — Push

```bash
VERSION=0.2.0
git push origin HEAD:main
git push origin "v$VERSION"
```

Or `git push origin HEAD:main --follow-tags`. Pushing the tag triggers `release.yml`. Re-declare
`VERSION` if this runs in a separate shell.

## Step 5 — Monitor Release

Find the run:

```bash
gh run list --workflow release.yml --limit 5
```

If `gh` is available and authenticated, watch it:

```bash
gh run watch <RUN_ID>
```

Otherwise report the Actions URL:

```
https://github.com/Sunshine334419520/talemate/actions/workflows/release.yml
```

When it finishes, verify the GitHub Release and assets:

```bash
gh release view "v$VERSION" --json url,assets
```

Expected assets:

```
Talemate-<version>-x64.dmg
Talemate-<version>-arm64.dmg
Talemate-<version>-x64.exe
Talemate-<version>-x64.AppImage
```

If `gh` is unavailable, open:

```
https://github.com/Sunshine334419520/talemate/releases/tag/v<version>
```

## Failure handling

- If `check` fails, fix the code and bump again; do not delete the tag unless the user explicitly asks.
- If one platform fails but others succeed, the release is not published by the workflow (publish needs
  all builds). Read the failed job log and fix that platform; then bump patch or re-create the tag with
  explicit confirmation.
- If only the release job fails after artifacts are built, the workflow can be re-run from the Actions UI;
  do not push a new tag just for that.
- macOS is unsigned; Windows is unsigned. Do not claim the installers are signed or notarized.

## Local packaging commands (for debugging, not for normal release)

```bash
bun run desktop:build
bun run desktop:package -- --mac --x64 --arm64
bun run desktop:package -- --win --x64
bun run desktop:package -- --linux --x64
```

Artifacts go to `release/` (gitignored).

## Notes

- One tag = one release. Do not push unrelated tags with `git push --tags`.
- Do not publish from a dirty tree.
- `desktop/electron-builder.yml` pins Electron for packaging; keep it in sync with the root
  `electron` devDependency when upgrading.
- The workflow sets `desktop/package.json` version from the tag as a second guard; the committed bump
  keeps local builds consistent.
- If the user asks for installers without a release, use the local packaging commands; a tag is only
  for a published release.
