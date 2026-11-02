# Install StreamGuard

StreamGuard is a local-first ad shield for Twitch live streams. It needs no
account, proxy server, analytics or external service. This guide covers manual
installation from a release archive, updating, and troubleshooting.

The same guide is included in every release archive as `INSTALL.md` and in the
GitHub release notes.

## Choose the right file

| Browser | File |
| --- | --- |
| Chrome, Brave, Edge | `streamguard-chrome-vX.Y.Z.zip` |
| Firefox 142+ | `streamguard-firefox-vX.Y.Z.xpi` |

Both files are attached to the latest GitHub Release. The archive root contains
`INSTALL.md`, `LICENSE`, `NOTICE` and `manifest.json`.

## Chrome

1. Download and unzip `streamguard-chrome-*.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked**.
5. Select the unzipped folder (the folder containing `manifest.json`).
6. Pin **StreamGuard** from the puzzle-piece menu.
7. Open a live Twitch channel.

There is no need to keep the ZIP; the unzipped folder is the installed copy.

## Brave

1. Follow the Chrome steps above, using `brave://extensions`.
2. After installing, click the **Brave lion** icon while on `twitch.tv` and set
   **Shields down** for the site.
3. Reload the Twitch tab.

Brave Shields can interfere with Twitch's player worker, GraphQL token requests
or CDN playlists. If the extension loads but playback or ad blocking is
unreliable, Shields is the first thing to check.

## Edge

Follow the Chrome steps using `edge://extensions`. Edge also accepts the same
ZIP in the Edge Add-ons dashboard.

## Firefox 142+

The XPI attached to the GitHub Release is **unsigned**, so release Firefox will
not install it permanently. Use it as a temporary add-on:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `streamguard-firefox-*.xpi` (or `dist/firefox/manifest.json` when
   running from source).
4. Open a live Twitch channel.

The temporary add-on is removed when Firefox restarts. For permanent
installation, use an AMO-signed build from addons.mozilla.org, or submit the XPI
to AMO for signing. See the repository's `docs/PUBLISHING.md`.

## Verify that it is working

1. Click the StreamGuard toolbar icon. The popup should show **Shield active**
   and the channel name.
2. Open **Advanced** in the popup and enable **Debug logging** if you need
   diagnostics.
3. Open DevTools (`F12`) → Console and look for `[StreamGuard]` messages.
4. During an ad break, the player should show a small **Blocking ads** badge,
   and the popup's **Backups** stat may increase when a clean feed is used.

The toolbar badge shows `AD` while a break is being handled, and the number of
handled breaks otherwise.

## Updating

### Chrome, Brave, Edge

1. Download and unzip the new release ZIP.
2. Replace the old unzipped folder with the new one (or unzip beside it and
   point Load unpacked at the new folder).
3. Open `chrome://extensions` / `brave://extensions` / `edge://extensions` and
   click the **reload** icon on StreamGuard.
4. Hard-reload the Twitch tab (`Ctrl+Shift+R`).

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Remove the old temporary StreamGuard add-on.
3. Load the new XPI with **Load Temporary Add-on**.
4. Reload the Twitch tab.

Firefox may require removing and re-adding the add-on when the manifest or
add-on ID changes. The current ID is `streamguard@local`.

## Troubleshooting

### The video is black, stalls, or shows Twitch error #4000

This is usually a codec mismatch on 2K/4K enhanced (HEVC/AV1) broadcasts.
StreamGuard 0.2.1+ normalizes those streams to AVC when an AVC ladder exists
and leaves enhanced-only streams untouched. Make sure you are on the latest
release, then reload the extension and the Twitch tab.

As a temporary check, set Twitch quality to **1080p** or lower. If that fixes
it, the codec path is the cause.

### Brave plays ads or the player misbehaves

Set **Shields down** for `twitch.tv` and reload. Other Twitch-specific ad
blockers or userscripts should be disabled; combining blockers causes worker
and player conflicts.

### The popup says “Not a Twitch tab”

Open the popup while the active tab is a live Twitch channel page
(`https://www.twitch.tv/<channel>`), not a directory, VOD or clip page. Reload
the extension if the tab is correct.

### Ads still appear

- Confirm **Clean backup stream** is enabled.
- Enable **Debug logging**, open DevTools and look for `[StreamGuard]` lines.
- Some breaks have no clean backup on any player type; those fall back to
  stripping and may leak client-side ads.
- VODs and clips are intentionally unsupported.

### The Firefox XPI will not install permanently

Release Firefox requires signed add-ons. Use **Load Temporary Add-on** for
testing, or install an AMO-signed build. This is a Firefox platform rule, not a
StreamGuard setting.

## Uninstall

- **Chrome / Brave / Edge:** `chrome://extensions` → StreamGuard → **Remove**.
- **Firefox:** `about:debugging#/runtime/this-firefox` → StreamGuard →
  **Remove**, or remove the AMO-signed add-on from `about:addons`.

## Privacy and terms

StreamGuard stores settings and session stats locally with the browser's
extension storage. It sends no telemetry. Network requests go only to Twitch
(GraphQL playback tokens and Twitch CDN playlists), as the player already does.
Ad blocking can conflict with Twitch's Terms of Service; use it at your own
discretion. The project is not affiliated with Twitch Interactive.

## Build from source

```bash
git clone https://github.com/Spaced1127/StreamGuard.git
cd StreamGuard
npm install
npm run build
```

Load `dist/chrome` as an unpacked extension, or `dist/firefox/manifest.json` as
a Firefox temporary add-on. Release archives are produced with
`npm run package`.
