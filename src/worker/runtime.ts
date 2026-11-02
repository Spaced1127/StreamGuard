import {
  buildBackupMasterUrl,
  PLAYER_TYPES,
  type PlaybackToken,
  type PlayerType,
} from '../core/backup';
import { PlaylistEngine, urlPathKey } from '../core/engine';
import {
  createBlankMediaResponse,
  createResponseWithText,
  isAdBeaconUrl,
  isPlaylistUrl,
  requestUrl,
} from '../core/http';
import {
  detectAdMarkers,
  parseMasterPlaylist,
  pickVariant,
  preferAvcMasterPlaylist,
  type Variant,
} from '../core/playlist';
import { isTokenResponseMessage, isWorkerConfigMessage } from '../shared/messages';
import type { PlaylistEventPayload, WorkerConfig } from '../shared/types';

declare const __STREAMGUARD_CONFIG__: WorkerConfig;

interface ShieldWorkerGlobal {
  fetch: typeof fetch;
  postMessage: (message: unknown) => void;
  addEventListener: (type: 'message', listener: (event: MessageEvent) => void) => void;
  __streamguardWorkerRuntimeInstalled?: boolean;
}

interface ChannelBackup {
  usherUrl: string;
  channel: string;
  variants: Variant[];
  variantByKey: Map<string, Variant>;
  /** Clean feed used for the current break (may be autoplay/360p). */
  activeType: PlayerType | null;
  /** Source-quality feed that was clean in a previous break; tried first next time. */
  pinnedType: PlayerType | null;
  tokens: Map<string, { token: PlaybackToken; at: number }>;
  masters: Map<string, { text: string; at: number }>;
  failedTypes: Map<string, number>;
  lastAllFailedAt: number;
  /** Master was rewritten to AVC-only because enhanced variants were present. */
  forcedAvc: boolean;
  /** Stream is enhanced-only (no AVC variant); do not touch its media. */
  disableAdHandling: boolean;
}

interface BackupResult {
  text: string;
  playerType: PlayerType;
}

const scope = globalThis as unknown as ShieldWorkerGlobal;

function channelFromHlsUrl(rawUrl: string): string | null {
  const match = /\/channel\/hls\/([^/?#]+)\.m3u8/i.exec(rawUrl);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function resolveUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

function summarizePlaylist(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/);
  const extinf = lines.filter((line) => line.startsWith('#EXTINF'));
  return {
    segments: extinf.length,
    liveSegments: extinf.filter((line) => /,\s*live\b/i.test(line)).length,
    trigger: lines
      .filter((line) => line.includes('twitch-trigger'))
      .map((line) => line.slice(0, 500)),
    adAttrs: lines
      .filter((line) => line.includes('X-TV-TWITCH-AD'))
      .map((line) => line.slice(0, 300)),
    cue: lines
      .filter((line) => line.includes('EXT-X-CUE-'))
      .map((line) => line.slice(0, 160)),
    discontinuities: lines.filter((line) => line.startsWith('#EXT-X-DISCONTINUITY')).length,
    hasEndList: lines.some((line) => line.startsWith('#EXT-X-ENDLIST')),
  };
}

/**
 * Runs inside Twitch's IVS player worker, before Twitch's own script is eval'd.
 * It owns the realm's fetch hook, so every playlist and segment request the
 * player makes can be inspected locally.
 */
function boot(): void {
  if (scope.__streamguardWorkerRuntimeInstalled) return;
  scope.__streamguardWorkerRuntimeInstalled = true;

  let config: WorkerConfig = { ...__STREAMGUARD_CONFIG__ };
  const engine = new PlaylistEngine();
  const nativeFetch = scope.fetch.bind(scope);
  const nativePostMessage = scope.postMessage.bind(scope);
  let channel: string | null = null;
  let backupState: ChannelBackup | null = null;
  let backupSearch: Promise<BackupResult | null> | null = null;
  let loggedBreakSummary = false;
  let loggedCleanSummary = false;

  const pendingTokens = new Map<
    string,
    { resolve: (token: PlaybackToken | null) => void; timer: ReturnType<typeof setTimeout> }
  >();

  const log = (...args: unknown[]): void => {
    if (!config.debug) return;
    try {
      console.log('[StreamGuard:worker]', ...args);
    } catch {
      // Ignore.
    }

    try {
      const message = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' ');
      nativePostMessage({ __streamguardWorker: 1, kind: 'log', payload: { message } });
    } catch {
      // Ignore.
    }
  };

  const emit = (kind: 'playlist' | 'csai', payload: unknown): void => {
    try {
      nativePostMessage({ __streamguardWorker: 1, kind, payload });
    } catch {
      // Ignore.
    }
  };

  function requestToken(channelName: string, playerType: PlayerType): Promise<PlaybackToken | null> {
    return new Promise((resolve) => {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const timer = setTimeout(() => {
        pendingTokens.delete(id);
        resolve(null);
      }, 3_000);

      pendingTokens.set(id, { resolve, timer });

      try {
        nativePostMessage({
          __streamguardWorker: 1,
          kind: 'token-request',
          payload: { id, channel: channelName, playerType },
        });
      } catch {
        clearTimeout(timer);
        pendingTokens.delete(id);
        resolve(null);
      }
    });
  }

  async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await nativeFetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        log('backup fetch returned', response.status, url.slice(0, 100));
        return null;
      }
      return await response.text();
    } catch (error) {
      log('backup fetch failed', error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(
    state: ChannelBackup,
    playerType: PlayerType,
  ): Promise<PlaybackToken | null> {
    const cached = state.tokens.get(playerType);
    if (cached && Date.now() - cached.at < 60_000) return cached.token;

    const token = await requestToken(state.channel, playerType);
    if (!token) {
      log('no playback token for', playerType);
      return null;
    }

    state.tokens.set(playerType, { token, at: Date.now() });
    return token;
  }

  async function getMaster(
    state: ChannelBackup,
    playerType: PlayerType,
    token: PlaybackToken,
    timeoutMs: number,
  ): Promise<string | null> {
    const cached = state.masters.get(playerType);
    if (cached && Date.now() - cached.at < 30_000) return cached.text;

    const masterUrl = buildBackupMasterUrl(state.usherUrl, token);
    const text = await fetchText(masterUrl, timeoutMs);
    if (text) {
      state.masters.set(playerType, { text, at: Date.now() });
      return text;
    }

    // A stale master is still better than no backup: its variant URLs remain
    // valid for the life of the stream session.
    return cached?.text ?? null;
  }

  async function tryBackup(
    resolution: string | null,
    frameRate: number | null,
  ): Promise<BackupResult | null> {
    const state = backupState;
    if (!config.backupStream || !state || !state.channel || state.disableAdHandling) return null;

    const now = Date.now();
    if (now - state.lastAllFailedAt < 8_000) return null;

    // Keep the first attempt inside the player's playlist timeout. Once a type
    // is pinned, this normally costs a single media-playlist fetch per poll.
    const deadline = now + 5_000;
    log(
      'backup search',
      `resolution=${resolution ?? 'unknown'}`,
      `active=${state.activeType ?? 'none'}`,
      `pinned=${state.pinnedType ?? 'none'}`,
    );

    const order: PlayerType[] = [];
    if (state.activeType) order.push(state.activeType);
    if (state.pinnedType) order.push(state.pinnedType);
    for (const type of PLAYER_TYPES) {
      if (!order.includes(type)) order.push(type);
    }

    let attempted = 0;

    for (const playerType of order) {
      if (Date.now() >= deadline) break;

      const failedAt = state.failedTypes.get(playerType);
      if (failedAt && Date.now() - failedAt < 10_000) continue;

      attempted += 1;

      const remaining = Math.max(500, deadline - Date.now());
      const token = await getToken(state, playerType);
      if (!token) {
        state.failedTypes.set(playerType, Date.now());
        continue;
      }

      const masterText = await getMaster(
        state,
        playerType,
        token,
        Math.min(2_500, Math.max(500, deadline - Date.now())),
      );
      if (!masterText) {
        state.failedTypes.set(playerType, Date.now());
        continue;
      }

      const master = parseMasterPlaylist(masterText);
      if (!master.isMaster || master.variants.length === 0) {
        log('backup master had no variants', playerType);
        state.failedTypes.set(playerType, Date.now());
        continue;
      }
      log('backup master ok', playerType, `variants=${master.variants.length}`);

      const variant = pickVariant(master, resolution, frameRate, 'avc');
      if (!variant) {
        log('backup has no AVC variant', playerType);
        state.failedTypes.set(playerType, Date.now());
        continue;
      }

      const variantUrl = resolveUrl(variant.url, state.usherUrl);
      const mediaText = await fetchText(
        variantUrl,
        Math.min(3_000, Math.max(500, deadline - Date.now())),
      );
      if (!mediaText) {
        log('backup media unavailable', playerType, variantUrl.slice(0, 120));
        state.failedTypes.set(playerType, Date.now());
        continue;
      }

      const markers = detectAdMarkers(mediaText);
      if (markers.found) {
        log('backup also has ads', playerType, markers.markers, summarizePlaylist(mediaText));
        state.failedTypes.set(playerType, Date.now());
        continue;
      }

      state.activeType = playerType;
      if (playerType !== 'autoplay') {
        // Only source-quality backups are remembered across breaks. Pinning
        // autoplay would force 360p on every subsequent break even when a
        // source feed is clean again.
        state.pinnedType = playerType;
      }
      state.failedTypes.delete(playerType);
      state.lastAllFailedAt = 0;
      log('clean backup found', playerType, variant.resolution ?? 'unknown', variant.codecs ?? '?', `remaining=${remaining}ms`);
      return { text: mediaText, playerType };
    }

    if (attempted > 0) {
      state.lastAllFailedAt = Date.now();
      log('no clean backup found', `tried=${attempted}`);
    }

    return null;
  }

  scope.fetch = async function shieldWorkerFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url = '';
    try {
      url = requestUrl(input);
    } catch {
      return nativeFetch(input, init);
    }

    if (!config.enabled || !url) return nativeFetch(input, init);

    try {
      if (!backupState?.disableAdHandling && engine.isAdMedia(url)) {
        log('blanking ad media', url);
        return createBlankMediaResponse();
      }

      if (!isPlaylistUrl(url)) {
        if (isAdBeaconUrl(url)) emit('csai', { url });
        return nativeFetch(input, init);
      }

      const response = await nativeFetch(input, init);
      if (!response.ok || response.type === 'opaque') return response;

      let text: string;
      try {
        text = await response.text();
      } catch {
        return response;
      }

      if (!text.includes('#EXTM3U')) return createResponseWithText(response, text);

      let output = text;
      let backupType: string | null = null;

      // Enhanced-only streams (2K/4K HEVC/AV1 with no AVC ladder) cannot be
      // safely blanked or backed up with AVC media: Twitch throws #4000. Leave
      // their media playlists untouched and let the player behave normally.
      if (backupState?.disableAdHandling && !text.includes('#EXT-X-STREAM-INF')) {
        log('enhanced-only stream: leaving media playlist untouched');
        return createResponseWithText(response, text);
      }

      try {
        const result = engine.process(url, text, {
          rewriteTrackingUrls: config.rewriteTrackingUrls,
        });

        if (result.kind === 'master') {
          const masterChannel = channelFromHlsUrl(url) ?? channel;
          if (masterChannel) {
            channel = masterChannel;

            const adjusted = preferAvcMasterPlaylist(text);
            output = adjusted.text;

            const parsed = parseMasterPlaylist(adjusted.text);
            const resolvedVariants = parsed.variants.map((variant) => ({
              ...variant,
              url: resolveUrl(variant.url, url),
            }));
            const variantByKey = new Map(
              resolvedVariants.map((variant) => [urlPathKey(variant.url), variant]),
            );
            const forcedAvc = adjusted.changed;
            const disableAdHandling = adjusted.hasEnhancedVariants && !adjusted.hasAvcVariants;

            if (!backupState || backupState.channel !== masterChannel) {
              backupState = {
                usherUrl: url,
                channel: masterChannel,
                variants: resolvedVariants,
                variantByKey,
                activeType: null,
                pinnedType: null,
                tokens: new Map(),
                masters: new Map(),
                failedTypes: new Map(),
                lastAllFailedAt: 0,
                forcedAvc,
                disableAdHandling,
              };
            } else {
              backupState.usherUrl = url;
              backupState.variants = resolvedVariants;
              backupState.variantByKey = variantByKey;
              backupState.forcedAvc = forcedAvc;
              backupState.disableAdHandling = disableAdHandling;
            }

            if (forcedAvc) {
              log('removed enhanced (HEVC/AV1) variants to keep playback on AVC');
            }
            if (disableAdHandling) {
              log('enhanced-only stream: ad handling disabled to avoid player error #4000');
            }

            log(
              'master variants',
              resolvedVariants
                .map((variant) => `${variant.resolution ?? '?'}/${variant.codecs ?? '?'}`)
                .slice(0, 12)
                .join(' | '),
            );
          }
          log('master playlist', url.slice(0, 120), channel);
        } else if (result.kind === 'media') {
          output = result.text;

          if (!result.hasAds) {
            loggedBreakSummary = false;
            if (backupState) {
              backupState.activeType = null;
              backupState.failedTypes.clear();
              backupState.lastAllFailedAt = 0;
            }
            if (!loggedCleanSummary) {
              loggedCleanSummary = true;
              log('clean playlist summary', summarizePlaylist(text));
            }
          } else if (!loggedBreakSummary) {
            loggedBreakSummary = true;
            loggedCleanSummary = false;
            log('main playlist summary', summarizePlaylist(text));
          }

          const currentVariant = backupState?.variantByKey.get(urlPathKey(url));
          const resolution = currentVariant?.resolution ?? null;
          const frameRate = currentVariant?.frameRate ?? null;

          if (result.hasAds && config.backupStream) {
            if (!backupSearch) {
              backupSearch = tryBackup(resolution, frameRate).finally(() => {
                backupSearch = null;
              });
            }
            const backup = await backupSearch;
            if (backup) {
              output = backup.text;
              backupType = backup.playerType;
            }
          }

          const payload: PlaylistEventPayload = {
            source: 'worker',
            channel,
            url,
            hasAds: result.hasAds,
            markers: result.markers,
            newAdSegmentUrls: result.newAdSegmentUrls,
            allSegmentsAd: result.allSegmentsAd,
            usedRecovery: result.usedRecovery,
            usedSnapshot: result.usedSnapshot,
            backupType,
            ts: Date.now(),
          };
          emit('playlist', payload);
        }
      } catch (error) {
        log('playlist processing failed', error);
      }

      return createResponseWithText(response, output);
    } catch (error) {
      log('worker fetch failed', error);
      return nativeFetch(input, init);
    }
  };

  scope.addEventListener('message', (event) => {
    const data = event.data;

    if (isWorkerConfigMessage(data)) {
      config = { ...config, ...data.config };
      log('config updated', config);
      return;
    }

    if (isTokenResponseMessage(data)) {
      const pending = pendingTokens.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingTokens.delete(data.id);
      pending.resolve(data.token);
    }
  });

  log('worker runtime installed');
}

boot();
