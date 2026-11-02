# Changelog

## 0.3.1 — 2026-11-01

### Fixed

- Firefox: the extension API shim now prefers the callback-compatible `chrome.*`
  namespace. Firefox exposes both `chrome` and `browser`, but `browser.*` is
  Promise-only, so callback-based settings and stats could hang.

### Added

- Diagnostic page attributes for automated browser tests:
  `data-streamguard-bridge`, `data-streamguard-worker` and
  `data-streamguard-background`.
- Firefox manifest now declares `data_collection_permissions: none`; the
  minimum Firefox version is 142 for that manifest key.

### Changed

- The overlay builds its shadow DOM with `DOMParser` instead of a dynamic
  `innerHTML` assignment, clearing Mozilla's `UNSAFE_VAR_ASSIGNMENT` lint
  warning.

### Validated

- Firefox 159: temporary add-on install, settings bridge, background
  messaging, IVS worker hook, and a live ad break while playback continued.

## 0.3.0 — 2026-11-01

### Changed

- Rebranded the project and extension from Twitch Shield to **StreamGuard**.
- Changed the Firefox add-on ID to `streamguard@local`; reload the temporary
  add-on after upgrading.
- Renamed internal messaging/config namespaces and console prefixes to
  StreamGuard.

### Added

- GitHub Actions CI: TypeScript check, Vitest suite, and Chrome/Firefox builds.

## 0.2.1 — 2026-11-01

### Fixed

- Twitch player error #4000 / black screen when blocking ads on 2K/4K enhanced
  (HEVC/AV1) broadcasts, especially in Brave. Master playlists are now
  normalized to AVC when an AVC ladder is available, backup selection is
  restricted to AVC variants, and enhanced-only streams are left untouched
  instead of being rewritten.
- Rebuilt playlist responses now drop stale `content-encoding`,
  `content-length`, `transfer-encoding`, `etag` and `last-modified` headers.
  Copying the original compression headers onto a decompressed body could make
  the player fail on some network stacks.

## 0.2.0 — 2026-11-01

### Added

- Clean backup-stream swap during ad breaks. The extension captures Twitch's
  GQL client headers and the page's exact `PlaybackAccessToken` persisted
  query, requests tokens for `site`, `autoplay`, `popout`, `mobile_web` and
  `embed`, and serves the first ad-free media playlist it finds.
- Token request bridge between the MAIN-world worker hook and the page runtime.
- Master-playlist variant parsing and resolution matching for backup feeds.
- Source-quality backup pinning across breaks; the Android `autoplay` 360p
  fallback is used only for the current break.
- "Backups" session stat and a "Clean backup stream" setting.
- Debug log forwarding from the player worker to the page console.

### Fixed

- `twitch-trigger` was treated as an ad marker. Live inspection showed it is a
  persistent `END-ON-NEXT` stream trigger with an `X-TV-TWITCH-TRIGGER-URL`,
  present on every playlist during normal playback. It is now ignored, which
  removes the permanent "Blocking ads" false positive and needless backup
  searches.
- GQL token requests now omit cross-origin credentials, matching Twitch's own
  requests and avoiding CORS failures on `gql.twitch.tv`.

### Validated

- Live EFT (`Escape From Tarkov`) channel: a real `twitch-stitched-ad` break
  was detected, a clean 720p/1080p `site` feed was served, and the 360p
  `autoplay` fallback took over when the source feed became ad-laden. Playback
  time advanced continuously through the break and returned to the main feed.

## 0.1.0 — 2026-11-01

- Initial playlist shield: MAIN-world fetch and IVS worker hooks, HLS ad marker
  detection, stitched-segment blanking, snapshot/recovery handling, side/chat
  Amazon video ad hiding, popup, badge, Chrome/Firefox MV3 builds, unit tests.
