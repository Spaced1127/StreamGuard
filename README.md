# StreamGuard

[![CI](https://github.com/Spaced1127/StreamGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/Spaced1127/StreamGuard/actions/workflows/ci.yml)

A local-first ad shield for Twitch live streams. It runs entirely in your
browser: no proxy server, no account, no telemetry. It reads Twitch's HLS
playlists inside the player, detects ad breaks, and swaps to a clean alternate
player-type feed when one is available. When it is not, it blanks stitched ad
segments locally so their audio/video never reaches the decoder.

> **Status: v0.3.0 — playlist shield + clean backup-stream swap.**
> Live-tested against real Twitch stitched-ad breaks in a game category. Twitch
> changes its ad delivery regularly; see [Limitations](#limitations) and
> [Roadmap](#roadmap).

## What works today

- Hooks Twitch's IVS player **worker** and the page-level `fetch` before the
  player starts.
- Detects real stitched ad markers: `twitch-stitched-*`, `EXT-X-CUE-OUT`,
  `twitch-maf-ad`, `X-TV-TWITCH-AD-*`.
- **Requests a clean backup feed** for an ad break:
  - captures Twitch's GQL client context (`Client-Integrity`, `Client-Version`,
    `Client-Session-Id`, `Authorization`, `Client-ID`) from the page's own
    requests;
  - reuses the page's exact `PlaybackAccessToken` persisted-query body;
  - asks for tokens for alternate player types (`site`, `autoplay`, `popout`,
    `mobile_web`, `embed`);
  - fetches each candidate master/media playlist, rejects ad-laden ones, and
    serves a clean one in place of the ad playlist;
  - only selects AVC backup variants, so a codec switch cannot break playback;
  - falls back to the Android `autoplay` 360p feed when every source feed is
    ad-laden, and never pins that low-quality fallback across breaks.
- **Handles 2K/4K enhanced streams.** If a master offers HEVC/AV1 and AVC
  variants, the enhanced variants are removed so playback stays AVC and cannot
  hit Twitch error #4000. Enhanced-only streams are left untouched (ads may
  play) rather than risk a black screen.
- Blanks stitched ad media locally when no clean backup exists.
- Ignores Twitch's persistent `twitch-trigger` stream marker, which appears on
  every playlist (including during normal playback) and is **not** an ad
  signal.
- Removes low-latency prefetch/preload hints during breaks so the player cannot
  race ahead and fetch ad parts.
- Rewrites ad click-through URLs in playlists to `https://twitch.tv`.
- Replays a recent clean playlist snapshot (or a few recovery segments) when a
  break consists entirely of ads.
- Hides and mutes Amazon-hosted side/chat `<video>` ads (a July 2026 Twitch
  change that is not part of the HLS playlist).
- Popup with live status, session stats, master toggle and per-feature settings.
- Per-tab toolbar badge (`AD` while a break is handled, break count otherwise).
- Chrome/Edge and Firefox MV3 manifests from one TypeScript codebase.

## Not yet

- Ad breaks where **every** player type is ad-laden (no clean backup exists).
  Those still fall back to stripping, and CSAI ads can still leak.
- A player reload/quality-restore step after the low-quality `autoplay` backup.
  Playback returns to the main feed when the break ends, but quality may stay
  lower for the remainder of the break.
- VODs and clips are intentionally excluded — their playlists are not live and
  blanking segments would break playback.
- Mobile apps and the desktop Twitch client. This is a browser extension.
- Firefox live validation. The Firefox 128+ manifest and code paths are built,
  but live testing so far has been on Chrome for Testing.

## Install (development build)

Requirements: Node 20+.

```bash
git clone https://github.com/Spaced1127/StreamGuard.git
cd StreamGuard
npm install
npm run build
```

**Chrome / Edge**

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. **Load unpacked** → select `dist/chrome`.
4. Open a live Twitch channel.

**Firefox** (128+)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on** → select `dist/firefox/manifest.json`.
3. Open a live Twitch channel.

After changing source, run `npm run build` and reload the extension and tab.

```bash
npm run check      # TypeScript + Vitest
npm run test:watch # playlist, backup and worker-runtime tests
```

## How it works

### 1. Get in before the player

A `world: "MAIN"` content script runs at `document_start`. It patches
`window.fetch` and `window.Worker` before Twitch's player code executes.

Twitch's live player runs inside a blob worker. The Worker constructor is
wrapped so the worker script is fetched synchronously, prepended with a small
runtime, and launched from a new blob. That runtime owns `fetch` inside the
worker, which is where playlist and segment requests actually happen.

A second, isolated content script (`bridge.js`) relays settings in and stats
out via `window.postMessage`; the MAIN world cannot call `chrome.*`.

### 2. Read the playlist

Every `.m3u8` response is parsed locally:

- **Master playlist** — variants (resolution/frame rate/codecs) are parsed and
  the usher URL is remembered.
- **Media playlist** — ad markers are detected, segments are classified, and
  ad segment URLs are remembered in an in-memory cache.

Twitch tags real live segments with `,live` in the `#EXTINF` title. Stitched ad
segments do not have that tag. Segments inside `EXT-X-CUE-OUT` are also ads,
even if they carry `,live`.

### 3. Swap to a clean feed

When a break is detected, the worker asks the page for a
`PlaybackAccessToken` for alternate player types. The page posts Twitch's own
persisted-query template and captured client headers, so the request matches
what the player would have sent. The worker then:

1. Builds a usher URL from the player's original master URL, replacing
   `sig`/`token` and dropping `parent_domains`.
2. Fetches the candidate master playlist and the variant closest to the current
   resolution.
3. Rejects candidate media playlists that still contain ad markers.
4. Serves the first clean media playlist to the player.

The search is budgeted to 5 seconds and caches tokens/masters, so the first
break is the slow one and later breaks are usually a single playlist fetch. A
clean source-quality type is remembered for future breaks; the 360p
`autoplay` fallback is only used for the current break.

### 4. Blank, don't delete

If no clean feed is found, the playlist structure stays intact and the fetch
hook returns a **1,137-byte fragmented MP4 init segment** for each ad URL. It
has no media samples: the player advances without decoding ad audio or video.
Deleting ad segments would shift the media sequence and cause a black frame or
stall.

### 5. Survive an all-ad playlist

When every segment in a poll is an ad, the engine either:

1. replays a clean snapshot less than 1.5 s old, or
2. appends the last few live segments and rewrites `#EXT-X-MEDIA-SEQUENCE` so
   the player has something to chew on.

### 6. Report state

Worker messages feed a per-tab runtime with two clean polls of hysteresis.
Stats go to the service worker, which drives the badge; the popup polls the
service worker while it is open. The player badge is a shadow-DOM pill appended
to `.video-player`, so Twitch's styles cannot break it.

## Architecture

```
src/
├─ core/                 Pure, testable ad engine (also bundled into the worker)
│  ├─ playlist.ts        Marker detection, master parsing, segment classification
│  ├─ backup.ts          PlaybackAccessToken + clean-usher URL helpers
│  ├─ engine.ts          Per-context stream state + ad URL cache
│  ├─ http.ts            Playlist response rewriting, blank-media responses
│  └─ blank-media.ts     Proven 1.1 KB blank fMP4
├─ page/                 MAIN-world code injected into twitch.tv
│  ├─ main.ts            Boot + frame/page guards
│  ├─ runtime.ts         Canonical tab state, stats, client-header capture,
│  │                     PlaybackAccessToken requests
│  ├─ fetch-hook.ts      Page-level playlist interception + GQL capture
│  ├─ worker-hook.ts     Patches Twitch's IVS blob worker; token request bridge
│  ├─ overlay.ts         "Blocking ads" pill
│  └─ ad-videos.ts       Side/chat Amazon ad video hider
├─ worker/runtime.ts     Runtime inside the player worker: playlist engine,
│                        token requests, clean-backup search and swap
├─ content/bridge.ts     Isolated world: settings ↔ page ↔ background
├─ background/index.ts   MV3 service worker / Firefox event page, badge + stats
├─ popup/                Popup UI
└─ shared/               Types, message protocol, extension API shim
```

The worker runtime is bundled to a string at build time and embedded in
`page.js`; it has no imports or extension APIs at runtime.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Ad shield | on | Master switch; hooks become no-ops when off. |
| Clean backup stream | on | Request and switch to an alternate ad-free feed during breaks. |
| Hide side & chat ads | on | Hides/mutes `<video>` elements on Amazon's ad CDN. |
| Show blocking badge | on | Player pill during a detected break. |
| Rewrite ad trackers | on | Replaces `X-TV-TWITCH-AD-*-URL` values with twitch.tv. |
| Debug logging | off | `[StreamGuard]` console output. |

Settings are stored in `chrome.storage.local` / `browser.storage.local` and
propagated to open tabs immediately.

## Limitations

- **Quality can drop during a break.** When every source-quality backup is
  ad-laden, the current break uses the 360p `autoplay` feed. The main feed
  returns when the break ends.
- **Enhanced streams may be limited to AVC.** 2K/4K HEVC/AV1 variants are
  removed when an AVC ladder exists, avoiding Twitch error #4000. Enhanced-only
  streams are left untouched, so ads can still play there.
- **Some breaks still leak.** If Twitch marks a break but no player type
  returns a clean playlist, stripping is the only fallback. Pure CSAI breaks
  that never touch the playlist remain hard to detect without player internals.
- **Anti-adblock.** Twitch periodically changes playlist markers, player
  internals and GQL integrity requirements. This project is a moving target;
  markers and player types are centralized in `src/core/`.
- **Privacy.** The extension talks only to Twitch (GQL token requests and
  usher/CDN playlist fetches, exactly as the player already does) and stores
  settings locally. There is no external server, analytics or telemetry.
- **Terms of service.** Ad blocking can conflict with Twitch's Terms of
  Service. This project is intended for personal, educational use. You are
  responsible for how you use it. Not affiliated with Twitch.

## Roadmap

**Milestone 2 — clean backup-stream swap. DONE.** Token capture, alternate
player types, variant matching, pinned clean source type and the 360p fallback
are implemented and live-tested.

**Milestone 3 — hardening.**
- Player reload/quality restore after the low-quality backup (or a smarter
  quality ladder re-selection).
- Demand-driven backup attempts for CSAI ads, using real player ad requests as
  the trigger.
- More ad overlay/ad-slot hiding, Firefox live validation, and an automated
  end-to-end harness against recorded playlist fixtures.
- Options page, localization, and better first-break latency.

## Credits

The blank fMP4 constant, marker families and the alternate-player-type/clean
backup strategy are informed by
[TwitchAdSolutions](https://github.com/ryanbr/TwitchAdSolutions) (MIT). See
[NOTICE](NOTICE). StreamGuard is an independent implementation and is not
affiliated with Twitch Interactive.

## License

[MIT](LICENSE)
