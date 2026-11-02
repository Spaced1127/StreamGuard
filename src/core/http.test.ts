import { describe, expect, it } from 'vitest';
import { createResponseWithText } from './http';

describe('createResponseWithText', () => {
  it('drops stale compression and length headers from a rebuilt playlist', async () => {
    const original = new Response('compressed-body', {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-encoding': 'gzip',
        'content-length': '999',
        etag: '"stale"',
        'last-modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
      },
    });

    const text = '#EXTM3U\n#EXTINF:2.000,live\nhttps://example.com/segment.mp4';
    const rebuilt = createResponseWithText(original, text);

    expect(rebuilt.headers.get('content-encoding')).toBeNull();
    expect(rebuilt.headers.get('transfer-encoding')).toBeNull();
    expect(rebuilt.headers.get('etag')).toBeNull();
    expect(rebuilt.headers.get('last-modified')).toBeNull();
    expect(rebuilt.headers.get('content-length')).toBe(
      String(new TextEncoder().encode(text).byteLength),
    );
    expect(rebuilt.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    expect(rebuilt.status).toBe(200);
    expect(await rebuilt.text()).toBe(text);
  });
});
