// 把 scripts/scores/*.mjs 的转录数据渲染成标准 SMF 文件写进 public/midi/，
// 并生成 manifest.json。内置曲目和用户导入的 MIDI 之后走完全相同的解析管线。
import midiPkg from '@tonejs/midi';
const { Midi } = midiPkg;
import { readdir, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'midi');
await mkdir(outDir, { recursive: true });
const includeLocalMedia = !process.argv.includes('--no-local');

// 公开发布不能捆入开发者的本地歌曲。这里只删除 public/midi 下的生成副本，
// 不会触碰 local-midi、local-audio 或 local-stems 中的原始文件。
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

  const ppq = midi.header.ppq; // @tonejs/midi 默认 480，与乐谱一致
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

// —— 用户自己的曲子 ——
// 把 .mid 丢进 local-midi/ 就会被自动收进播放列表。
// 这个目录在 .gitignore 里，不进版本库、不参与分发。
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
        composer: '本地曲库',
        builtin: false,
      });
      localCount++;
      console.log('  [local] ' + f);
    }
  }
} catch { /* local-midi/ 不存在就跳过 */ }

// —— 原曲音频 ——
// local-audio/ 里的音频文件按「文件名去扩展名」和 local-midi/ 配对：
//   local-audio/Example Song.mp3 + local-midi/Example Song.mid  -> 击键弹出原曲真正的旋律音
//   只有音频没有 MIDI                                -> 退回到调性检测 + 五声音阶
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
      if (mate && mate.audio) { console.log(`  [audio] ${f}  (跳过：已有更优格式配对)`); continue; }
      if (mate) {
        mate.audio = 'midi/audio/' + encodeURIComponent(f);
        mate.composer = '原曲 + MIDI 旋律';
        console.log(`  [audio] ${f}  <-- 已配对 MIDI`);
      } else {
        manifest.push({
          file: null,
          audio: 'midi/audio/' + encodeURIComponent(f),
          id: 'audio:' + f,
          title: f.replace(/\.[^.]+$/, '').replace(/_+/g, ' '),
          composer: '原曲（五声音阶演奏层）',
          builtin: false,
        });
        console.log(`  [audio] ${f}  (无配套 MIDI，将走调性检测)`);
      }
      audioCount++;
    }
  }
} catch { /* local-audio/ 不存在就跳过 */ }

// —— 分离音轨 (UVR / Demucs 输出) ——
// local-stems/<歌名>/ 下放分好的轨，按文件名关键词识别角色。
// 兼容 UVR 的 "Song_(Vocals).mp3" 和 Demucs 的 "vocals.wav" 两种命名。
const stemsSrc = join(here, '..', 'local-stems');
const stemsOut = join(outDir, 'stems');
let stemSongs = 0;

const ROLE = [
  [/(vocal|人声|lead.?vox|\bvox\b)/i, 'vocals'],
  [/(instrument|accompan|伴奏|no.?vocal|karaoke|backing)/i, 'instrumental'],
  [/(drum|鼓)/i, 'drums'],
  [/(bass|贝斯|低音)/i, 'bass'],
  [/(other|piano|guitar|其他)/i, 'other'],
];
const roleOf = (f) => (ROLE.find(([re]) => re.test(f)) || [, null])[1];

if (includeLocalMedia) try {
  const dirs = await readdir(stemsSrc, { withFileTypes: true });
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const files = (await readdir(join(stemsSrc, d.name)))
      .filter((f) => /\.(mp3|m4a|wav|ogg|flac)$/i.test(f));
    const stems = {};
    for (const f of files) {
      const role = roleOf(f);
      if (!role || stems[role]) continue;
      await mkdir(join(stemsOut, d.name), { recursive: true });
      await copyFile(join(stemsSrc, d.name, f), join(stemsOut, d.name, f));
      stems[role] = `midi/stems/${encodeURIComponent(d.name)}/${encodeURIComponent(f)}`;
    }
    if (!Object.keys(stems).length) continue;

    // 同名 MIDI 也一并挂上：人声静音的段落可以退回钢琴旋律层
    const mate = manifest.find((m) => !m.builtin
      && m.id.replace(/^local:/, '').replace(/\.[^.]+$/, '').trim().toLowerCase()
         === d.name.trim().toLowerCase());

    manifest.push({
      file: mate?.file ?? null,
      id: `stems:${d.name}`,
      title: d.name,
      composer: `分离音轨 · ${Object.keys(stems).join(' + ')}`,
      stems,
      builtin: false,
    });
    stemSongs++;
    console.log(`  [stems] ${d.name}  ->  ${Object.keys(stems).join(', ')}${mate ? '  (+MIDI)' : ''}`);
  }
} catch { /* local-stems/ 不存在就跳过 */ }

await writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`
${manifest.length - localCount - stemSongs} 首内置 + ${localCount} 首本地 MIDI + ${audioCount} 个音频 + ${stemSongs} 组分离音轨`);
