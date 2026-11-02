import {
  createMediaState,
  isAdSegmentUrl,
  parseMasterPlaylist,
  processMediaPlaylist,
  type MediaPlaylistState,
  type ProcessedPlaylist,
} from './playlist';

export type PlaylistKind = 'master' | 'media' | 'unknown';

export interface EngineResult extends ProcessedPlaylist {
  kind: PlaylistKind;
  isMaster: boolean;
  newAdSegmentUrls: string[];
}

export interface EngineOptions {
  rewriteTrackingUrls: boolean;
  now?: number;
}

const AD_URL_TTL_MS = 120_000;
const AD_URL_CACHE_LIMIT = 1200;

function emptyResult(kind: PlaylistKind, text: string): EngineResult {
  return {
    kind,
    isMaster: kind === 'master',
    text,
    hasAds: false,
    adSegmentUrls: [],
    newAdSegmentUrls: [],
    markers: [],
    allSegmentsAd: false,
    usedRecovery: false,
    usedSnapshot: false,
    segmentCount: 0,
  };
}

export function urlPathKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.split('#')[0]?.split('?')[0] ?? rawUrl;
  }
}

/**
 * Per-context playlist state and ad-media cache. A page has one engine on the
 * main thread and one inside each patched player worker; they do not share
 * memory, which is fine because each realm sees the fetches it needs to patch.
 */
export class PlaylistEngine {
  private readonly streams = new Map<string, MediaPlaylistState>();
  private readonly adMedia = new Map<string, number>();
  private readonly adPaths = new Map<string, number>();
  private lastPrune = 0;

  process(url: string, text: string, options: EngineOptions): EngineResult {
    if (!text.includes('#EXTM3U')) return emptyResult('unknown', text);

    const master = parseMasterPlaylist(text);
    if (master.isMaster) return emptyResult('master', text);

    if (!text.includes('#EXTINF')) return emptyResult('unknown', text);

    const now = options.now ?? Date.now();
    const key = urlPathKey(url);
    let state = this.streams.get(key);
    if (!state) {
      state = createMediaState();
      this.streams.set(key, state);
    }

    const result = processMediaPlaylist(text, state, {
      playlistUrl: url,
      rewriteTrackingUrls: options.rewriteTrackingUrls,
      now,
    });

    const newAdSegmentUrls: string[] = [];
    for (const adUrl of result.adSegmentUrls) {
      const pathKey = urlPathKey(adUrl);
      const known =
        this.adMedia.has(adUrl) ||
        this.adPaths.has(pathKey) ||
        isAdSegmentUrl(adUrl);
      if (!known) newAdSegmentUrls.push(adUrl);
      this.adMedia.set(adUrl, now);
      this.adPaths.set(pathKey, now);
    }

    this.prune(now);

    return {
      ...result,
      kind: 'media',
      isMaster: false,
      newAdSegmentUrls,
    };
  }

  /** Called from the fetch hook before a network request is made. */
  isAdMedia(rawUrl: string): boolean {
    if (isAdSegmentUrl(rawUrl)) return true;

    const now = Date.now();
    const exact = this.adMedia.get(rawUrl);
    if (exact !== undefined && now - exact <= AD_URL_TTL_MS) return true;

    const pathTime = this.adPaths.get(urlPathKey(rawUrl));
    if (pathTime !== undefined && now - pathTime <= AD_URL_TTL_MS) return true;

    return false;
  }

  /** Number of distinct ad segment URLs cached (useful for diagnostics). */
  get cachedAdMediaCount(): number {
    return this.adMedia.size;
  }

  reset(): void {
    this.streams.clear();
    this.adMedia.clear();
    this.adPaths.clear();
    this.lastPrune = 0;
  }

  private prune(now: number): void {
    if (now - this.lastPrune < 60_000 && this.adMedia.size < AD_URL_CACHE_LIMIT) return;
    this.lastPrune = now;

    for (const [url, seenAt] of this.adMedia) {
      if (now - seenAt > AD_URL_TTL_MS) this.adMedia.delete(url);
    }

    if (this.adMedia.size > AD_URL_CACHE_LIMIT) {
      let evicted = 0;
      for (const url of this.adMedia.keys()) {
        this.adMedia.delete(url);
        evicted += 1;
        if (evicted >= 200) break;
      }
    }

    this.adPaths.clear();
    for (const [url, seenAt] of this.adMedia) {
      this.adPaths.set(urlPathKey(url), seenAt);
    }
  }
}
