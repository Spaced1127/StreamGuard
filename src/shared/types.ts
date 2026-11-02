/**
 * Shared types used by the page hooks, worker runtime, bridge, background
 * worker and popup. Keep this module free of DOM/extension-specific imports so
 * it can be bundled into every context (including Twitch's player worker).
 */

export interface ShieldSettings {
  /** Master switch. When false the page and worker hooks become no-ops. */
  enabled: boolean;
  /** Rewrite Twitch's ad click-through URLs in playlists to twitch.tv. */
  rewriteTrackingUrls: boolean;
  /** Hide and mute Amazon-hosted video ads rendered next to chat/player. */
  hideSideAds: boolean;
  /** Switch to a clean alternate player type during ad breaks. */
  backupStream: boolean;
  /** Show the small "blocking" badge over the player during breaks. */
  showOverlay: boolean;
  /** Verbose console diagnostics, prefixed with [TwitchShield]. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: ShieldSettings = {
  enabled: true,
  rewriteTrackingUrls: true,
  hideSideAds: true,
  backupStream: true,
  showOverlay: true,
  debug: false,
};

/** Settings snapshot injected into Twitch's player worker at construction. */
export interface WorkerConfig {
  enabled: boolean;
  rewriteTrackingUrls: boolean;
  backupStream: boolean;
  debug: boolean;
}

export function toWorkerConfig(settings: ShieldSettings): WorkerConfig {
  return {
    enabled: settings.enabled,
    rewriteTrackingUrls: settings.rewriteTrackingUrls,
    backupStream: settings.backupStream,
    debug: settings.debug,
  };
}

export interface TabStats {
  channel: string | null;
  enabled: boolean;
  /** True while the page believes an ad break is in progress. */
  blocking: boolean;
  breaksBlocked: number;
  segmentsBlanked: number;
  /** Ad breaks where a clean alternate player-type feed was used. */
  backupsUsed: number;
  sideAdsHidden: number;
  /** Client-side ad requests observed (CSAI beacons). */
  csaiRequests: number;
  updatedAt: number;
  /** Page URL that produced these stats, for the popup. */
  pageUrl?: string;
}

export function emptyTabStats(): TabStats {
  return {
    channel: null,
    enabled: true,
    blocking: false,
    breaksBlocked: 0,
    segmentsBlanked: 0,
    backupsUsed: 0,
    sideAdsHidden: 0,
    csaiRequests: 0,
    updatedAt: 0,
  };
}

export interface PlaylistEventPayload {
  source: 'worker' | 'page';
  channel: string | null;
  url: string;
  hasAds: boolean;
  markers: string[];
  newAdSegmentUrls: string[];
  allSegmentsAd: boolean;
  usedRecovery: boolean;
  usedSnapshot: boolean;
  /** Player type whose clean feed is being served, when backup swap succeeded. */
  backupType?: string | null;
  ts: number;
}

export interface TokenRequestPayload {
  id: string;
  channel: string;
  playerType: string;
}

export interface WorkerMessage {
  __twitchShieldWorker: 1;
  kind: 'playlist' | 'csai' | 'log' | 'token-request';
  payload:
    | PlaylistEventPayload
    | { url: string }
    | { message: string }
    | TokenRequestPayload;
}
