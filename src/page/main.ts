import { isWindowEnvelope, postToWindow } from '../shared/messages';
import type { ShieldSettings } from '../shared/types';
import { AdVideoHider } from './ad-videos';
import { installPageFetchHook } from './fetch-hook';
import { Overlay } from './overlay';
import { PageRuntime } from './runtime';
import { installWorkerHook } from './worker-hook';

declare global {
  interface Window {
    __twitchShieldInstalled?: boolean;
  }
}

/** Live channel and embed pages only. VOD/clip playlists must not be touched. */
function shouldRunHere(): boolean {
  try {
    const host = location.hostname;
    const path = location.pathname;

    if (host === 'clips.twitch.tv') return false;
    if (/\/clip\//.test(path) || path.startsWith('/videos/')) return false;

    const knownHost =
      host === 'www.twitch.tv' ||
      host === 'twitch.tv' ||
      host === 'm.twitch.tv' ||
      host === 'player.twitch.tv' ||
      host === 'embed.twitch.tv';
    if (!knownHost) return false;

    // Suppress duplicate hook instances in Twitch's auxiliary same-origin
    // iframes, while still supporting the two documented embed contexts.
    if (window.top !== window) {
      const isEmbedContext =
        host === 'player.twitch.tv' || host === 'embed.twitch.tv' || path.startsWith('/embed/');
      if (!isEmbedContext) return false;
    }

    return true;
  } catch {
    return false;
  }
}

function boot(): void {
  if (window.__twitchShieldInstalled || !shouldRunHere()) return;
  window.__twitchShieldInstalled = true;

  const runtime = new PageRuntime();
  installPageFetchHook(runtime);
  installWorkerHook(runtime);

  const overlay = new Overlay(runtime);
  overlay.start();

  const adVideos = new AdVideoHider(runtime);
  adVideos.start();

  runtime.start();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!isWindowEnvelope(data)) return;

    if (data.type === 'settings' && data.payload && typeof data.payload === 'object') {
      runtime.updateSettings(data.payload as Partial<ShieldSettings>);
    } else if (data.type === 'reset-stats') {
      runtime.resetStats();
    }
  });

  postToWindow('hello');
}

try {
  boot();
} catch (error) {
  try {
    console.error('[TwitchShield] failed to initialize', error);
  } catch {
    // Ignore.
  }
}
