import { createBlankMediaBlob } from './blank-media';

/** URL heuristics for Twitch's master/media playlist fetches. */
export function isPlaylistUrl(rawUrl: string): boolean {
  return (
    /\.m3u8(?:[?#]|$)/i.test(rawUrl) ||
    /\/channel\/hls\//i.test(rawUrl) ||
    /\/v1\/playlist\//i.test(rawUrl) ||
    /\/v2\/playlist\//i.test(rawUrl)
  );
}

export function isAdBeaconUrl(rawUrl: string): boolean {
  return /(?:edge\.)?ads\.twitch\.tv|amazon-adsystem\.com/i.test(rawUrl);
}

export function requestUrl(input: RequestInfo | URL | string): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
}

/** Rebuild a consumed response with rewritten playlist text. */
export function createResponseWithText(response: Response, text: string): Response {
  const headers = new Headers(response.headers);

  // The fetch body is already decompressed. Copying the original encoding or
  // length headers would make the player try to inflate plain text (or read a
  // stale length), producing black screens / player errors on some networks.
  for (const header of [
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'etag',
    'last-modified',
  ]) {
    headers.delete(header);
  }

  const bytes = new TextEncoder().encode(text);
  headers.set('content-length', String(bytes.byteLength));
  headers.set('cache-control', 'no-store');

  const status = response.status >= 200 && response.status <= 599 ? response.status : 200;
  const output = new Response(bytes, {
    status,
    statusText: response.statusText,
    headers,
  });

  // Some players inspect these. The Response constructor only accepts status
  // and headers, so define the read-only metadata on the instance.
  try {
    Object.defineProperty(output, 'url', { value: response.url, configurable: true });
    Object.defineProperty(output, 'redirected', {
      value: response.redirected,
      configurable: true,
    });
    Object.defineProperty(output, 'type', { value: response.type, configurable: true });
  } catch {
    // Non-fatal; the body and headers are what matter for playback.
  }

  return output;
}

export function createBlankMediaResponse(): Response {
  const blob = createBlankMediaBlob();
  return new Response(blob, {
    status: 200,
    statusText: 'OK',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(blob.size),
      'Cache-Control': 'no-store',
    },
  });
}
