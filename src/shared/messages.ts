import type { PlaylistEventPayload, WorkerMessage } from './types';

/**
 * Page <-> bridge messaging. Both sides are content scripts; the page side runs
 * in Twitch's MAIN world and therefore has no access to extension APIs.
 */
export const WINDOW_CHANNEL = '__twitch_shield_v1' as const;
export const WORKER_CHANNEL = '__twitch_shield_worker_v1' as const;

export type WindowMessageType =
  | 'hello'
  | 'settings'
  | 'stats'
  | 'reset-stats'
  | 'playlist'
  | 'log';

export interface WindowEnvelope {
  __twitchShield: typeof WINDOW_CHANNEL;
  type: WindowMessageType;
  payload?: unknown;
}

export function postToWindow(type: WindowMessageType, payload?: unknown): void {
  try {
    window.postMessage({ __twitchShield: WINDOW_CHANNEL, type, payload }, '*');
  } catch {
    // Never let a messaging failure break Twitch.
  }
}

export function isWindowEnvelope(data: unknown): data is WindowEnvelope {
  if (typeof data !== 'object' || data === null) return false;
  const record = data as Record<string, unknown>;
  return record.__twitchShield === WINDOW_CHANNEL && typeof record.type === 'string';
}

export function isPlaylistEvent(data: unknown): data is PlaylistEventPayload {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Partial<PlaylistEventPayload>;
  return (
    (value.source === 'worker' || value.source === 'page') &&
    typeof value.url === 'string' &&
    typeof value.hasAds === 'boolean' &&
    Array.isArray(value.newAdSegmentUrls)
  );
}

export function isWorkerMessage(data: unknown): data is WorkerMessage {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Partial<WorkerMessage>;
  return value.__twitchShieldWorker === 1 && typeof value.kind === 'string';
}

/** Message sent from the page into the patched player worker. */
export interface WorkerConfigMessage {
  __twitchShieldConfig: 1;
  config: {
    enabled: boolean;
    rewriteTrackingUrls: boolean;
    debug: boolean;
  };
}

export function isWorkerConfigMessage(data: unknown): data is WorkerConfigMessage {
  if (typeof data !== 'object' || data === null) return false;
  return (data as Record<string, unknown>).__twitchShieldConfig === 1;
}

/** Reply from the page to a worker's token-request message. */
export interface TokenResponseMessage {
  __twitchShieldTokenResponse: 1;
  id: string;
  token: { value: string; signature: string } | null;
}

export function isTokenResponseMessage(data: unknown): data is TokenResponseMessage {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  return value.__twitchShieldTokenResponse === 1 && typeof value.id === 'string';
}
