import {
  createBlankMediaResponse,
  createResponseWithText,
  isAdBeaconUrl,
  isPlaylistUrl,
  requestUrl,
} from '../core/http';
import type { PageRuntime } from './runtime';

/**
 * Main-thread fetch hook. Twitch's IVS player normally fetches playlists inside
 * a worker (covered by worker-hook.ts); this hook covers page-side fetches,
 * embeds, and any player variant that runs on the main thread.
 */
export function installPageFetchHook(runtime: PageRuntime): void {
  const existing = window.fetch as typeof fetch & { __twitchShieldPatched?: boolean };
  if (existing.__twitchShieldPatched) return;

  const nativeFetch = existing.bind(window);

  const shieldFetch = async function shieldFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let url = '';
    try {
      url = requestUrl(input);
    } catch {
      return nativeFetch(input, init);
    }

    if (!url || !runtime.isEnabled()) return nativeFetch(input, init);

    // Capture GraphQL client headers / the PlaybackAccessToken query hash from
    // Twitch's own requests. Needed for alternate player-type token requests.
    runtime.captureRequest(input, init);

    try {
      if (runtime.isAdMedia(url)) {
        return createBlankMediaResponse();
      }

      if (!isPlaylistUrl(url)) {
        if (isAdBeaconUrl(url)) runtime.noteCsaiRequest(url);
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
      try {
        const result = runtime.processPlaylist(url, text);
        if (result) {
          output = result.text;
          if (result.kind === 'media') {
            runtime.applyPageResult(result, url);
          } else if (result.kind === 'master') {
            runtime.noteMasterPlaylist(url);
          }
        }
      } catch (error) {
        runtime.log('playlist processing failed', error);
      }

      return createResponseWithText(response, output);
    } catch (error) {
      runtime.log('fetch hook failed', error);
      return nativeFetch(input, init);
    }
  };

  const masked = shieldFetch as typeof shieldFetch & { __twitchShieldPatched?: boolean };
  masked.__twitchShieldPatched = true;

  // Passive feature-detection by the page should still see a native function.
  try {
    Object.defineProperty(masked, 'toString', {
      value: () => Function.prototype.toString.call(nativeFetch),
      configurable: true,
    });
  } catch {
    // Non-fatal.
  }

  window.fetch = shieldFetch;
}
