import { build } from 'esbuild';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { WorkerConfig } from '../shared/types';

/**
 * Executes the real worker bundle in a VM realm with a fake fetch, mirroring
 * how page.js injects it into Twitch's player worker. This catches bundling or
 * blob-serialization regressions that tests of the pure engine cannot.
 */

const MASTER_URL = 'https://usher.ttvnw.net/api/channel/hls/foo.m3u8?token=main-token&sig=main-sig';
const MEDIA_URL = 'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/channel.m3u8';
const SEG = 'https://video-edge-abc.abs.hls.ttvnw.net/v1/segment';
const BACKUP_MEDIA_URL = 'https://backup-edge.abs.hls.ttvnw.net/v1/playlist/720p60.m3u8';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d002a,mp4a.40.2"',
  MEDIA_URL,
].join('\n');

const MEDIA_WITH_AD_SEGMENTS = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:500',
  '#EXT-X-DATERANGE:ID="stitched-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-01T12:00:00.000Z",DURATION=10.000,X-TV-TWITCH-AD-URL="https://ads.example/click"',
  '#EXTINF:2.000',
  `${SEG}/ad1.mp4`,
  '#EXTINF:2.000',
  `${SEG}/ad2.mp4`,
  '#EXTINF:2.000,live',
  `${SEG}/live1.mp4`,
].join('\n');

/** CSAI: an ad is being served outside the playlist; all segments are live. */
const MEDIA_CSAI = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:600',
  '#EXT-X-DATERANGE:ID="maf-1",CLASS="twitch-maf-ad",START-DATE="2026-11-01T12:00:00.000Z"',
  '#EXTINF:2.000,live',
  `${SEG}/csai-live1.mp4`,
  '#EXTINF:2.000,live',
  `${SEG}/csai-live2.mp4`,
].join('\n');

const BACKUP_MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d002a,mp4a.40.2"',
  BACKUP_MEDIA_URL,
].join('\n');

const CLEAN_BACKUP_MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MEDIA-SEQUENCE:900',
  '#EXTINF:2.000,live',
  'https://backup-edge.abs.hls.ttvnw.net/v1/segment/clean1.mp4',
  '#EXTINF:2.000,live',
  'https://backup-edge.abs.hls.ttvnw.net/v1/segment/clean2.mp4',
].join('\n');

interface BootOptions {
  fetchImpl: (url: string) => Promise<Response>;
  token?: { value: string; signature: string } | null;
  config?: Partial<WorkerConfig>;
}

async function bootWorker(options: BootOptions) {
  const bundled = await build({
    entryPoints: ['src/worker/runtime.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  });

  const source = bundled.outputFiles[0]?.text;
  if (!source) throw new Error('empty worker bundle');

  const requests: string[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const listeners: Array<(event: { data: unknown }) => void> = [];

  const fakeFetch = async (input: RequestInfo | URL | string): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    return options.fetchImpl(url);
  };

  const postMessage = (message: unknown): void => {
    if (typeof message !== 'object' || message === null) return;
    messages.push(message as Record<string, unknown>);

    const record = message as Record<string, unknown>;
    if (record.kind === 'token-request' && options.token) {
      const payload = record.payload as { id?: string };
      const token = options.token;
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({
            data: {
              __twitchShieldTokenResponse: 1,
              id: payload?.id,
              token,
            },
          });
        }
      });
    }
  };

  const context = vm.createContext({
    __TWITCH_SHIELD_CONFIG__: {
      enabled: true,
      rewriteTrackingUrls: true,
      backupStream: true,
      debug: false,
      ...options.config,
    },
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    Response,
    Headers,
    Blob,
    AbortController,
    atob,
    Uint8Array,
    setTimeout,
    clearTimeout,
    fetch: fakeFetch,
    postMessage,
    addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
      if (type === 'message') listeners.push(listener);
    },
  });

  vm.runInContext(source, context);
  const shieldFetch = context.fetch as typeof fetch;
  return { shieldFetch, requests, messages };
}

function fakeResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
  });
}

describe('worker runtime', () => {
  it('intercepts playlists, reports breaks, and blanks ad media locally', async () => {
    const { shieldFetch, requests, messages } = await bootWorker({
      config: { backupStream: false },
      fetchImpl: async (url) => {
        if (url.includes('/channel/hls/')) return fakeResponse(MASTER);
        if (url.includes('/v1/playlist/')) return fakeResponse(MEDIA_WITH_AD_SEGMENTS);
        return new Response('segment-bytes', { status: 200 });
      },
    });

    const masterResponse = await shieldFetch(MASTER_URL);
    expect(await masterResponse.text()).toBe(MASTER);
    expect(requests).toEqual([MASTER_URL]);

    const mediaResponse = await shieldFetch(MEDIA_URL);
    const mediaText = await mediaResponse.text();
    expect(mediaText).toContain('X-TV-TWITCH-AD-URL="https://twitch.tv"');
    expect(mediaText).not.toContain('ads.example');

    const playlistMessage = messages.find((message) => message.kind === 'playlist');
    expect(playlistMessage).toBeDefined();
    const payload = playlistMessage?.payload as Record<string, unknown>;
    expect(payload.channel).toBe('foo');
    expect(payload.hasAds).toBe(true);
    expect(payload.newAdSegmentUrls).toEqual([`${SEG}/ad1.mp4`, `${SEG}/ad2.mp4`]);
    expect(payload.backupType).toBeNull();

    // The ad segment is served from the in-memory blank fMP4, never the network.
    const blankResponse = await shieldFetch(`${SEG}/ad1.mp4`);
    expect(blankResponse.headers.get('content-type')).toBe('video/mp4');
    const blankBytes = new Uint8Array(await blankResponse.arrayBuffer());
    expect(blankBytes.byteLength).toBe(1137);
    expect(requests).toEqual([MASTER_URL, MEDIA_URL]);

    // A live segment is passed straight through.
    await shieldFetch(`${SEG}/live1.mp4`);
    expect(requests).toEqual([MASTER_URL, MEDIA_URL, `${SEG}/live1.mp4`]);
  });

  it('swaps to a clean alternate player-type feed during a CSAI break', async () => {
    const { shieldFetch, requests, messages } = await bootWorker({
      token: { value: 'backup-token', signature: 'backup-sig' },
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (url.includes('/channel/hls/')) {
          return fakeResponse(parsed.searchParams.get('token') === 'backup-token' ? BACKUP_MASTER : MASTER);
        }
        if (url === BACKUP_MEDIA_URL) return fakeResponse(CLEAN_BACKUP_MEDIA);
        if (url === MEDIA_URL) return fakeResponse(MEDIA_CSAI);
        return new Response('segment-bytes', { status: 200 });
      },
    });

    await shieldFetch(MASTER_URL);
    const mediaResponse = await shieldFetch(MEDIA_URL);

    // The player receives the clean backup playlist, not the CSAI playlist.
    expect(await mediaResponse.text()).toBe(CLEAN_BACKUP_MEDIA);

    const tokenRequest = messages.find((message) => message.kind === 'token-request');
    expect(tokenRequest).toBeDefined();

    const playlistMessage = [...messages]
      .reverse()
      .find((message) => message.kind === 'playlist');
    const payload = playlistMessage?.payload as Record<string, unknown>;
    expect(payload.hasAds).toBe(true);
    expect(payload.backupType).toBe('site');
    expect(requests.some((url) => url.includes('token=backup-token'))).toBe(true);
    expect(requests).toContain(BACKUP_MEDIA_URL);
  });
});
