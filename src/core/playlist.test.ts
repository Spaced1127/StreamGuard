import { describe, expect, it } from 'vitest';
import { blankMediaBytes } from './blank-media';
import { PlaylistEngine, urlPathKey } from './engine';
import {
  codecFamily,
  createMediaState,
  detectAdMarkers,
  parseAttributeList,
  parseMasterPlaylist,
  pickVariant,
  preferAvcMasterPlaylist,
  processMediaPlaylist,
} from './playlist';

const BASE = 'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/channel.m3u8';
const SEG = 'https://video-edge-abc.abs.hls.ttvnw.net/v1/segment';

function cleanPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-TWITCH-INFO:NONAD-BYTE-RANGE="1-2",SERVERTIME="2026-11-01T12:00:00.000Z"',
    '#EXT-X-DATERANGE:ID="session-1",CLASS="twitch-session",START-DATE="2026-11-01T12:00:00.000Z"',
    '#EXT-X-DATERANGE:ID="source-1",CLASS="twitch-stream-source",START-DATE="2026-11-01T12:00:00.000Z"',
    '#EXT-X-DATERANGE:ID="quartile-1",CLASS="twitch-ad-quartile",START-DATE="2026-11-01T12:00:00.000Z"',
    '#EXTINF:2.000,live',
    `${SEG}/live1.mp4`,
    '#EXTINF:2.000,live',
    `${SEG}/live2.mp4`,
    '#EXTINF:2.000,live',
    `${SEG}/live3.mp4`,
  ].join('\n');
}

function adPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:103',
    '#EXT-X-TWITCH-INFO:NONAD-BYTE-RANGE="1-2"',
    '#EXT-X-DISCONTINUITY',
    '#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="2026-11-01T12:00:04.000Z",DURATION=30.000,X-TV-TWITCH-AD-AD-SESSION-ID="session",X-TV-TWITCH-AD-RADS-TOKEN="token",X-TV-TWITCH-AD-POD-LENGTH="2",X-TV-TWITCH-AD-URL="https://ads.example/click"',
    '#EXTINF:2.000',
    `${SEG}/ad1.mp4`,
    '#EXTINF:2.000',
    `${SEG}/ad2.mp4`,
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:2.000,live',
    `${SEG}/live4.mp4`,
  ].join('\n');
}

function allAdPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:106',
    '#EXT-X-DATERANGE:ID="stitched-ad-2",CLASS="twitch-stitched-ad",START-DATE="2026-11-01T12:00:08.000Z",DURATION=10.000,X-TV-TWITCH-AD-AD-SESSION-ID="session"',
    '#EXTINF:2.000',
    `${SEG}/ad3.mp4`,
    '#EXTINF:2.000',
    `${SEG}/ad4.mp4`,
  ].join('\n');
}

function cueOutPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:2',
    '#EXT-X-MEDIA-SEQUENCE:200',
    '#EXT-X-CUE-OUT:30.000',
    '#EXTINF:2.000,live',
    `${SEG}/cue-ad.mp4`,
    '#EXT-X-CUE-IN',
    '#EXTINF:2.000,live',
    `${SEG}/cue-live.mp4`,
  ].join('\n');
}

describe('detectAdMarkers', () => {
  it('ignores session metadata and detects stitched ads', () => {
    expect(detectAdMarkers(cleanPlaylist()).found).toBe(false);

    const markers = detectAdMarkers(adPlaylist());
    expect(markers.found).toBe(true);
    expect(markers.markers).toContain('twitch-stitched');
    expect(markers.markers).toContain('CLASS="twitch-stitched-ad"');
    expect(markers.markers).toContain('X-TV-TWITCH-AD-*');
  });

  it('detects CUE-OUT boundaries', () => {
    expect(detectAdMarkers(cueOutPlaylist()).markers).toContain('EXT-X-CUE-OUT');
  });

  it('does not treat the persistent twitch-trigger marker as an ad', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:1',
      '#EXT-X-DATERANGE:ID="trigger-1",CLASS="twitch-trigger",START-DATE="2026-11-01T12:00:00.000Z",END-ON-NEXT=YES,X-TV-TWITCH-TRIGGER-URL="https://use14.playlist.ttvnw.net/trigger/abc"',
      '#EXTINF:2.000,live',
      `${SEG}/live.mp4`,
    ].join('\n');

    expect(detectAdMarkers(playlist).found).toBe(false);
  });
});

describe('parseAttributeList', () => {
  it('handles quoted values containing commas', () => {
    expect(
      parseAttributeList('BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.64002a,mp4a.40.2"'),
    ).toEqual({
      BANDWIDTH: '6000000',
      RESOLUTION: '1920x1080',
      CODECS: 'avc1.64002a,mp4a.40.2',
    });
  });
});

describe('processMediaPlaylist', () => {
  it('leaves a clean playlist untouched and records a recovery snapshot', () => {
    const state = createMediaState();
    const result = processMediaPlaylist(cleanPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 1_000,
    });

    expect(result.hasAds).toBe(false);
    expect(result.adSegmentUrls).toEqual([]);
    expect(result.text).toBe(cleanPlaylist());
    expect(state.lastCleanPlaylist).toBe(cleanPlaylist());
    expect(state.recoverySegments).toHaveLength(3);
    expect(state.recoveryStartSeq).toBe(100);
  });

  it('classifies non-live segments during a break as ads', () => {
    const state = createMediaState();
    const result = processMediaPlaylist(adPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 1_000,
    });

    expect(result.hasAds).toBe(true);
    expect(result.allSegmentsAd).toBe(false);
    expect(result.adSegmentUrls).toEqual([`${SEG}/ad1.mp4`, `${SEG}/ad2.mp4`]);
    expect(result.adSegmentUrls).not.toContain(`${SEG}/live4.mp4`);
    expect(result.text).toContain('X-TV-TWITCH-AD-URL="https://twitch.tv"');
    expect(result.text).not.toContain('ads.example');
  });

  it('treats live-tagged segments inside a CUE-OUT as ads', () => {
    const state = createMediaState();
    const result = processMediaPlaylist(cueOutPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 1_000,
    });

    expect(result.adSegmentUrls).toEqual([`${SEG}/cue-ad.mp4`]);
    expect(result.adSegmentUrls).not.toContain(`${SEG}/cue-live.mp4`);
  });

  it('reuses a very recent clean snapshot when every segment is an ad', () => {
    const state = createMediaState();
    processMediaPlaylist(cleanPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 10_000,
    });

    const result = processMediaPlaylist(allAdPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 11_000,
    });

    expect(result.hasAds).toBe(true);
    expect(result.allSegmentsAd).toBe(true);
    expect(result.usedSnapshot).toBe(true);
    expect(result.text).toBe(cleanPlaylist());
  });

  it('injects recovery segments when the clean snapshot is stale', () => {
    const state = createMediaState();
    processMediaPlaylist(cleanPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 10_000,
    });

    const result = processMediaPlaylist(allAdPlaylist(), state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 20_000,
    });

    expect(result.allSegmentsAd).toBe(true);
    expect(result.usedSnapshot).toBe(false);
    expect(result.usedRecovery).toBe(true);
    expect(result.text).toContain(`${SEG}/live1.mp4`);
    expect(result.text).toContain('#EXT-X-MEDIA-SEQUENCE:100');
  });

  it('drops low-latency prefetch hints during a break', () => {
    const state = createMediaState();
    const playlist = adPlaylist().replace(
      '#EXTINF:2.000,live',
      '#EXT-X-TWITCH-PREFETCH:https://video-edge-abc.abs.hls.ttvnw.net/v1/segment/ad3.mp4\n#EXTINF:2.000,live',
    );

    const result = processMediaPlaylist(playlist, state, {
      playlistUrl: BASE,
      rewriteTrackingUrls: true,
      now: 1_000,
    });

    expect(result.text).not.toContain('#EXT-X-TWITCH-PREFETCH');
  });
});

describe('parseMasterPlaylist', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-TWITCH-INFO:ORIGIN="video-edge"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=YES,DEFAULT=YES',
    '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2",VIDEO="chunked"',
    'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/1080p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d002a,mp4a.40.2",VIDEO="chunked"',
    'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/720p60.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="avc1.4d001e,mp4a.40.2",VIDEO="chunked"',
    'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/360p30.m3u8',
  ].join('\n');

  it('parses variants and picks the closest quality', () => {
    const parsed = parseMasterPlaylist(master);
    expect(parsed.isMaster).toBe(true);
    expect(parsed.variants).toHaveLength(3);
    expect(parsed.variants[0]?.codecs).toBe('avc1.64002a,mp4a.40.2');

    expect(pickVariant(parsed, '1280x720', 60)?.url).toContain('720p60.m3u8');
    expect(pickVariant(parsed, '1920x1080')?.url).toContain('1080p60.m3u8');
    expect(pickVariant(parsed, '800x600')?.url).toContain('360p30.m3u8');
  });

  it('does not mistake a media playlist for a master', () => {
    expect(parseMasterPlaylist(cleanPlaylist()).isMaster).toBe(false);
  });

  it('classifies codec families', () => {
    expect(codecFamily('avc1.64002a,mp4a.40.2')).toBe('avc');
    expect(codecFamily('hvc1.1.6.L120.90,mp4a.40.2')).toBe('hevc');
    expect(codecFamily('av01.0.08M.08,mp4a.40.2')).toBe('av1');
    expect(codecFamily(null)).toBe('unknown');
  });

  it('removes HEVC/AV1 variants when AVC is available', () => {
    const enhanced = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,FRAME-RATE=60.000,CODECS="hvc1.1.6.L150.90,mp4a.40.2"',
      'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/2160p60-hevc.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=3840x2160,FRAME-RATE=60.000,CODECS="av01.0.08M.08,mp4a.40.2"',
      'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/2160p60-av1.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,CODECS="avc1.64002a,mp4a.40.2"',
      'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/1080p60-avc.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,FRAME-RATE=60.000,CODECS="avc1.4d002a,mp4a.40.2"',
      'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/720p60-avc.m3u8',
    ].join('\n');

    const result = preferAvcMasterPlaylist(enhanced);
    expect(result.changed).toBe(true);
    expect(result.hasEnhancedVariants).toBe(true);
    expect(result.hasAvcVariants).toBe(true);
    expect(result.text).not.toContain('hvc1');
    expect(result.text).not.toContain('av01');
    expect(result.text).toContain('1080p60-avc');
    expect(result.text).toContain('720p60-avc');

    const parsed = parseMasterPlaylist(result.text);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants.every((variant) => codecFamily(variant.codecs) === 'avc')).toBe(true);
  });

  it('leaves an enhanced-only master untouched', () => {
    const enhancedOnly = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,FRAME-RATE=60.000,CODECS="hvc1.1.6.L150.90,mp4a.40.2"',
      'https://video-edge-abc.abs.hls.ttvnw.net/v1/playlist/2160p60-hevc.m3u8',
    ].join('\n');

    const result = preferAvcMasterPlaylist(enhancedOnly);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(enhancedOnly);
    expect(result.hasEnhancedVariants).toBe(true);
    expect(result.hasAvcVariants).toBe(false);
  });

  it('filters backup variant selection by codec', () => {
    const variants = parseMasterPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160,CODECS="hvc1.1.6.L150.90,mp4a.40.2"',
        'https://example.com/hevc.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4d002a,mp4a.40.2"',
        'https://example.com/avc.m3u8',
      ].join('\n'),
    );

    expect(pickVariant(variants, null)?.url).toContain('hevc.m3u8');
    expect(pickVariant(variants, null, null, 'avc')?.url).toContain('avc.m3u8');
  });
});

describe('PlaylistEngine', () => {
  it('tracks new ad URLs only once and answers segment lookups', () => {
    const engine = new PlaylistEngine();
    const base = Date.now();

    const clean = engine.process(BASE, cleanPlaylist(), {
      rewriteTrackingUrls: true,
      now: base,
    });
    expect(clean.kind).toBe('media');
    expect(clean.hasAds).toBe(false);

    const ad = engine.process(BASE, adPlaylist(), {
      rewriteTrackingUrls: true,
      now: base + 1000,
    });
    expect(ad.kind).toBe('media');
    expect(ad.newAdSegmentUrls).toEqual([`${SEG}/ad1.mp4`, `${SEG}/ad2.mp4`]);
    expect(engine.isAdMedia(`${SEG}/ad1.mp4`)).toBe(true);
    expect(engine.isAdMedia(`${SEG}/ad1.mp4?token=rotated`)).toBe(true);
    expect(engine.isAdMedia(`${SEG}/live4.mp4`)).toBe(false);

    const adAgain = engine.process(`${BASE}?token=rotated`, adPlaylist(), {
      rewriteTrackingUrls: true,
      now: base + 2000,
    });
    expect(adAgain.newAdSegmentUrls).toEqual([]);
  });

  it('leaves master playlists untouched', () => {
    const engine = new PlaylistEngine();
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080\nhttps://example.com/a.m3u8';
    const result = engine.process('https://usher.ttvnw.net/api/channel/hls/foo.m3u8', master, {
      rewriteTrackingUrls: true,
    });
    expect(result.kind).toBe('master');
    expect(result.text).toBe(master);
  });

  it('normalizes query tokens out of stream and ad keys', () => {
    expect(urlPathKey('https://a.b/c.m3u8?token=1#x')).toBe('https://a.b/c.m3u8');
  });
});

describe('blank media', () => {
  it('is a valid fragmented MP4 init segment', () => {
    const bytes = blankMediaBytes();
    expect(bytes.byteLength).toBe(1137);
    expect(String.fromCharCode(...bytes.slice(4, 8))).toBe('ftyp');
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('mp42');
  });
});
