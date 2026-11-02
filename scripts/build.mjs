import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;

const ALL_TARGETS = ['chrome', 'firefox'];
const requestedTargets = process.argv
  .filter((argument) => argument.startsWith('--target='))
  .map((argument) => argument.slice('--target='.length))
  .filter((target) => ALL_TARGETS.includes(target));
const targets = requestedTargets.length > 0 ? requestedTargets : ALL_TARGETS;

const ENTRIES = [
  { name: 'page', file: 'src/page/main.ts' },
  { name: 'bridge', file: 'src/content/bridge.ts' },
  { name: 'background', file: 'src/background/index.ts' },
  { name: 'popup', file: 'src/popup/main.ts' },
];

const TWITCH_MATCHES = [
  '*://www.twitch.tv/*',
  '*://twitch.tv/*',
  '*://m.twitch.tv/*',
  '*://player.twitch.tv/*',
  '*://embed.twitch.tv/*',
];

const ICONS = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};

/**
 * Bundles the player-worker runtime into a string constant. It runs inside
 * Twitch's blob worker, where extension modules and imports are unavailable, so
 * it must be fully self-contained before being embedded in page.js.
 */
function workerRuntimeAsString() {
  const virtualId = '\0virtual:worker-runtime';
  return {
    name: 'streamguard-worker-runtime',
    resolveId(id) {
      if (id === 'virtual:worker-runtime') return virtualId;
      return null;
    },
    async load(id) {
      if (id !== virtualId) return null;

      const result = await esbuild({
        absWorkingDir: root,
        entryPoints: [path.join(root, 'src/worker/runtime.ts')],
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        legalComments: 'none',
        minify: true,
      });

      const source = result.outputFiles[0]?.text;
      if (!source) throw new Error('worker runtime bundle was empty');
      return `export default ${JSON.stringify(source)};`;
    },
  };
}

function manifestFor(target) {
  const manifest = {
    manifest_version: 3,
    name: 'StreamGuard',
    version,
    description: 'A local ad shield for Twitch live streams.',
    icons: ICONS,
    action: {
      default_title: 'StreamGuard',
      default_popup: 'popup.html',
      default_icon: ICONS,
    },
    permissions: ['storage'],
    host_permissions: ['*://*.twitch.tv/*'],
    content_scripts: [
      {
        matches: TWITCH_MATCHES,
        js: ['bridge.js'],
        run_at: 'document_start',
        world: 'ISOLATED',
        all_frames: true,
      },
      {
        matches: TWITCH_MATCHES,
        js: ['page.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
    ],
  };

  if (target === 'chrome') {
    manifest.minimum_chrome_version = '111';
    manifest.background = { service_worker: 'background.js' };
  } else {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'streamguard@local',
        strict_min_version: '142.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    };
    manifest.background = { scripts: ['background.js'] };
  }

  return manifest;
}

async function bundleEntry(entry, target, outDir) {
  await viteBuild({
    root,
    configFile: false,
    logLevel: 'warn',
    define: {
      __BUILD_TARGET__: JSON.stringify(target),
      __VERSION__: JSON.stringify(version),
    },
    plugins: [workerRuntimeAsString()],
    build: {
      outDir,
      emptyOutDir: false,
      target: target === 'chrome' ? 'chrome111' : 'firefox128',
      minify: true,
      sourcemap: true,
      lib: {
        entry: path.join(root, entry.file),
        name: `${entry.name}Bundle`,
        formats: ['iife'],
        fileName: () => `${entry.name}.js`,
      },
    },
  });
}

async function buildTarget(target) {
  const outDir = path.join(root, 'dist', target);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const entry of ENTRIES) {
    process.stdout.write(`  ${target}: ${entry.name}.js\n`);
    await bundleEntry(entry, target, outDir);
  }

  await cp(path.join(root, 'src/popup/index.html'), path.join(outDir, 'popup.html'));
  await cp(path.join(root, 'src/popup/style.css'), path.join(outDir, 'style.css'));
  await cp(path.join(root, 'public/icons'), path.join(outDir, 'icons'), { recursive: true });
  await writeFile(
    path.join(outDir, 'manifest.json'),
    `${JSON.stringify(manifestFor(target), null, 2)}\n`,
    'utf8',
  );

  const pageBundle = await readFile(path.join(outDir, 'page.js'), 'utf8');
  for (const marker of [
    '__STREAMGUARD_CONFIG__',
    '__streamguardWorkerRuntimeInstalled',
    'player worker failed to start',
  ]) {
    if (!pageBundle.includes(marker)) {
      throw new Error(`page.js is missing the injected worker runtime marker: ${marker}`);
    }
  }
}

for (const target of targets) {
  process.stdout.write(`Building ${target}…\n`);
  await buildTarget(target);
  process.stdout.write(`→ dist/${target}\n`);
}

process.stdout.write('Done.\n');
