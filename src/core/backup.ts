/**
 * Twitch playback-token and clean-backup helpers.
 *
 * Twitch's own player gets a PlaybackAccessToken for player type `site`, which
 * can carry server/client-side ads. Requesting a token for another player type
 * (`popout`, `mobile_web`, `embed`, or Android `autoplay`) often returns a
 * stream without the ad break. These helpers build that request and the usher
 * playlist URL; the worker runtime drives the retry/variant selection.
 */

export const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

/**
 * Fallback persisted-query hash. The page's own PlaybackAccessToken request is
 * captured at runtime and preferred when available, since Twitch can rotate
 * this hash.
 */
export const DEFAULT_TOKEN_QUERY_HASH =
  'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9';

export const PLAYER_TYPES = ['site', 'autoplay', 'popout', 'mobile_web', 'embed'] as const;
export type PlayerType = (typeof PLAYER_TYPES)[number];

export interface PlaybackToken {
  value: string;
  signature: string;
}

export interface TokenRequestVariables {
  isLive: true;
  login: string;
  isVod: false;
  vodID: '';
  playerType: PlayerType;
  platform: 'web' | 'android';
}

export interface TokenRequestBody {
  operationName: 'PlaybackAccessToken';
  variables: TokenRequestVariables;
  extensions: {
    persistedQuery: {
      version: 1;
      sha256Hash: string;
    };
  };
}

export function buildTokenRequestBody(
  channel: string,
  playerType: PlayerType,
  queryHash: string,
): TokenRequestBody {
  return {
    operationName: 'PlaybackAccessToken',
    variables: {
      isLive: true,
      login: channel,
      isVod: false,
      vodID: '',
      playerType,
      platform: playerType === 'autoplay' ? 'android' : 'web',
    },
    extensions: {
      persistedQuery: {
        version: 1,
        sha256Hash: queryHash,
      },
    },
  };
}

/**
 * Reuse the page's captured PlaybackAccessToken request shape, overriding only
 * the channel/player type. This preserves extra variables such as
 * `playerBackend` and future persisted-query additions.
 */
export function buildTokenRequestBodyFromTemplate(
  template: Record<string, unknown> | null,
  channel: string,
  playerType: PlayerType,
  queryHash: string,
): TokenRequestBody {
  const fallback = buildTokenRequestBody(channel, playerType, queryHash);
  if (!template) return fallback;

  const templateVariables =
    template.variables && typeof template.variables === 'object'
      ? (template.variables as Record<string, unknown>)
      : {};

  let extensions: TokenRequestBody['extensions'] = fallback.extensions;
  if (template.extensions && typeof template.extensions === 'object') {
    const templateExtensions = template.extensions as Record<string, unknown>;
    const persistedQuery = templateExtensions.persistedQuery;
    extensions = {
      ...templateExtensions,
      persistedQuery:
        persistedQuery && typeof persistedQuery === 'object'
          ? (persistedQuery as TokenRequestBody['extensions']['persistedQuery'])
          : fallback.extensions.persistedQuery,
    };
  }

  return {
    operationName: 'PlaybackAccessToken',
    variables: {
      ...templateVariables,
      isLive: true,
      login: channel,
      isVod: false,
      vodID: '',
      playerType,
      platform: playerType === 'autoplay' ? 'android' : 'web',
    },
    extensions,
  } as TokenRequestBody;
}

/** Twitch has returned both nested and flat response shapes over time. */
export function parseTokenResponse(json: unknown): PlaybackToken | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as {
    data?: { streamPlaybackAccessToken?: { value?: unknown; signature?: unknown } };
    streamPlaybackAccessToken?: { value?: unknown; signature?: unknown };
  };
  const token = record.data?.streamPlaybackAccessToken ?? record.streamPlaybackAccessToken;
  if (!token || typeof token.value !== 'string' || typeof token.signature !== 'string') {
    return null;
  }
  return { value: token.value, signature: token.signature };
}

/**
 * Reuse the usher URL the player already requested, replacing its token.
 * `parent_domains` is dropped: it marks embedded players and Twitch can return
 * "fake" ads for those sessions.
 */
export function buildBackupMasterUrl(masterUrl: string, token: PlaybackToken): string {
  const url = new URL(masterUrl);
  url.searchParams.set('sig', token.signature);
  url.searchParams.set('token', token.value);
  url.searchParams.delete('parent_domains');
  return url.href;
}
