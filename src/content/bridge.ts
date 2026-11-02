import { ext, getStoredSettings } from '../shared/ext';
import { isWindowEnvelope, postToWindow } from '../shared/messages';
import { DEFAULT_SETTINGS, type ShieldSettings } from '../shared/types';

/**
 * Isolated-world content script.
 *
 * The MAIN-world page script cannot touch chrome.* APIs, so this bridge moves
 * settings in and stats out over a window.postMessage channel.
 */

let currentSettings: ShieldSettings = { ...DEFAULT_SETTINGS };

function sendToBackground(message: unknown): void {
  try {
    ext.runtime.sendMessage(message, () => {
      // Swallow "receiving end does not exist" while the worker restarts.
      void ext.runtime.lastError;
    });
  } catch {
    // Ignore.
  }
}

async function init(): Promise<void> {
  currentSettings = await getStoredSettings();
  postToWindow('settings', currentSettings);
}

void init();

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!isWindowEnvelope(data)) return;

  if (data.type === 'hello') {
    postToWindow('settings', currentSettings);
  } else if (data.type === 'stats' && data.payload) {
    sendToBackground({ type: 'STATS_UPDATE', stats: data.payload });
  }
});

try {
  ext.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    currentSettings = {
      ...DEFAULT_SETTINGS,
      ...((changes.settings.newValue as Partial<ShieldSettings> | undefined) ?? {}),
    };
    postToWindow('settings', currentSettings);
  });
} catch {
  // Storage events are a convenience; the initial handshake still works.
}

try {
  ext.runtime.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return;
    const type = (message as { type?: string }).type;
    if (type === 'RESET_STATS') {
      postToWindow('reset-stats');
    }
  });
} catch {
  // Ignore.
}
