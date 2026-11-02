import { DEFAULT_SETTINGS, type ShieldSettings } from './types';

/**
 * Firefox exposes both `browser` and a callback-compatible `chrome` namespace;
 * Chrome exposes `chrome`. Prefer `chrome` because every helper in this file
 * uses callbacks, while Firefox's `browser.*` API is Promise-only.
 */
type ExtensionApi = typeof chrome;

function resolveExtensionApi(): ExtensionApi {
  const candidate = globalThis as typeof globalThis & {
    browser?: ExtensionApi;
    chrome?: ExtensionApi;
  };
  if (candidate.chrome?.runtime?.id) return candidate.chrome;
  if (candidate.browser?.runtime?.id) return candidate.browser;
  // Tests and non-extension contexts never call these helpers with real APIs;
  // returning the (possibly undefined) global keeps module import side-effect free.
  return candidate.chrome as ExtensionApi;
}

export const ext = resolveExtensionApi();

export function getStoredSettings(): Promise<ShieldSettings> {
  return new Promise((resolve) => {
    try {
      ext.storage.local.get({ settings: DEFAULT_SETTINGS }, (items) => {
        resolve({ ...DEFAULT_SETTINGS, ...(items?.settings as Partial<ShieldSettings> | undefined) });
      });
    } catch {
      resolve({ ...DEFAULT_SETTINGS });
    }
  });
}

export function saveSettings(settings: ShieldSettings): Promise<void> {
  return new Promise((resolve) => {
    try {
      ext.storage.local.set({ settings }, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Resolves with undefined when no receiver exists (very common in Chrome). */
export function sendRuntimeMessage<T>(message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      ext.runtime.sendMessage(message, (response: T) => {
        // Read lastError so Chrome does not log "Unchecked runtime.lastError".
        void ext.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export function sendTabMessage<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      ext.tabs.sendMessage(tabId, message, (response: T) => {
        void ext.runtime.lastError;
        resolve(response);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve) => {
    try {
      ext.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
    } catch {
      resolve(undefined);
    }
  });
}

export function getManifestVersion(): string {
  try {
    return ext.runtime.getManifest().version;
  } catch {
    return '';
  }
}
