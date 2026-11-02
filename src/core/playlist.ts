/**
 * HLS/playlist ad detection and stripping.
 *
 * Twitch stitches ads into the live media playlist. There is no clean URL seam
 * to block: ad segments are served from the same CDN as the stream. The
 * approach here is:
 *
 *  1. Detect ad markers in the media playlist (`twitch-stitched-*`,
 *     `EXT-X-CUE-OUT`, `twitch-maf-ad`, `X-TV-TWITCH-AD-*`).
 *  2. Classify segments inside a break. Twitch tags genuine live segments with
 *     a `,live` EXTINF title; stitched ad segments lack it.
 *  3. Keep the playlist structure intact (so the player's timeline does not
 *     jump) and let the fetch hook serve a tiny blank fMP4 for every classified
 *     ad segment URL.
 *  4. If an entire playlist is ads, replay a recent clean snapshot or append
 *     recovery segments so the player is not left with a black screen.
 *
 * This module is intentionally pure: it takes text + state and returns text +
 * metadata. The same code is bundled into the page hook and the patched Twitch
 * player worker.
 */

export interface LiveSegment {
  extinf: string;
  url: string;
}

export interface MediaPlaylistState {
  lastCleanPlaylist: string | null;
  lastCleanAt: number;
  recoverySegments: LiveSegment[];
  recoveryStartSeq: number | null;
  consecutiveAllAdPolls: number;
}

export function createMediaState(): MediaPlaylistState {
  return {
    lastCleanPlaylist: null,
    lastCleanAt: 0,
    recoverySegments: [],
    recoveryStartSeq: null,
    consecutiveAllAdPolls: 0,
  };
}

export interface ProcessPlaylistOptions {
  playlistUrl: string;
  rewriteTrackingUrls: boolean;
  now?: number;
}

export interface ProcessedPlaylist {
  text: string;
  hasAds: boolean;
  adSegmentUrls: string[];
  markers: string[];
  allSegmentsAd: boolean;
  usedRecovery: boolean;
  usedSnapshot: boolean;
  segmentCount: number;
}

export interface Variant {
  url: string;
  attributes: Record<string, string>;
  resolution: string | null;
  bandwidth: number | null;
  frameRate: number | null;
  codecs: string | null;
}

export interface MasterPlaylist {
  isMaster: boolean;
  variants: Variant[];
}

/** Segment URL fragments that are always ads, even without playlist markers. */
export const AD_SEGMENT_PATTERNS = ['/adsquared/', '/_404/', '/processing'];

const TWITCH_AD_URL_RE = /(X-TV-TWITCH-AD(?:-[A-Z]+)*-URLS?=")[^"]*(")/g;
const TWITCH_AD_CLASS_RE = /#EXT-X-DATERANGE:[^\n]*\bCLASS="([^"]+)"/g;
const TWITCH_AD_ATTR_RE = /#EXT-X-DATERANGE:[^\n]*X-TV-TWITCH-AD-[A-Z-]+=/;

/**
 * Twitch's ad markers are deliberately broad so newly-named markers in the
 * `twitch-stitched-*` family are caught without a code change.
 *
 * `twitch-trigger` is NOT an ad marker. Since at least late 2026 Twitch puts a
 * persistent, END-ON-NEXT `twitch-trigger` DATERANGE with an
 * `X-TV-TWITCH-TRIGGER-URL` on every playlist for the life of a stream,
 * including while normal content is playing. Treating it as an ad leaves the
 * shield permanently "blocking" and causes needless backup swaps.
 *
 * `twitch-session`, `twitch-stream-source` and `twitch-ad-quartile` are also
 * session metadata.
 */
export function detectAdMarkers(text: string): { found: boolean; markers: string[] } {
  const markers = new Set<string>();

  if (text.includes('twitch-stitched')) markers.add('twitch-stitched');
  if (text.includes('#EXT-X-CUE-OUT')) markers.add('EXT-X-CUE-OUT');
  if (text.includes('SCTE35-OUT')) markers.add('SCTE35-OUT');
  if (TWITCH_AD_ATTR_RE.test(text)) markers.add('X-TV-TWITCH-AD-*');

  TWITCH_AD_CLASS_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TWITCH_AD_CLASS_RE.exec(text)) !== null) {
    const className = match[1] ?? '';
    if (className.startsWith('twitch-stitched') || className === 'twitch-maf-ad') {
      markers.add(`CLASS="${className}"`);
    }
  }

  return { found: markers.size > 0, markers: [...markers] };
}

/** Small, quote-aware parser for HLS attribute lists. */
export function parseAttributeList(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let index = 0;

  while (index < input.length) {
    while (index < input.length && (input[index] === ',' || input[index] === ' ')) index += 1;
    if (index >= input.length) break;

    const equals = input.indexOf('=', index);
    if (equals === -1) break;

    const key = input.slice(index, equals).trim();
    if (!key || key.includes(',')) {
      const comma = input.indexOf(',', index);
      if (comma === -1) break;
      index = comma + 1;
      continue;
    }

    index = equals + 1;
    let value = '';

    if (input[index] === '"') {
      index += 1;
      while (index < input.length && input[index] !== '"') {
        value += input[index];
        index += 1;
      }
      index += 1; // closing quote
    } else {
      const comma = input.indexOf(',', index);
      value = (comma === -1 ? input.slice(index) : input.slice(index, comma)).trim();
      index = comma === -1 ? input.length : comma;
    }

    attributes[key] = value;

    const comma = input.indexOf(',', index);
    if (comma === -1) break;
    index = comma + 1;
  }

  return attributes;
}

export function parseMasterPlaylist(text: string): MasterPlaylist {
  if (!text.includes('#EXT-X-STREAM-INF')) return { isMaster: false, variants: [] };

  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const colon = line.indexOf(':');
    const attributes = parseAttributeList(colon === -1 ? '' : line.slice(colon + 1));

    let url = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = (lines[next] ?? '').trim();
      if (!candidate || candidate.startsWith('#')) continue;
      url = candidate;
      break;
    }
    if (!url) continue;

    const bandwidth = Number(attributes.BANDWIDTH);
    const frameRate = Number(attributes['FRAME-RATE']);

    variants.push({
      url,
      attributes,
      resolution: attributes.RESOLUTION ?? null,
      bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
      frameRate: Number.isFinite(frameRate) ? frameRate : null,
      codecs: attributes.CODECS ?? null,
    });
  }

  return { isMaster: true, variants };
}

export type CodecFamily = 'avc' | 'hevc' | 'av1' | 'unknown';

/** Classify an HLS CODECS attribute without throwing on missing values. */
export function codecFamily(codecs: string | null): CodecFamily {
  if (!codecs) return 'unknown';
  for (const part of String(codecs).toLowerCase().split(',')) {
    const codec = part.trim();
    if (codec.startsWith('avc')) return 'avc';
    if (codec.startsWith('hev') || codec.startsWith('hvc')) return 'hevc';
    if (codec.startsWith('av0')) return 'av1';
  }
  return 'unknown';
}

export interface AvcPreferenceResult {
  text: string;
  changed: boolean;
  hasEnhancedVariants: boolean;
  hasAvcVariants: boolean;
}

/**
 * Enhanced broadcasts expose 2K/4K HEVC or AV1 variants. Mixing those with an
 * AVC backup feed (or feeding an AVC blank segment into an HEVC decoder) makes
 * Twitch's player throw error #4000 on Chromium/Brave.
 *
 * If the master offers both enhanced and AVC variants, drop the enhanced
 * variants so the player stays on AVC for the whole session. If the stream is
 * enhanced-only, return it untouched and let the caller disable ad handling
 * rather than risk breaking playback.
 */
export function preferAvcMasterPlaylist(text: string): AvcPreferenceResult {
  const parsed = parseMasterPlaylist(text);
  const families = parsed.variants.map((variant) => codecFamily(variant.codecs));
  const hasEnhancedVariants = families.some((family) => family === 'hevc' || family === 'av1');
  const hasAvcVariants = families.includes('avc');

  const unchanged: AvcPreferenceResult = {
    text,
    changed: false,
    hasEnhancedVariants,
    hasAvcVariants,
  };

  if (!parsed.isMaster || !hasEnhancedVariants || !hasAvcVariants) return unchanged;

  const lines = text.split(/\r?\n/);
  const remove = new Set<number>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const colon = line.indexOf(':');
    const attributes = parseAttributeList(colon === -1 ? '' : line.slice(colon + 1));
    const family = codecFamily(attributes.CODECS ?? null);
    if (family !== 'hevc' && family !== 'av1') continue;

    remove.add(index);
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next] ?? '';
      if (!candidate.trim() || candidate.startsWith('#')) continue;
      remove.add(next);
      break;
    }
  }

  if (remove.size === 0) return unchanged;

  const adjusted = lines.filter((_, index) => !remove.has(index)).join('\n');
  const check = parseMasterPlaylist(adjusted);
  if (!check.isMaster || check.variants.length === 0) return unchanged;

  return {
    text: adjusted,
    changed: true,
    hasEnhancedVariants: true,
    hasAvcVariants: true,
  };
}

/**
 * Pick the variant closest to a requested resolution/quality. Used by the
 * backup-stream swap so the alternate feed matches the viewer's quality. Pass
 * `codec` to restrict the candidate set to a compatible decoder family.
 */
export function pickVariant(
  master: MasterPlaylist,
  resolution: string | null,
  frameRate?: number | null,
  codec?: CodecFamily | null,
): Variant | null {
  const candidates = codec
    ? master.variants.filter((variant) => codecFamily(variant.codecs) === codec)
    : master.variants;
  if (candidates.length === 0) return null;

  const target = parseResolution(resolution);
  if (!target) return candidates[0] ?? null;

  let best: Variant | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const variant of candidates) {
    const candidate = parseResolution(variant.resolution);
    if (!candidate) continue;
    const areaDiff = Math.abs(candidate.width * candidate.height - target.width * target.height);
    const frameRatePenalty =
      frameRate && variant.frameRate && Math.abs(variant.frameRate - frameRate) > 1 ? 1_000_000 : 0;
    const score = areaDiff + frameRatePenalty;
    if (score < bestScore) {
      bestScore = score;
      best = variant;
    }
  }

  return best ?? candidates[0] ?? null;
}

function parseResolution(value: string | null): { width: number; height: number } | null {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width, height };
}

interface ParsedSegment {
  extinf: string;
  extinfIndex: number;
  url: string;
  urlIndex: number;
  isLive: boolean;
  inCueOut: boolean;
}

function parseSegments(lines: string[]): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let inCueOut = false;
  let pending: { extinf: string; extinfIndex: number; inCueOut: boolean } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (line.startsWith('#EXT-X-CUE-OUT')) {
      inCueOut = true;
    } else if (line.startsWith('#EXT-X-CUE-IN')) {
      inCueOut = false;
    }

    if (line.startsWith('#EXTINF')) {
      pending = { extinf: line, extinfIndex: index, inCueOut };
      continue;
    }

    if (pending && line.trim() && !line.startsWith('#')) {
      segments.push({
        extinf: pending.extinf,
        extinfIndex: pending.extinfIndex,
        url: line.trim(),
        urlIndex: index,
        isLive: /,\s*live\b/i.test(pending.extinf),
        inCueOut: pending.inCueOut,
      });
      pending = null;
    }

    // A prefetch hint can point at media that has not appeared as a segment
    // yet. It is not a segment, so leave the pending EXTINF untouched.
  }

  return segments;
}

function parseMediaSequence(text: string): number | null {
  const match = /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function resolveUrl(raw: string, base: string): string {
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}

function prefetchUrl(line: string): string | null {
  if (line.startsWith('#EXT-X-TWITCH-PREFETCH:')) {
    return line.slice('#EXT-X-TWITCH-PREFETCH:'.length).trim();
  }
  if (line.startsWith('#EXT-X-PRELOAD-HINT:')) {
    const match = /URI="([^"]+)"/.exec(line);
    return match?.[1] ?? null;
  }
  return null;
}

export function isAdSegmentUrl(url: string): boolean {
  return AD_SEGMENT_PATTERNS.some((pattern) => url.includes(pattern));
}

/**
 * Process a media playlist. Does not remove ad segment lines: the fetch hook
 * needs the player to request those URLs so it can substitute blank media and
 * keep the media timeline continuous.
 */
export function processMediaPlaylist(
  text: string,
  state: MediaPlaylistState,
  options: ProcessPlaylistOptions,
): ProcessedPlaylist {
  const now = options.now ?? Date.now();
  const lines = text.split(/\r?\n/);
  const markerInfo = detectAdMarkers(text);
  const segments = parseSegments(lines);

  const adUrls = new Set<string>();
  let adSegmentCount = 0;

  for (const segment of segments) {
    const resolved = resolveUrl(segment.url, options.playlistUrl);
    const byPattern = isAdSegmentUrl(segment.url) || isAdSegmentUrl(resolved);
    const byBreak = markerInfo.found && (!segment.isLive || segment.inCueOut);

    if (byPattern || byBreak) {
      adSegmentCount += 1;
      adUrls.add(resolved);
    }
  }

  // Prefetch/preload hints can leak an ad URL before the EXTINF line appears.
  // Treat pattern-matching hints as ad media so the fetch hook blanks them.
  for (const line of lines) {
    const hinted = prefetchUrl(line);
    if (!hinted) continue;
    if (isAdSegmentUrl(hinted)) {
      adUrls.add(resolveUrl(hinted, options.playlistUrl));
    }
  }

  const hasAds = markerInfo.found || adUrls.size > 0;
  const allSegmentsAd = segments.length > 0 && adSegmentCount === segments.length;
  const fullyClean = !markerInfo.found && adUrls.size === 0 && segments.length > 0;

  if (fullyClean) {
    state.lastCleanPlaylist = text;
    state.lastCleanAt = now;

    const liveSegments = segments.filter((segment) => segment.isLive && !segment.inCueOut);
    if (liveSegments.length > 0) {
      state.recoverySegments = liveSegments.slice(-6).map((segment) => ({
        extinf: segment.extinf,
        url: segment.url,
      }));

      const mediaSequence = parseMediaSequence(text);
      if (mediaSequence !== null) {
        const recoveryCount = state.recoverySegments.length;
        state.recoveryStartSeq = mediaSequence + Math.max(0, liveSegments.length - recoveryCount);
      }
    }
  }

  if (allSegmentsAd) {
    state.consecutiveAllAdPolls += 1;
  } else {
    state.consecutiveAllAdPolls = 0;
  }

  // If every segment is an ad, a playlist full of blank media would leave the
  // player with nothing to display. Prefer a very recent clean snapshot, then
  // fall back to replaying the last few live segments.
  if (allSegmentsAd && hasAds) {
    const snapshotAge = state.lastCleanAt > 0 ? now - state.lastCleanAt : Number.POSITIVE_INFINITY;
    if (state.lastCleanPlaylist && snapshotAge <= 1500) {
      return {
        text: state.lastCleanPlaylist,
        hasAds: true,
        adSegmentUrls: [...adUrls],
        markers: markerInfo.markers,
        allSegmentsAd: true,
        usedRecovery: false,
        usedSnapshot: true,
        segmentCount: segments.length,
      };
    }

    if (state.recoverySegments.length > 0) {
      if (state.recoveryStartSeq !== null) {
        for (let index = 0; index < lines.length; index += 1) {
          if ((lines[index] ?? '').startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
            lines[index] = `#EXT-X-MEDIA-SEQUENCE:${state.recoveryStartSeq}`;
            break;
          }
        }
      }
      for (const segment of state.recoverySegments) {
        lines.push(segment.extinf);
        lines.push(segment.url);
      }

      return finalizeStrippedPlaylist(lines, {
        hasAds: true,
        adSegmentUrls: [...adUrls],
        markers: markerInfo.markers,
        allSegmentsAd: true,
        usedRecovery: true,
        usedSnapshot: false,
        segmentCount: segments.length,
        rewriteTrackingUrls: options.rewriteTrackingUrls,
      });
    }
  }

  return finalizeStrippedPlaylist(lines, {
    hasAds,
    adSegmentUrls: [...adUrls],
    markers: markerInfo.markers,
    allSegmentsAd,
    usedRecovery: false,
    usedSnapshot: false,
    segmentCount: segments.length,
    rewriteTrackingUrls: options.rewriteTrackingUrls,
  });
}

function finalizeStrippedPlaylist(
  lines: string[],
  meta: {
    hasAds: boolean;
    adSegmentUrls: string[];
    markers: string[];
    allSegmentsAd: boolean;
    usedRecovery: boolean;
    usedSnapshot: boolean;
    segmentCount: number;
    rewriteTrackingUrls: boolean;
  },
): ProcessedPlaylist {
  const output = lines.map((line) => {
    // Low-latency hints let the player prefetch ad parts before the next
    // playlist poll, so drop them for the duration of a break.
    if (
      meta.hasAds &&
      (line.startsWith('#EXT-X-TWITCH-PREFETCH:') || line.startsWith('#EXT-X-PRELOAD-HINT:'))
    ) {
      return '';
    }
    if (!meta.rewriteTrackingUrls) return line;
    return line.replace(TWITCH_AD_URL_RE, '$1https://twitch.tv$2');
  });

  return {
    text: output.join('\n'),
    hasAds: meta.hasAds,
    adSegmentUrls: meta.adSegmentUrls,
    markers: meta.markers,
    allSegmentsAd: meta.allSegmentsAd,
    usedRecovery: meta.usedRecovery,
    usedSnapshot: meta.usedSnapshot,
    segmentCount: meta.segmentCount,
  };
}
