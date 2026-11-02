import type { PageRuntime, RuntimeSnapshot } from './runtime';

const OVERLAY_HTML = `
  <style>
    :host { all: initial; }
    .pill {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px 7px 9px;
      border-radius: 999px;
      background: linear-gradient(180deg, rgba(26, 19, 41, 0.95), rgba(13, 10, 20, 0.95));
      border: 1px solid rgba(185, 140, 255, 0.38);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.07);
      color: #f5f0ff;
      font: 600 12px/1.2 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: 0.01em;
      white-space: nowrap;
      backdrop-filter: blur(10px);
    }
    svg { width: 14px; height: 14px; color: #c7a4ff; flex: none; }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #b98cff;
      box-shadow: 0 0 0 0 rgba(185, 140, 255, 0.55);
      animation: ts-pulse 1.8s ease-out infinite;
      flex: none;
    }
    .label { display: block; }
    @keyframes ts-pulse {
      0% { box-shadow: 0 0 0 0 rgba(185, 140, 255, 0.5); }
      70% { box-shadow: 0 0 0 7px rgba(185, 140, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(185, 140, 255, 0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot { animation: none; }
    }
  </style>
  <div class="pill" role="status" aria-live="polite">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l7 3v5.2c0 4.5-2.9 8.1-7 9.8-4.1-1.7-7-5.3-7-9.8V6l7-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M9.4 12.2l1.8 1.8 3.5-3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
    <span class="dot"></span>
    <span class="label">Blocking ads</span>
  </div>
`;

/**
 * Small status pill over the player. Purely cosmetic: it communicates that the
 * playlist shield is active while a break is being processed.
 */
export class Overlay {
  private host: HTMLDivElement | null = null;
  private label: HTMLSpanElement | null = null;
  private ensureTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private snapshot: RuntimeSnapshot | null = null;

  constructor(private readonly runtime: PageRuntime) {}

  start(): void {
    this.unsubscribe = this.runtime.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });
    this.ensureTimer = window.setInterval(() => this.ensureHost(), 2000);
    this.ensureHost();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.ensureTimer !== null) {
      clearInterval(this.ensureTimer);
      this.ensureTimer = null;
    }
    this.host?.remove();
    this.host = null;
    this.label = null;
  }

  private ensureHost(): void {
    if (this.host?.isConnected) return;

    const player = document.querySelector<HTMLElement>('.video-player');
    if (!player) return;

    this.host = document.createElement('div');
    this.host.setAttribute('data-streamguard', 'overlay');
    this.host.style.cssText =
      'position:absolute;top:12px;left:12px;z-index:9999;pointer-events:none;display:none;';

    try {
      const shadow = this.host.attachShadow({ mode: 'open' });
      const parsed = new DOMParser().parseFromString(OVERLAY_HTML, 'text/html');
      const fragment = document.createDocumentFragment();
      for (const node of [...parsed.head.childNodes, ...parsed.body.childNodes]) {
        fragment.append(document.importNode(node, true));
      }
      shadow.append(fragment);
      this.label = shadow.querySelector<HTMLSpanElement>('.label');
    } catch {
      this.host = null;
      this.label = null;
      return;
    }

    try {
      player.appendChild(this.host);
    } catch {
      this.host = null;
      this.label = null;
    }
  }

  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    const visible =
      snapshot.settings.enabled && snapshot.settings.showOverlay && snapshot.stats.blocking;

    if (!visible) {
      if (this.host) this.host.style.display = 'none';
      return;
    }

    this.ensureHost();
    if (!this.host) return;

    this.host.style.display = 'block';
    if (this.label) {
      this.label.textContent = snapshot.settings.debug
        ? `Blocking ads · ${snapshot.stats.segmentsBlanked}`
        : 'Blocking ads';
    }
  }
}
