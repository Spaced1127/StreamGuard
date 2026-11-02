import workerRuntimeSource from 'virtual:worker-runtime';
import { isWorkerMessage } from '../shared/messages';
import type { TokenRequestPayload, WorkerConfig } from '../shared/types';
import type { PageRuntime } from './runtime';

const hookedBlobUrls = new Set<string>();
const activeWorkers = new Set<Worker>();

function isTwitchWorkerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl, location.href);
    const origin = url.origin;
    if (!origin || origin === 'null') {
      // Older engines do not resolve blob: URL origins; inspect the embedded URL.
      if (!url.protocol.startsWith('blob:')) return false;
      const inner = new URL(url.pathname);
      return inner.hostname === 'twitch.tv' || inner.hostname.endsWith('.twitch.tv');
    }
    const host = new URL(origin).hostname;
    return host === 'twitch.tv' || host.endsWith('.twitch.tv');
  } catch {
    return false;
  }
}

function fetchWorkerSourceSync(url: string): string | null {
  try {
    const request = new XMLHttpRequest();
    request.open('GET', url, false);
    request.overrideMimeType('text/javascript');
    request.send();
    return request.responseText || null;
  } catch {
    return null;
  }
}

function buildWorkerSource(twitchSource: string, config: WorkerConfig): string {
  return [
    `var __TWITCH_SHIELD_CONFIG__ = ${JSON.stringify(config)};`,
    workerRuntimeSource,
    // Twitch's player is a classic worker script. A direct top-level eval keeps
    // its var/function declarations in global scope, exactly as the original
    // blob would.
    `try { eval(${JSON.stringify(twitchSource)}); } catch (error) { try { console.error('[TwitchShield] player worker failed to start', error); } catch (_) {} }`,
  ].join('\n;\n');
}

/**
 * Twitch's live player runs in a blob worker. We cannot modify network
 * responses from an extension in MV3, so the worker's script is fetched
 * synchronously, wrapped with our runtime, and launched from a new blob.
 */
export function installWorkerHook(runtime: PageRuntime): void {
  const NativeWorker = window.Worker;
  if (!NativeWorker) return;

  const existing = NativeWorker as typeof Worker & { __twitchShieldPatched?: boolean };
  if (existing.__twitchShieldPatched) return;

  class ShieldWorker extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      let target: string | URL = url;
      let didHook = false;

      try {
        const href = typeof url === 'string' ? url : url.href;
        if (options?.type !== 'module' && isTwitchWorkerUrl(href)) {
          const source = fetchWorkerSourceSync(href);
          if (source && !source.includes('__twitchShieldWorkerRuntimeInstalled')) {
            const blob = new Blob([buildWorkerSource(source, runtime.getWorkerConfig())], {
              type: 'application/javascript',
            });
            const blobUrl = URL.createObjectURL(blob);

            // Preserve the previous worker's script until it has loaded, but
            // release our earlier blobs so channel-hopping does not leak.
            for (const oldUrl of hookedBlobUrls) {
              try {
                URL.revokeObjectURL(oldUrl);
              } catch {
                // Ignore.
              }
            }
            hookedBlobUrls.clear();
            hookedBlobUrls.add(blobUrl);

            target = blobUrl;
            didHook = true;
          }
        }
      } catch (error) {
        runtime.log('could not patch worker', error);
      }

      super(target as string, options);

      if (didHook) {
        activeWorkers.add(this);
        this.addEventListener('message', (event) => {
          const data = event.data;
          if (!isWorkerMessage(data)) return;

          if (data.kind === 'token-request') {
            const request = data.payload as TokenRequestPayload;
            if (!request?.id || !request.channel) return;

            void runtime.getPlaybackToken(request.channel, request.playerType).then((token) => {
              try {
                this.postMessage({ __twitchShieldTokenResponse: 1, id: request.id, token });
              } catch {
                // Worker may have been terminated between request and reply.
              }
            });
            return;
          }

          runtime.handleWorkerMessage(data);
        });
        this.addEventListener('error', () => activeWorkers.delete(this));
        runtime.log('patched Twitch player worker');
      }
    }
  }

  // Keep casual feature detection (Worker.name / Worker.toString) looking native.
  try {
    Object.defineProperty(ShieldWorker, 'name', { value: 'Worker' });
    Object.defineProperty(ShieldWorker, 'toString', {
      value: () => Function.prototype.toString.call(NativeWorker),
      configurable: true,
    });
  } catch {
    // Non-fatal.
  }

  (ShieldWorker as typeof Worker & { __twitchShieldPatched?: boolean }).__twitchShieldPatched =
    true;

  try {
    Object.defineProperty(window, 'Worker', {
      value: ShieldWorker,
      writable: true,
      configurable: true,
    });
  } catch {
    window.Worker = ShieldWorker;
  }

  runtime.onSettingsChange((config) => {
    for (const worker of activeWorkers) {
      try {
        worker.postMessage({ __twitchShieldConfig: 1, config });
      } catch {
        activeWorkers.delete(worker);
      }
    }
  });
}
