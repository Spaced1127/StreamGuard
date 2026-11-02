import type { PageRuntime } from './runtime';

const AD_VIDEO_SRC_RE = /media-amazon\.com|amazon-adsystem\.com|(?:edge\.)?ads\.twitch\.tv/i;

interface OriginalVideoState {
  display: string;
  muted: boolean;
  mutedByUs: boolean;
}

/**
 * Since roughly July 2026 Twitch renders standalone video ads beside the
 * player and inside chat. They are not part of the HLS playlist, so neither
 * segment blanking nor backup swapping touches them. They are hosted on
 * Amazon's ad CDN, which the primary player never uses (it plays a blob: URL),
 * making the CDN match safe.
 */
export class AdVideoHider {
  private readonly originals = new WeakMap<HTMLVideoElement, OriginalVideoState>();
  private readonly counted = new WeakSet<HTMLVideoElement>();
  private timer: number | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly runtime: PageRuntime) {}

  start(): void {
    this.timer = window.setInterval(() => this.scan(), 1000);
    this.unsubscribe = this.runtime.subscribe((snapshot) => {
      if (snapshot.settings.hideSideAds && snapshot.stats.blocking) this.scan();
    });
    this.scan();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const video of document.querySelectorAll<HTMLVideoElement>(
      'video[data-streamguard-hidden="1"]',
    )) {
      this.restore(video);
    }
  }

  private scan(): void {
    const snapshot = this.runtime.getSnapshot();
    const enabled = snapshot.settings.enabled && snapshot.settings.hideSideAds;

    for (const video of document.querySelectorAll<HTMLVideoElement>('video')) {
      if (!enabled) {
        if (video.dataset.streamguardHidden === '1') this.restore(video);
        continue;
      }

      const source =
        video.currentSrc ||
        video.src ||
        video.querySelector<HTMLSourceElement>('source')?.src ||
        '';

      // The live player is a MediaSource blob; never touch it.
      if (!source || source.startsWith('blob:')) {
        if (video.dataset.streamguardHidden === '1' && !AD_VIDEO_SRC_RE.test(source)) {
          this.restore(video);
        }
        continue;
      }

      if (!AD_VIDEO_SRC_RE.test(source)) {
        if (video.dataset.streamguardHidden === '1') this.restore(video);
        continue;
      }

      if (video.dataset.streamguardHidden === '1') continue;

      const original: OriginalVideoState = {
        display: video.style.display,
        muted: video.muted,
        mutedByUs: false,
      };

      try {
        video.pause();
      } catch {
        // Ignore.
      }

      if (!video.muted) {
        video.muted = true;
        original.mutedByUs = true;
      }

      video.style.setProperty('display', 'none', 'important');
      video.dataset.streamguardHidden = '1';
      this.originals.set(video, original);

      if (!this.counted.has(video)) {
        this.counted.add(video);
        this.runtime.noteSideAdsHidden(1);
      }
    }
  }

  private restore(video: HTMLVideoElement): void {
    const original = this.originals.get(video);
    if (original) {
      if (original.display) video.style.display = original.display;
      else video.style.removeProperty('display');
      if (original.mutedByUs) video.muted = original.muted;
      this.originals.delete(video);
    }
    delete video.dataset.streamguardHidden;
  }
}
