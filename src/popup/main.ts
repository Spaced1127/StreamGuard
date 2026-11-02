import {
  getActiveTab,
  getManifestVersion,
  getStoredSettings,
  saveSettings,
  sendRuntimeMessage,
} from '../shared/ext';
import {
  DEFAULT_SETTINGS,
  emptyTabStats,
  type ShieldSettings,
  type TabStats,
} from '../shared/types';

const SETTING_KEYS = [
  'backupStream',
  'hideSideAds',
  'showOverlay',
  'rewriteTrackingUrls',
  'debug',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

let settings: ShieldSettings = { ...DEFAULT_SETTINGS };
let stats: TabStats = emptyTabStats();
let tabId: number | null = null;
let isTwitchTab = false;
let pollTimer: number | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function isTwitchPage(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (!/(^|\.)twitch\.tv$/i.test(url.hostname)) return false;
    if (url.pathname.startsWith('/videos/')) return false;
    if (/\/clip\//.test(url.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

function renderPower(): void {
  const power = el<HTMLButtonElement>('power');
  power.setAttribute('aria-checked', String(settings.enabled));
  power.title = settings.enabled ? 'Pause ad shield' : 'Enable ad shield';
}

function renderSettings(): void {
  for (const key of SETTING_KEYS) {
    el<HTMLInputElement>(key).checked = settings[key];
  }
}

function renderStatus(): void {
  const dot = el<HTMLSpanElement>('status-dot');
  const label = el<HTMLSpanElement>('status-label');
  const detail = el<HTMLParagraphElement>('status-detail');
  const channel = el<HTMLSpanElement>('channel');

  dot.className = 'status-dot';
  channel.textContent = stats.channel ? `#${stats.channel}` : '';

  if (!settings.enabled) {
    dot.classList.add('off');
    label.textContent = 'Shield paused';
    detail.textContent = 'Ads will play normally on this tab.';
  } else if (!isTwitchTab) {
    dot.classList.add('off');
    label.textContent = 'Not a Twitch tab';
    detail.textContent = 'Open a live Twitch channel to use the shield.';
  } else if (stats.blocking) {
    dot.classList.add('live');
    label.textContent = 'Blocking ads';
    detail.textContent = stats.channel
      ? `Neutralizing ad segments on ${stats.channel}.`
      : 'Neutralizing ad segments…';
  } else if (stats.updatedAt > 0) {
    dot.classList.add('ok');
    label.textContent = 'Shield active';
    if (stats.breaksBlocked > 0) {
      const noun = stats.breaksBlocked === 1 ? 'break' : 'breaks';
      detail.textContent = `${stats.breaksBlocked} ad ${noun} handled this session.`;
    } else if (stats.channel) {
      detail.textContent = `Watching ${stats.channel} — no ads right now.`;
    } else {
      detail.textContent = 'Watching Twitch — no ads right now.';
    }
  } else {
    dot.classList.add('ok');
    label.textContent = 'Shield active';
    detail.textContent = 'Connecting to the player…';
  }

  el<HTMLSpanElement>('stat-breaks').textContent = String(stats.breaksBlocked);
  el<HTMLSpanElement>('stat-segments').textContent = String(stats.segmentsBlanked);
  el<HTMLSpanElement>('stat-sideads').textContent = String(stats.sideAdsHidden);
  el<HTMLSpanElement>('stat-backups').textContent = String(stats.backupsUsed);
  el<HTMLSpanElement>('stat-csai').textContent = String(stats.csaiRequests);
}

function renderAll(): void {
  renderPower();
  renderSettings();
  renderStatus();
}

async function refreshStats(): Promise<void> {
  if (tabId === null) return;
  const response = await sendRuntimeMessage<{ stats: TabStats }>({
    type: 'GET_TAB_STATS',
    tabId,
  });
  if (!response?.stats) return;

  stats = { ...emptyTabStats(), ...response.stats, enabled: settings.enabled };
  renderStatus();
}

async function updateSetting(key: SettingKey, value: boolean): Promise<void> {
  settings = { ...settings, [key]: value };
  renderAll();
  await saveSettings(settings);
}

async function togglePower(): Promise<void> {
  settings = { ...settings, enabled: !settings.enabled };
  renderAll();
  await saveSettings(settings);
}

async function resetSession(): Promise<void> {
  if (tabId === null) return;
  await sendRuntimeMessage({ type: 'RESET_TAB_STATS', tabId });
  stats = {
    ...emptyTabStats(),
    channel: stats.channel,
    enabled: settings.enabled,
    updatedAt: Date.now(),
  };
  renderStatus();
}

async function init(): Promise<void> {
  el<HTMLButtonElement>('power').addEventListener('click', () => void togglePower());
  el<HTMLButtonElement>('reset').addEventListener('click', () => void resetSession());

  for (const key of SETTING_KEYS) {
    el<HTMLInputElement>(key).addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      void updateSetting(key, input.checked);
    });
  }

  settings = await getStoredSettings();

  const tab = await getActiveTab();
  tabId = tab?.id ?? null;
  isTwitchTab = isTwitchPage(tab?.url);

  renderAll();
  el<HTMLSpanElement>('version').textContent = `v${getManifestVersion()}`;

  await refreshStats();
  pollTimer = window.setInterval(() => void refreshStats(), 1000);
}

window.addEventListener('unload', () => {
  if (pollTimer !== null) clearInterval(pollTimer);
});

void init();
