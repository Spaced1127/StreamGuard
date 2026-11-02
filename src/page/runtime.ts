import {
  buildTokenRequestBodyFromTemplate,
  DEFAULT_TOKEN_QUERY_HASH,
  parseTokenResponse,
  PLAYER_TYPES,
  TWITCH_CLIENT_ID,
  type PlaybackToken,
  type PlayerType,
  type TokenRequestBody,
} from '../core/backup';
import { PlaylistEngine, type EngineResult } from '../core/engine';
import { requestUrl } from '../core/http';
import { preferAvcMasterPlaylist } from '../core/playlist';
import { postToWindow } from '../shared/messages';
import {
  DEFAULT_SETTINGS,
  emptyTabStats,
  toWorkerConfig,
  type PlaylistEventPayload,
  type ShieldSettings,
  type TabStats,
  type WorkerConfig,
  type WorkerMessage,
} from '../shared/types';

export interface RuntimeSnapshot {
  settings: ShieldSettings;
  stats: TabStats;
}

interface ClientContext {
  clientId: string;
  authorization: string | null;
  integrity: string | null;
  clientVersion: string | null;
  clientSession: string | null;
  tokenQueryHash: string | null;
  tokenRequestTemplate: Record<string, unknown> | null;
  deviceId: string;
}

function randomDeviceId(): string {
  const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let index = 0; index < 32; index += 1) {
    id += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return id;
}

type RuntimeListener = (snapshot: RuntimeSnapshot) => void;
type SettingsListener = (config: WorkerConfig) => void;

const RESERVED_PATHS = new Set([
  'about',
  'analytics',
  'api',
  'blog',
  'broadcast',
  'channel',
  'clips',
  'collections',
  'community',
  'creatorcamp',
  'dashboard',
  'developers',
  'directory',
  'downloads',
  'drops',
  'embed',
  'extensions',
  'friends',
  'health',
  'help',
  'inventory',
  'jobs',
  'legal',
  'login',
  'messages',
  'mobile',
  'moderator',
  'oauth',
  'p',
  'popout',
  'privacy',
  'revenue',
  'schedule',
  'search',
  'security',
  'settings',
  'signup',
  'store',
  'subscriptions',
  'support',
  'team',
  'teams',
  'terms',
  'turbo',
  'user',
  'videos',
  'wallet',
]);

/** Best-effort channel name from the current URL, used for display only. */
export function detectChannel(): string | null {
  try {
    const host = location.hostname;
    if (host === 'player.twitch.tv' || host === 'embed.twitch.tv') {
      const channel = new URLSearchParams(location.search).get('channel');
      return channel ? channel.trim() : null;
    }

    const parts = location.pathname.split('/').filter(Boolean);
    if (parts[0] === 'popout' && parts[1]) return parts[1];
    if (parts[0] === 'embed' && parts[1]) return parts[1];
    if (parts.length === 1 && parts[0] && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
      return parts[0];
    }
  } catch {
    // Ignore malformed locations.
  }
  return null;
}

export function channelFromHlsUrl(rawUrl: string): string | null {
  const match = /\/channel\/hls\/([^/?#]+)\.m3u8/i.exec(rawUrl);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Canonical per-tab state. Worker messages are authoritative when present; the
 * main-thread hook is a fallback for players that fetch playlists on the page
 * (and for Firefox/player variants where the worker hook does not run).
 */
export class PageRuntime {
  private settings: ShieldSettings = { ...DEFAULT_SETTINGS };
  private stats: TabStats = { ...emptyTabStats(), enabled: DEFAULT_SETTINGS.enabled };
  private readonly engine = new PlaylistEngine();
  private readonly listeners = new Set<RuntimeListener>();
  private readonly settingsListeners = new Set<SettingsListener>();
  private readonly seenAdUrls = new Set<string>();
  private readonly csaiSeen = new Set<string>();
  private readonly tokenCache = new Map<string, { token: PlaybackToken; at: number }>();
  private readonly tokenRequests = new Map<string, Promise<PlaybackToken | null>>();
  private readonly client: ClientContext = {
    clientId: TWITCH_CLIENT_ID,
    authorization: null,
    integrity: null,
    clientVersion: null,
    clientSession: null,
    tokenQueryHash: null,
    tokenRequestTemplate: null,
    deviceId: randomDeviceId(),
  };
  private lastWorkerAt = 0;
  private cleanStreak = 0;
  private breakUsedBackup = false;
  private disableAdHandling = false;
  private loggedClientContext = false;
  private postTimer: number | null = null;
  private channelTimer: number | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stats.channel = detectChannel();
    this.stats.enabled = this.settings.enabled;
    this.channelTimer = window.setInterval(() => this.refreshChannel(), 2000);
    this.emit();
    this.schedulePost(0);
  }

  stop(): void {
    if (this.channelTimer !== null) {
      clearInterval(this.channelTimer);
      this.channelTimer = null;
    }
    if (this.postTimer !== null) {
      clearTimeout(this.postTimer);
      this.postTimer = null;
    }
  }

  getSnapshot(): RuntimeSnapshot {
    return {
      settings: { ...this.settings },
      stats: { ...this.stats },
    };
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  onSettingsChange(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  getWorkerConfig(): WorkerConfig {
    return toWorkerConfig(this.settings);
  }

  updateSettings(partial: Partial<ShieldSettings>): void {
    const next: ShieldSettings = { ...this.settings, ...partial };
    const changed = JSON.stringify(next) !== JSON.stringify(this.settings);
    this.settings = next;
    this.stats.enabled = next.enabled;
    if (!next.enabled) {
      this.stats.blocking = false;
      this.breakUsedBackup = false;
    }
    this.emit();
    this.schedulePost(0);

    if (changed) {
      const config = toWorkerConfig(next);
      for (const listener of this.settingsListeners) {
        try {
          listener(config);
        } catch {
          // A broken listener must not break the page.
        }
      }
    }
  }

  processPlaylist(url: string, text: string): EngineResult | null {
    if (!this.settings.enabled) return null;

    // Enhanced-only streams cannot be safely rewritten with AVC media.
    if (this.disableAdHandling && !text.includes('#EXT-X-STREAM-INF')) return null;

    const result = this.engine.process(url, text, {
      rewriteTrackingUrls: this.settings.rewriteTrackingUrls,
    });

    if (result.kind === 'master') {
      const adjusted = preferAvcMasterPlaylist(result.text);
      this.disableAdHandling = adjusted.hasEnhancedVariants && !adjusted.hasAvcVariants;
      if (adjusted.changed) {
        result.text = adjusted.text;
        this.log('removed enhanced (HEVC/AV1) variants to keep playback on AVC');
      }
      if (this.disableAdHandling) {
        this.log('enhanced-only stream: ad handling disabled to avoid player error #4000');
      }
    }

    return result;
  }

  isAdMedia(url: string): boolean {
    return (
      this.settings.enabled && !this.disableAdHandling && this.engine.isAdMedia(url)
    );
  }

  /**
   * Called for every page fetch. Only GraphQL calls matter here: we reuse the
   * page's own Client-Integrity/Client-Version/session headers and its
   * PlaybackAccessToken persisted-query hash for alternate player-type tokens.
   */
  captureRequest(input: RequestInfo | URL, init?: RequestInit): void {
    try {
      const url = requestUrl(input);
      if (!/gql\.twitch\.tv/i.test(url)) return;

      const requestHeaders =
        init?.headers ??
        (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined);
      const headers = new Headers(requestHeaders);

      const clientId = headers.get('Client-ID');
      if (clientId) this.client.clientId = clientId;

      const authorization = headers.get('Authorization');
      if (authorization) this.client.authorization = authorization;

      const integrity = headers.get('Client-Integrity');
      if (integrity) this.client.integrity = integrity;

      const clientVersion = headers.get('Client-Version');
      if (clientVersion) this.client.clientVersion = clientVersion;

      const clientSession = headers.get('Client-Session-Id');
      if (clientSession) this.client.clientSession = clientSession;

      if (typeof init?.body === 'string') this.captureGqlBody(init.body);

      if (this.settings.debug && !this.loggedClientContext) {
        this.loggedClientContext = true;
        this.log(
          'captured GQL client context',
          `integrity=${Boolean(this.client.integrity)}`,
          `version=${Boolean(this.client.clientVersion)}`,
          `session=${Boolean(this.client.clientSession)}`,
          `auth=${Boolean(this.client.authorization)}`,
        );
      }
    } catch {
      // Capture is best-effort; never interfere with the request.
    }
  }

  private captureGqlBody(body: string): void {
    try {
      const parsed = JSON.parse(body) as {
        operationName?: unknown;
        extensions?: { persistedQuery?: { sha256Hash?: unknown } };
      };
      if (parsed.operationName !== 'PlaybackAccessToken') return;

      this.client.tokenRequestTemplate = parsed as Record<string, unknown>;

      const hash = parsed.extensions?.persistedQuery?.sha256Hash;
      if (typeof hash === 'string' && hash.length > 0 && hash !== this.client.tokenQueryHash) {
        this.client.tokenQueryHash = hash;
        this.log('captured PlaybackAccessToken query hash');
      }
    } catch {
      // Not JSON; ignore.
    }
  }

  /**
   * Request a PlaybackAccessToken for an alternate player type. Called from
   * the MAIN-world Worker wrapper when the player worker asks for one.
   */
  async getPlaybackToken(channel: string, playerType: string): Promise<PlaybackToken | null> {
    if (!this.settings.enabled || !this.settings.backupStream || !channel) return null;

    const type: PlayerType = (PLAYER_TYPES as readonly string[]).includes(playerType)
      ? (playerType as PlayerType)
      : 'site';
    const key = `${channel}:${type}`;

    const cached = this.tokenCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.token;

    const inflight = this.tokenRequests.get(key);
    if (inflight) return inflight;

    const request = this.requestPlaybackToken(channel, type).finally(() => {
      this.tokenRequests.delete(key);
    });
    this.tokenRequests.set(key, request);
    return request;
  }

  private async requestPlaybackToken(
    channel: string,
    playerType: PlayerType,
  ): Promise<PlaybackToken | null> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5_000);

    try {
      const body = this.buildTokenBody(channel, playerType);

      let response = await this.postGql(body, true, controller.signal);
      if (response.status === 403 && this.client.integrity) {
        this.log('token request returned 403 with integrity; retrying without it');
        response = await this.postGql(body, false, controller.signal);
      }

      if (!response.ok) {
        this.log('token request failed', playerType, response.status);
        return null;
      }

      const json: unknown = await response.json();
      const token = parseTokenResponse(json);
      if (!token) {
        this.log('token response missing streamPlaybackAccessToken', playerType);
        return null;
      }

      this.tokenCache.set(`${channel}:${playerType}`, { token, at: Date.now() });
      this.log('got playback token', playerType);
      return token;
    } catch (error) {
      this.log('token request error', playerType, error);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reuse Twitch's captured PlaybackAccessToken request shape, overriding only
   * the channel/player type. This keeps any extra variables (playerBackend,
   * future persisted-query additions) intact.
   */
  private buildTokenBody(channel: string, playerType: PlayerType): TokenRequestBody {
    return buildTokenRequestBodyFromTemplate(
      this.client.tokenRequestTemplate,
      channel,
      playerType,
      this.client.tokenQueryHash ?? DEFAULT_TOKEN_QUERY_HASH,
    );
  }

  private postGql(
    body: TokenRequestBody,
    includeIntegrity: boolean,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Client-ID': this.client.clientId || TWITCH_CLIENT_ID,
      'X-Device-Id': this.client.deviceId,
    };

    if (this.client.authorization) headers.Authorization = this.client.authorization;
    if (this.client.clientVersion) headers['Client-Version'] = this.client.clientVersion;
    if (this.client.clientSession) headers['Client-Session-Id'] = this.client.clientSession;
    if (includeIntegrity && this.client.integrity) headers['Client-Integrity'] = this.client.integrity;

    return fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // gql.twitch.tv's CORS response does not allow credentialed cross-origin
      // requests; Twitch's own player sends none. Authorization (when present)
      // is forwarded explicitly above.
      credentials: 'omit',
      signal,
    });
  }

  noteMasterPlaylist(url: string): void {
    const channel = channelFromHlsUrl(url);
    if (channel && channel !== this.stats.channel) {
      this.stats.channel = channel;
      this.stats.updatedAt = Date.now();
      this.emit();
      this.schedulePost(0);
    }
  }

  applyPageResult(result: EngineResult, url: string): void {
    if (result.kind !== 'media') return;
    this.applyPlaylistPayload({
      source: 'page',
      channel: this.stats.channel ?? detectChannel(),
      url,
      hasAds: result.hasAds,
      markers: result.markers,
      newAdSegmentUrls: result.newAdSegmentUrls,
      allSegmentsAd: result.allSegmentsAd,
      usedRecovery: result.usedRecovery,
      usedSnapshot: result.usedSnapshot,
      ts: Date.now(),
    });
  }

  handleWorkerMessage(message: WorkerMessage): void {
    if (message.kind === 'playlist') {
      const payload = message.payload as PlaylistEventPayload;
      if (payload && typeof payload.hasAds === 'boolean') {
        this.applyPlaylistPayload({ ...payload, source: 'worker' });
      }
    } else if (message.kind === 'csai') {
      const payload = message.payload as { url?: string };
      if (payload?.url) this.noteCsaiRequest(payload.url);
    } else if (message.kind === 'log' && this.settings.debug) {
      const payload = message.payload as { message?: string };
      if (payload?.message) console.log('[TwitchShield:worker]', payload.message);
    }
  }

  noteCsaiRequest(url: string): void {
    if (!this.settings.enabled) return;
    this.log('csai request', url.slice(0, 160));
    if (this.csaiSeen.has(url) || this.csaiSeen.size >= 500) return;
    this.csaiSeen.add(url);
    this.stats.csaiRequests += 1;
    this.stats.updatedAt = Date.now();
    this.emit();
    this.schedulePost();
  }

  noteSideAdsHidden(count = 1): void {
    if (!this.settings.enabled || count <= 0) return;
    this.stats.sideAdsHidden += count;
    this.stats.updatedAt = Date.now();
    this.emit();
    this.schedulePost();
  }

  resetStats(): void {
    this.stats = {
      ...emptyTabStats(),
      channel: this.stats.channel,
      enabled: this.settings.enabled,
      updatedAt: Date.now(),
    };
    this.seenAdUrls.clear();
    this.csaiSeen.clear();
    this.cleanStreak = 0;
    this.breakUsedBackup = false;
    this.engine.reset();
    this.emit();
    this.schedulePost(0);
  }

  log(...args: unknown[]): void {
    if (!this.settings.debug) return;
    try {
      console.log('[TwitchShield]', ...args);
    } catch {
      // Console can be unavailable in exotic contexts.
    }
  }

  private applyPlaylistPayload(payload: PlaylistEventPayload): void {
    const now = Date.now();
    const wasBlocking = this.stats.blocking;

    if (payload.source === 'worker') {
      this.lastWorkerAt = now;
    } else if (now - this.lastWorkerAt < 10_000) {
      // The player worker is actively reporting; ignore main-thread playlist
      // traffic (masters and duplicate media requests) to avoid state flicker.
      return;
    }

    if (this.settings.debug) {
      this.log(
        `playlist (${payload.source}) channel=${payload.channel ?? '?'} ads=${payload.hasAds}`,
        `markers=[${payload.markers.join(', ') || 'none'}]`,
        `newAdUrls=${payload.newAdSegmentUrls.length}`,
        `allAd=${payload.allSegmentsAd}`,
        `snapshot=${payload.usedSnapshot}`,
        `recovery=${payload.usedRecovery}`,
        `backup=${payload.backupType ?? 'none'}`,
      );
    }

    if (payload.hasAds) {
      this.cleanStreak = 0;
      if (!this.stats.blocking) {
        this.stats.breaksBlocked += 1;
        this.breakUsedBackup = false;
        this.log('ad break detected', payload.markers);
      }
      this.stats.blocking = true;

      if (payload.backupType && !this.breakUsedBackup) {
        this.breakUsedBackup = true;
        this.stats.backupsUsed += 1;
        this.log('clean backup feed active', payload.backupType);
      }

      for (const url of payload.newAdSegmentUrls) {
        if (this.seenAdUrls.size >= 2000) break;
        if (this.seenAdUrls.has(url)) continue;
        this.seenAdUrls.add(url);
        this.stats.segmentsBlanked += 1;
      }

      if (payload.channel) this.stats.channel = payload.channel;
    } else if (this.stats.blocking) {
      // Two consecutive clean polls (~4s at Twitch's typical cadence) avoid
      // flickering the badge when ad markers briefly disappear mid-break.
      this.cleanStreak += 1;
      if (this.cleanStreak >= 2) {
        this.stats.blocking = false;
        this.cleanStreak = 0;
        this.breakUsedBackup = false;
        if (wasBlocking) this.log('ad break ended');
      }
    }

    this.stats.updatedAt = now;
    this.stats.enabled = this.settings.enabled;
    if (payload.channel && !this.stats.channel) this.stats.channel = payload.channel;

    this.emit();
    this.schedulePost();
  }

  private refreshChannel(): void {
    const channel = detectChannel();
    if (channel && channel !== this.stats.channel) {
      this.stats.channel = channel;
      this.stats.updatedAt = Date.now();
      this.emit();
      this.schedulePost(0);
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Listeners are UI; never let one break ad handling.
      }
    }
  }

  private schedulePost(delay = 400): void {
    if (this.postTimer !== null) {
      if (delay !== 0) return;
      clearTimeout(this.postTimer);
      this.postTimer = null;
    }
    this.postTimer = window.setTimeout(() => {
      this.postTimer = null;
      postToWindow('stats', { ...this.stats });
    }, delay);
  }
}
