# Changelog

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
