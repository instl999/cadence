// Render scripts/scores/*.mjs transcriptions as standard SMF files under public/midi/.
// Built-in and imported MIDI files then share the same parsing pipeline.
import midiPkg from '@tonejs/midi';
const { Midi } = midiPkg;
import { readdir, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleFromLooseName } from '../src/shared/stem-roles.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'midi');
await mkdir(outDir, { recursive: true });
const includeLocalMedia = !process.argv.includes('--no-local');

// Public packages must not include developer-local songs. Only generated copies under
// public/midi are removed; original files under local-midi, local-audio, and local-stems remain untouched.
if (!includeLocalMedia) {
  await Promise.all(['local', 'audio', 'stems'].map((name) =>
    rm(join(outDir, name), { recursive: true, force: true })
  ));
}

const files = (await readdir(join(here, 'scores')))
  .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
  .sort();

const manifest = [];
for (const f of files) {
  const score = (await import(new URL(`./scores/${f}`, import.meta.url))).default;
  const midi = new Midi();
  midi.header.setTempo(score.bpm);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature: score.timeSignature }];
  midi.header.name = score.title;

  const track = midi.addTrack();
  track.name = `${score.composer} — ${score.title}`;
  track.channel = 0;
  track.instrument.number = 0; // Acoustic Grand Piano

  const ppq = midi.header.ppq; // @tonejs/midi defaults to 480 PPQ, matching the score data.
  for (const ev of score.notes) {
    track.addNote({
      midi: ev.midi,
      ticks: Math.round((ev.time * ppq) / 480),
      durationTicks: Math.max(1, Math.round((ev.dur * ppq) / 480)),
      velocity: Math.min(1, Math.max(0.05, ev.vel)),
    });
  }

  const name = `${score.id}.mid`;
  await writeFile(join(outDir, name), Buffer.from(midi.toArray()));

  const seconds = Math.max(...score.notes.map((e) => e.time + e.dur)) / 480 * (60 / score.bpm);
  manifest.push({
    file: `midi/${name}`,
    id: score.id,
    title: score.title,
    composer: score.composer,
    year: score.year,
    mood: score.mood,
    bpm: score.bpm,
    notes: score.notes.length,
    seconds: Math.round(seconds),
    builtin: true,
  });
  console.log(
    `  ${name.padEnd(30)} ${String(score.notes.length).padStart(4)} notes  ${String(Math.round(seconds)).padStart(3)}s`
  );
}

// Developer-local MIDI files are included in preview builds only.
// Drop .mid files into local-midi/ to add them to the local playlist.
const localSrc = join(here, '..', 'local-midi');
const localOut = join(outDir, 'local');
let localCount = 0;
if (includeLocalMedia) try {
  const localFiles = (await readdir(localSrc)).filter((f) => /\.midi?$/i.test(f));
  if (localFiles.length) {
    await mkdir(localOut, { recursive: true });
    for (const f of localFiles) {
      await copyFile(join(localSrc, f), join(localOut, f));
      manifest.push({
        file: 'midi/local/' + encodeURIComponent(f),
        id: 'local:' + f,
        title: f.replace(/\.midi?$/i, '').replace(/_+/g, ' '),
        composer: 'Local Library',
        builtin: false,
      });
      localCount++;
      console.log('  [local] ' + f);
    }
  }
} catch { /* Skip when local-midi/ does not exist. */ }

// Pair local audio and MIDI by the filename without its extension.
// Example Song.mp3 + Example Song.mid uses the original MIDI melody.
// Audio without MIDI falls back to key detection and a pentatonic note pool.
const audioSrc = join(here, '..', 'local-audio');
const audioOut = join(outDir, 'audio');
let audioCount = 0;
const norm = (f) => f.replace(/\.[^.]+$/, '').trim().toLowerCase();
if (includeLocalMedia) try {
  const files = (await readdir(audioSrc)).filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f));
  if (files.length) {
    await mkdir(audioOut, { recursive: true });
    for (const f of files) {
      await copyFile(join(audioSrc, f), join(audioOut, f));
      const key = norm(f);
      const mate = manifest.find((m) => !m.builtin && norm(m.id.replace(/^local:/, '')) === key);
      if (mate && mate.audio) { console.log(`  [audio] ${f}  (skipped: a preferred pair already exists)`); continue; }
      if (mate) {
        mate.audio = 'midi/audio/' + encodeURIComponent(f);
        mate.composer = 'Original Audio + MIDI Melody';
        console.log(`  [audio] ${f}  <-- paired with MIDI`);
      } else {
        manifest.push({
          file: null,
          audio: 'midi/audio/' + encodeURIComponent(f),
          id: 'audio:' + f,
          title: f.replace(/\.[^.]+$/, '').replace(/_+/g, ' '),
          composer: 'Original Audio (Pentatonic Performance Layer)',
          builtin: false,
        });
        console.log(`  [audio] ${f}  (no matching MIDI; key detection enabled)`);
      }
      audioCount++;
    }
  }
} catch { /* Skip when local-audio/ does not exist. */ }

// Separated stems from UVR or Demucs live under local-stems/<song-name>/.
// Both UVR names such as Song_(Vocals).mp3 and Demucs names such as vocals.wav are supported.
const stemsSrc = join(here, '..', 'local-stems');
const stemsOut = join(outDir, 'stems');
let stemSongs = 0;

// Role rules come from the shared table so this script cannot drift away from
// the renderer. The previous local copy tested "vocal" before "no_vocal", which
// filed every Demucs no_vocals.wav as the vocal stem and dropped the real one.
const roleOf = (f) => roleFromLooseName(f);

if (includeLocalMedia) try {
  const dirs = await readdir(stemsSrc, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    // Sort so that which file claims a role does not depend on readdir order.
    const files = (await readdir(join(stemsSrc, d.name)))
      .filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'en'));
    const stems = {};
    for (const f of files) {
      const role = roleOf(f);
      if (!role || stems[role]) continue;
      await mkdir(join(stemsOut, d.name), { recursive: true });
      await copyFile(join(stemsSrc, d.name, f), join(stemsOut, d.name, f));
      stems[role] = `midi/stems/${encodeURIComponent(d.name)}/${encodeURIComponent(f)}`;
    }
    if (!Object.keys(stems).length) continue;

    // Attach matching MIDI so vocal-silent sections can fall back to the piano melody layer.
    const mate = manifest.find((m) => !m.builtin
      && m.id.replace(/^local:/, '').replace(/\.[^.]+$/, '').trim().toLowerCase()
         === d.name.trim().toLowerCase());

    manifest.push({
      file: mate?.file ?? null,
      id: `stems:${d.name}`,
      title: d.name,
      composer: `Separated Stems — ${Object.keys(stems).join(' + ')}`,
      stems,
      builtin: false,
    });
    stemSongs++;
    console.log(`  [stems] ${d.name}  ->  ${Object.keys(stems).join(', ')}${mate ? '  (+MIDI)' : ''}`);
  }
} catch { /* Skip when local-stems/ does not exist. */ }

await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`
${manifest.length - localCount - stemSongs} built-in + ${localCount} local MIDI + ${audioCount} audio + ${stemSongs} stem groups`);
