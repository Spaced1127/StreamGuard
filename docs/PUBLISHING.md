# Publishing StreamGuard

This guide covers GitHub Releases and the browser stores. The extension code is
the same everywhere; only the package and store listing differ.

## Release artifacts

`npm run package` builds and writes to `release/`:

| File | Use |
| --- | --- |
| `streamguard-chrome-vX.Y.Z.zip` | Chrome Web Store upload, Edge Add-ons upload, or manual unpacked install |
| `streamguard-firefox-vX.Y.Z.xpi` | Firefox AMO submission, or temporary add-on for testing |
| `SHA256SUMS.txt` | Download verification |
| `RELEASE_NOTES.md` | GitHub Release body |

Both archives have `manifest.json` at the archive root, as required by the
stores.

## GitHub Releases

The repository has a `Release` workflow triggered by tags matching `v*`.

```bash
# 1. Update version + CHANGELOG.md
npm version patch --no-git-tag-version   # or minor / explicit version
# 2. Commit and push
git add -A
git commit -m "release: vX.Y.Z"
git push origin main
# 3. Tag and push the tag
git tag vX.Y.Z
git push origin vX.Y.Z
```

The workflow runs the typecheck/tests, builds both targets, packages the
artifacts, and creates the GitHub Release with the ZIP, XPI, checksums and
notes. Do not create the release manually unless the workflow fails.

## Chrome Web Store

1. Register a Chrome Web Store developer account (one-time fee).
2. Upload `release/streamguard-chrome-vX.Y.Z.zip`.
3. Store listing:
   - Name: **StreamGuard**
   - Description: local-first Twitch live-stream ad shield
   - Category: Productivity
4. Privacy practices:
   - The extension does **not** collect user data.
   - Data is stored locally with `chrome.storage` (settings and session stats).
   - Requests go only to Twitch (GQL token requests and Twitch CDN playlists).
5. Permission justification:
   - `storage` — save the on/off switches, overlay preference and session stats.
   - `*://*.twitch.tv/*` — inject the player hooks and read Twitch HLS playlists
     and GraphQL playback tokens. No other origins are accessed.
6. Submit for review.

Brave uses the Chrome Web Store. Once listed there, Brave users can install it
normally. Edge can use the same ZIP in the Edge Add-ons dashboard.

The extension uses a same-origin worker injection so it can intercept Twitch's
own playlist fetches. Store reviewers may ask about `eval`/dynamic worker code:
the code is Twitch's own player script, fetched from the Twitch page and
evaluated in a Twitch-origin blob worker. No third-party or remotely hosted
code is downloaded by the extension.

## Firefox AMO

Firefox release builds require signed add-ons. The XPI in the GitHub Release is
unsigned and only works as a temporary add-on (`about:debugging` → Load
Temporary Add-on) or in builds where signature enforcement is disabled.

To distribute permanently:

1. Create a free account at [addons.mozilla.org](https://addons.mozilla.org/).
2. Submit `release/streamguard-firefox-vX.Y.Z.xpi`.
3. Choose **On your own** (unlisted, direct distribution) or a public listing.
4. Provide the source repository URL when asked for build/source information.
   The extension is built with Vite/esbuild and minified; AMO may request the
   sources, which are in this repository.
5. AMO signs the XPI. Use the signed XPI for distribution or install directly
   from the AMO listing.

The Firefox manifest declares `data_collection_permissions: none` and
`strict_min_version: 142.0`.

## Versioning checklist

- [ ] Update `package.json` version and `CHANGELOG.md`
- [ ] `npm run check`
- [ ] `npm run package` (or let the Release workflow do it)
- [ ] Commit and push `main`
- [ ] Tag `vX.Y.Z` and push the tag
- [ ] Verify the GitHub Release assets and checksums
- [ ] Upload the same ZIP/XPI to the stores
- [ ] Update the store listings with the release notes

## Manual fallback

If the Release workflow is unavailable:

```bash
npm run package
gh release create vX.Y.Z \
  release/streamguard-chrome-vX.Y.Z.zip \
  release/streamguard-firefox-vX.Y.Z.xpi \
  release/SHA256SUMS.txt \
  --title "StreamGuard vX.Y.Z" \
  --notes-file release/RELEASE_NOTES.md
```

## Privacy

StreamGuard has no analytics, telemetry, accounts or external servers. Settings
and stats stay in the browser. See `NOTICE` for third-party credits and
`LICENSE` for the MIT license.
