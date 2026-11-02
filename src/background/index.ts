import { ext } from '../shared/ext';
import { DEFAULT_SETTINGS, emptyTabStats, type TabStats } from '../shared/types';

/**
 * MV3 service worker (Chrome) / event page (Firefox).
 * Keeps a small in-memory stats table per tab and drives the toolbar badge.
 */

const statsByTab = new Map<number, TabStats>();
const STATS_STORAGE_KEY = 'tabStats';
let hydration: Promise<void> | null = null;

function hydrateStats(): Promise<void> {
  if (hydration) return hydration;

  hydration = new Promise((resolve) => {
    try {
      ext.storage.session.get(STATS_STORAGE_KEY, (items) => {
        const stored = items?.[STATS_STORAGE_KEY] as Record<string, unknown> | undefined;
        if (stored) {
          for (const [key, value] of Object.entries(stored)) {
            const tabId = Number(key);
            const stats = normalizeStats(value);
            if (Number.isFinite(tabId) && stats) statsByTab.set(tabId, stats);
          }
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });

  return hydration;
}

function persistStats(): void {
  try {
    const record: Record<string, TabStats> = {};
    for (const [tabId, stats] of statsByTab) record[String(tabId)] = stats;
    ext.storage.session.set({ [STATS_STORAGE_KEY]: record }, () => {
      void ext.runtime.lastError;
    });
  } catch {
    // storage.session is optional on older engines; in-memory stats still work.
  }
}

void hydrateStats();

function actionApi(): typeof chrome.action | undefined {
  const api = ext as typeof chrome & { browserAction?: typeof chrome.action };
  return api.action ?? api.browserAction;
}

function normalizeStats(input: unknown): TabStats | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = input as Partial<TabStats>;

  const count = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.max(0, Math.floor(candidate))
      : 0;

  return {
    channel: typeof value.channel === 'string' ? value.channel.slice(0, 64) : null,
    enabled: value.enabled !== false,
    blocking: value.blocking === true,
    breaksBlocked: count(value.breaksBlocked),
    segmentsBlanked: count(value.segmentsBlanked),
    backupsUsed: count(value.backupsUsed),
    sideAdsHidden: count(value.sideAdsHidden),
    csaiRequests: count(value.csaiRequests),
    updatedAt: count(value.updatedAt) || Date.now(),
  };
}

function badgeText(stats: TabStats | undefined): string {
  if (!stats) return '';
  if (!stats.enabled) return 'OFF';
  if (stats.blocking) return 'AD';
  if (stats.breaksBlocked > 0) return String(Math.min(stats.breaksBlocked, 999));
  return '';
}

function renderBadge(tabId: number, stats: TabStats | undefined): void {
  const action = actionApi();
  if (!action) return;

  try {
    action.setBadgeText({ tabId, text: badgeText(stats) });
    action.setBadgeBackgroundColor({
      tabId,
      color: !stats?.enabled ? '#5d5868' : stats.blocking ? '#9147ff' : '#3b3450',
    });
    action.setTitle({
      tabId,
      title: !stats
        ? 'Twitch Shield'
        : !stats.enabled
          ? 'Twitch Shield — paused'
          : stats.blocking
            ? `Twitch Shield — blocking ads${stats.channel ? ` on ${stats.channel}` : ''}`
            : `Twitch Shield — active${stats.channel ? ` on ${stats.channel}` : ''}`,
    });
  } catch {
    // The tab may have closed between the event and this call.
  }
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: string }).type;

  if (type === 'STATS_UPDATE') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) return false;

    const stats = normalizeStats((message as { stats?: unknown }).stats);
    if (!stats) return false;

    statsByTab.set(tabId, stats);
    persistStats();
    renderBadge(tabId, stats);
    sendResponse({ ok: true });
    return false;
  }

  if (type === 'GET_TAB_STATS') {
    const tabId = (message as { tabId?: number }).tabId;
    void hydrateStats().then(() => {
      const stats = typeof tabId === 'number' ? statsByTab.get(tabId) : undefined;
      sendResponse({ stats: stats ?? emptyTabStats() });
    });
    return true;
  }

  if (type === 'RESET_TAB_STATS') {
    const tabId = (message as { tabId?: number }).tabId;
    if (typeof tabId !== 'number') {
      sendResponse({ ok: false });
      return false;
    }

    statsByTab.delete(tabId);
    persistStats();
    renderBadge(tabId, undefined);

    try {
      ext.tabs.sendMessage(tabId, { type: 'RESET_STATS' }, () => {
        void ext.runtime.lastError;
      });
    } catch {
      // The tab may not have our content script (e.g. an extension page).
    }

    sendResponse({ ok: true });
    return false;
  }

  return false;
});

ext.tabs.onRemoved.addListener((tabId) => {
  statsByTab.delete(tabId);
  persistStats();
});

ext.runtime.onInstalled.addListener(() => {
  try {
    ext.storage.local.get('settings', (items) => {
      if (!items.settings) ext.storage.local.set({ settings: DEFAULT_SETTINGS });
    });
  } catch {
    // Ignore.
  }
});
