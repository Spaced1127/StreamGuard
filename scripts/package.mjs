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

async function createArchive(sourceDir, fileName) {
  const zip = new JSZip();
  await addDirectoryToZip(zip, sourceDir);
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
  if (!archive.file('manifest.json')) {
    throw new Error(`${path.basename(filePath)} does not have manifest.json at the archive root.`);
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

const chromeZip = await createArchive(chromeDir, `streamguard-chrome-v${version}.zip`);
const firefoxXpi = await createArchive(firefoxDir, `streamguard-firefox-v${version}.xpi`);
await verifyArchive(chromeZip);
await verifyArchive(firefoxXpi);

const checksumLines = [];
for (const asset of [chromeZip, firefoxXpi]) {
  const hash = createHash('sha256').update(await readFile(asset)).digest('hex');
  checksumLines.push(`${hash}  ${path.basename(asset)}`);
}
await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`);

const notes = `# StreamGuard v${version}

A local-first ad shield for Twitch live streams. Playlist stripping plus clean
backup-stream swapping, with no proxy server, account, or telemetry.

## Artifacts

- \`streamguard-chrome-v${version}.zip\` — Chrome, Brave and Edge (unpacked)
- \`streamguard-firefox-v${version}.xpi\` — Firefox 142+ (unsigned; temporary add-on)
- \`SHA256SUMS.txt\` — SHA-256 checksums for both archives

## Chrome / Brave / Edge

1. Download and unzip \`streamguard-chrome-v${version}.zip\`.
2. Open \`chrome://extensions\`, \`brave://extensions\` or \`edge://extensions\`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the unzipped folder.
5. Open a live Twitch channel.

For Brave, set **Shields down** for \`twitch.tv\` while testing, otherwise
Brave's own blocking can interfere with Twitch playback and token requests.

## Firefox 142+

The attached XPI is intentionally unsigned. Release Firefox will refuse to
install it permanently, so for now:

1. Open \`about:debugging#/runtime/this-firefox\`.
2. Choose **Load Temporary Add-on**.
3. Select \`streamguard-firefox-v${version}.xpi\`.

The add-on is removed when Firefox restarts. For permanent distribution,
submit the XPI to addons.mozilla.org for signing; see \`docs/PUBLISHING.md\`
in the repository.

## Verify downloads

\`\`\`
sha256sum -c SHA256SUMS.txt
\`\`\`

On Windows PowerShell, compare \`Get-FileHash <file> -Algorithm SHA256\` with
the values in \`SHA256SUMS.txt\`.

## Notes

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
