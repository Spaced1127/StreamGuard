import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const releaseDir = path.join(root, 'release');
const chromeDir = path.join(root, 'dist', 'chrome');
const firefoxDir = path.join(root, 'dist', 'firefox');

async function readManifest(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new Error(`Missing or invalid manifest in ${directory}. Run "npm run build" first. (${error.message})`);
  }
}

async function addDirectoryToZip(zip, directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, fullPath, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, await readFile(fullPath));
    }
  }
}

async function createArchive(sourceDir, fileName, extraFiles = []) {
  const zip = new JSZip();
  await addDirectoryToZip(zip, sourceDir);
  for (const [name, contents] of extraFiles) {
    zip.file(name, contents);
  }
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });

  const destination = path.join(releaseDir, fileName);
  await writeFile(destination, buffer);
  return destination;
}

async function verifyArchive(filePath) {
  const archive = await JSZip.loadAsync(await readFile(filePath));
  for (const required of ['manifest.json', 'INSTALL.md', 'LICENSE', 'NOTICE']) {
    if (!archive.file(required)) {
      throw new Error(`${path.basename(filePath)} is missing ${required} at the archive root.`);
    }
  }
}

const chromeManifest = await readManifest(chromeDir);
const firefoxManifest = await readManifest(firefoxDir);

for (const [target, manifest] of [
  ['chrome', chromeManifest],
  ['firefox', firefoxManifest],
]) {
  if (manifest.name !== 'StreamGuard') {
    throw new Error(`dist/${target} has an unexpected extension name: ${manifest.name}`);
  }
  if (manifest.version !== version) {
    throw new Error(
      `dist/${target} is version ${manifest.version}, but package.json is ${version}. Rebuild before packaging.`,
    );
  }
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const installMarkdown = await readFile(path.join(root, 'INSTALL.md'), 'utf8');
const extraDocs = [
  ['INSTALL.md', installMarkdown],
  ['LICENSE', await readFile(path.join(root, 'LICENSE'))],
  ['NOTICE', await readFile(path.join(root, 'NOTICE'))],
];

const chromeZip = await createArchive(
  chromeDir,
  `streamguard-chrome-v${version}.zip`,
  extraDocs,
);
const firefoxXpi = await createArchive(
  firefoxDir,
  `streamguard-firefox-v${version}.xpi`,
  extraDocs,
);
await verifyArchive(chromeZip);
await verifyArchive(firefoxXpi);

const checksumLines = [];
for (const asset of [chromeZip, firefoxXpi]) {
  const hash = createHash('sha256').update(await readFile(asset)).digest('hex');
  checksumLines.push(`${hash}  ${path.basename(asset)}`);
}
await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);

const installSection = installMarkdown.replace(/^# .*\r?\n+/, '').trim();

const notes = `# StreamGuard v${version}

A local-first ad shield for Twitch live streams. Playlist stripping plus clean
backup-stream swapping, with no proxy server, account, or telemetry.

## Release artifacts

- \`streamguard-chrome-v${version}.zip\` — Chrome, Brave and Edge (unpacked)
- \`streamguard-firefox-v${version}.xpi\` — Firefox 142+ (unsigned; temporary add-on)
- \`SHA256SUMS.txt\` — SHA-256 checksums for both archives

Every archive also contains \`INSTALL.md\`, \`LICENSE\` and \`NOTICE\` at its root.

## Installation

${installSection}

## Verify downloads

\`\`\`
sha256sum -c SHA256SUMS.txt
\`\`\`

On Windows PowerShell, compare \`Get-FileHash <file> -Algorithm SHA256\` with
the values in \`SHA256SUMS.txt\`.

## Release notes

- No data collection or external servers. Requests go only to Twitch.
- Live-tested on Chromium and Firefox 159, including real stitched-ad breaks.
- 2K/4K HEVC/AV1 streams are normalized to AVC when an AVC ladder exists to
  avoid Twitch error #4000.
- Breaks where every player type is ad-laden may still fall back to stripping;
  a few CSAI ads can leak.
- VODs and clips are intentionally unsupported.

Repository: https://github.com/Spaced1127/StreamGuard
`;

await writeFile(path.join(releaseDir, 'RELEASE_NOTES.md'), notes);

console.log(`Packaged StreamGuard v${version}`);
for (const asset of [chromeZip, firefoxXpi]) {
  const info = await stat(asset);
  console.log(`  ${path.basename(asset)}  ${(info.size / 1024).toFixed(1)} KiB`);
}
console.log('  SHA256SUMS.txt');
console.log('  RELEASE_NOTES.md');
