import { access, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Song folders that belong in a public package.
 *
 * Copying all of "Music Resources" would put whatever the developer has been
 * testing with into the release directory, which contradicts the guarantee in
 * README.md that package:win excludes developer-local songs. This list mirrors
 * the .gitignore allow-list, so the package ships exactly what source control
 * ships. Anything else is reported and skipped.
 */
const RELEASE_SONG_FOLDERS = ['Sample Song'];

const LEGACY_MUSIC_RESOURCE_NAME = '\u97f3\u4e50\u8d44\u6e90';
const musicSource = resolve('Music Resources');
const docsSource = resolve('docs');
const readmeSource = resolve('README.md');
const targets = [
  resolve('release'),
  resolve('release', 'win-unpacked'),
];

await Promise.all([stat(musicSource), stat(docsSource), stat(readmeSource)]);
for (const releaseRoot of targets) {
  const musicTarget = resolve(releaseRoot, 'Music Resources');
  const legacyMusicTarget = resolve(releaseRoot, LEGACY_MUSIC_RESOURCE_NAME);
  let targetExists = true;
  try {
    await access(musicTarget);
  } catch {
    targetExists = false;
  }
  if (!targetExists) {
    try {
      await rename(legacyMusicTarget, musicTarget);
    } catch {
      // No legacy resource directory is present in a fresh release.
    }
  }
  await mkdir(musicTarget, { recursive: true });
  // Copy only the allow-listed example folders, never the whole resource tree.
  for (const folder of RELEASE_SONG_FOLDERS) {
    const from = resolve(musicSource, folder);
    try {
      await stat(from);
    } catch {
      console.warn(`  [music-resource] example folder missing, skipped: ${folder}`);
      continue;
    }
    await cp(from, resolve(musicTarget, folder), { recursive: true, force: true });
  }

  // Say plainly what was left behind, and flag anything already sitting in the
  // release directory that this script did not put there.
  const skipped = (await readdir(musicSource, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !RELEASE_SONG_FOLDERS.includes(entry.name))
    .map((entry) => entry.name);
  if (skipped.length) {
    console.log(`  [music-resource] excluded ${skipped.length} local song folder(s): ${skipped.join(', ')}`);
  }
  const stale = (await readdir(musicTarget, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !RELEASE_SONG_FOLDERS.includes(entry.name))
    .map((entry) => entry.name);
  if (stale.length) {
    console.warn(`  [music-resource] WARNING: ${musicTarget} still contains ${stale.join(', ')}.`);
    console.warn('  [music-resource] Delete release/ and package again before publishing.');
  }

  const docsTarget = resolve(releaseRoot, 'docs');
  await rm(docsTarget, { recursive: true, force: true });
  await cp(docsSource, docsTarget, { recursive: true, force: true });
  await cp(readmeSource, resolve(releaseRoot, 'README.md'), { force: true });
  console.log(`  [music-resource] ${musicTarget}`);
  console.log(`  [documentation] ${resolve(releaseRoot, 'docs')}`);
}

// electron-builder diagnostics may contain absolute local paths and are not
// distribution artifacts, so remove them from the release directory.
await Promise.all([
  rm(resolve('release', 'builder-debug.yml'), { force: true }),
  rm(resolve('release', 'builder-effective-config.yaml'), { force: true }),
]);
