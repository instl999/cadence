import * as midiNS from '@tonejs/midi';
// @tonejs/midi 是 CJS，Node 与 Vite 的互操作形态不同，两边都兜住
const Midi = midiNS.Midi ?? midiNS.default?.Midi ?? midiNS.default;

/**
 * 把任意 MIDI 文件解析成「带显著度的音符流」。
 *
 * 核心思路：不生成音符，只决定「哪些音符在当前密度下该响」。
 * 每个音符算一个 salience(0..1)，密度 d 表示「保留显著度最高的 d 比例音符」。
 * d=1 是原曲，d=0.3 只剩和声骨架——但因为外声部（低音+旋律）显著度最高，
 * 骨架听起来仍然是这首曲子，不会散架。
 *
 * 这个算法对任何钢琴 MIDI 都成立，所以用户丢进文件夹的曲子走同一条路。
 */

const ONSET_WINDOW = 0.032; // 32ms 内视为同一次起音（实录的滚奏和弦音间隔常在 12~25ms）
const GROUP_SPAN_MAX = 0.05; // 一组总跨度封顶，否则密集实录会把整串跑动黏成一坨

/**
 * 从起音间隔估计速度。做法：取常见的短间隔作为候选「网格」，
 * 折算到 60~150 BPM 区间里，选支持度最高的一个。
 * 不求精确，只求让节拍权重有个大致正确的参照系。
 */
function estimateBpm(notes) {
  const onsets = [...new Set(notes.map((n) => +n.time.toFixed(3)))].sort((a, b) => a - b);
  if (onsets.length < 8) return 90;
  const gaps = [];
  for (let i = 1; i < onsets.length; i++) {
    const g = onsets[i] - onsets[i - 1];
    if (g > 0.06 && g < 2) gaps.push(g);
  }
  if (!gaps.length) return 90;
  let best = 90, bestScore = -1;
  for (let bpm = 60; bpm <= 150; bpm += 1) {
    const beat = 60 / bpm;
    let score = 0;
    for (const g of gaps) {
      // 间隔落在这个速度的 1/4、1/2、1、2 拍附近就算一票
      for (const mult of [0.25, 0.5, 1, 2]) {
        const target = beat * mult;
        if (Math.abs(g - target) < target * 0.12) { score++; break; }
      }
    }
    if (score > bestScore) { bestScore = score; best = bpm; }
  }
  return best;
}

export function parseMidi(arrayBuffer, meta = {}) {
  const midi = new Midi(arrayBuffer);

  const raw = [];
  for (const track of midi.tracks) {
    if (track.channel === 9) continue; // 跳过鼓轨
    for (const nt of track.notes) {
      raw.push({
        midi: nt.midi,
        time: nt.time,
        dur: Math.max(0.05, nt.duration),
        vel: nt.velocity || 0.7,
      });
    }
  }
  if (!raw.length) throw new Error('这个 MIDI 文件里没有音符');
  raw.sort((a, b) => a.time - b.time || a.midi - b.midi);
  // 裁到钢琴音域，越界的音在采样器上会很难听
  for (const nt of raw) nt.midi = Math.min(108, Math.max(21, nt.midi));
  const medDur = [...raw.map((n) => n.dur)].sort((a, b) => a - b)[raw.length >> 1] || 0.2;

  const hasTempo = midi.header.tempos.length > 0;
  const ts = midi.header.timeSignatures[0]?.timeSignature || [4, 4];
  // 文件没写速度时，从起音间隔直方图估一个——否则节拍权重整条失效
  const bpm = hasTempo ? midi.header.tempos[0].bpm : (meta.bpm || estimateBpm(raw));
  const beat = 60 / bpm;
  const barLen = beat * (ts[0] * (4 / ts[1]));

  // —— 1. 按起音时刻分组 ——
  const groups = [];
  for (const nt of raw) {
    const last = groups[groups.length - 1];
    if (last && nt.time - last.notes[last.notes.length - 1].time <= ONSET_WINDOW
        && nt.time - last.time <= GROUP_SPAN_MAX) last.notes.push(nt);
    else groups.push({ time: nt.time, notes: [nt] });
  }

  // —— 2. 建立「发声上下文」与「拍内天际线」——
  // 关键点：琶音/分解和弦织体里，一次起音只有一个音，
  // 光看同时起音的音会把整首曲子都判成低音线。必须看**此刻仍在响的所有音**。
  const active = [];
  for (const g of groups) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].time + active[i].dur <= g.time + 0.01) active.splice(i, 1);
    }
    const sounding = [...active, ...g.notes];
    g.lowSounding = Math.min(...sounding.map((n) => n.midi));
    g.highSounding = Math.max(...sounding.map((n) => n.midi));
    active.push(...g.notes);
  }

  // 拍内天际线：每一拍里起音的最高音是旋律骨架。
  // 这让单声部的十六分跑动也能分出「骨架音」和「经过音」。
  const winTop = new Map(), winLow = new Map();
  for (const nt of raw) {
    const w = Math.floor(nt.time / beat);
    winTop.set(w, Math.max(winTop.get(w) ?? -1, nt.midi));
    winLow.set(w, Math.min(winLow.get(w) ?? 999, nt.midi));
  }

  // —— 逐音符打分 ——
  for (const g of groups) {
    const sorted = [...g.notes].sort((a, b) => a.midi - b.midi);
    const gHi = sorted[sorted.length - 1], gLo = sorted[0];

    for (const nt of g.notes) {
      const w = Math.floor(nt.time / beat);
      // 低音线 = 既是此刻最低的发声音，也是这一拍里最低的起音。
      // 少了后半个条件，左手琶音的每个音都会被误判成低音。
      const isBass = nt.midi <= g.lowSounding + 2 && nt.midi === winLow.get(w);
      const isTop = nt.midi === winTop.get(w);

      // (a) 声部角色
      let role, layer;
      if (isBass) { role = 0.95; layer = 'bass'; }
      else if (isTop) { role = 1.0; layer = 'melody'; }
      else if (sorted.length > 1 && nt === gHi) { role = 0.8; layer = 'melody'; }
      else if (sorted.length > 1 && nt === gLo) { role = 0.7; layer = 'inner'; }
      else { role = 0.4; layer = 'inner'; }
      // 长音承担和声，不管它在织体的哪一层都得留住
      if (nt.dur >= beat * 1.5) role = Math.max(role, 0.85);

      // (b) 节拍权重：小节头 > 正拍 > 八分 > 更细的分割
      const pos = nt.time % barLen;
      const inBeats = pos / beat;
      const frac = Math.abs(inBeats - Math.round(inBeats));
      let metric;
      if (pos < 0.02) metric = 1.0;
      else if (frac < 0.06) metric = 0.75;
      else if (Math.abs(inBeats * 2 - Math.round(inBeats * 2)) < 0.06) metric = 0.5;
      else metric = 0.28;

      // (c) 时值权重：相对本曲中位时值，而不是相对一拍。
      // 实录演奏时值中位数可能只有 47ms，用绝对尺度会让所有音挤在同一档。
      const durW = Math.min(1, nt.dur / (medDur * 2.5)) * 0.7 + 0.3;

      nt.salience = 0.55 * role + 0.25 * metric + 0.2 * durW;
      nt.layer = layer;
    }
  }

  // —— 3. 百分位归一化 ——
  // 这一步让「密度 0.4」在任何曲子上都表示同一件事：保留最重要的 40% 音符。
  // 没有它，织体厚的曲子和单声部曲子对同一个 d 反应会完全不同。
  const bySal = [...raw].sort((a, b) => a.salience - b.salience);
  bySal.forEach((nt, i) => { nt.rank = i / (bySal.length - 1 || 1); });

  // 每小节保底：把该小节最显著的那个音钉成 rank=1。
  // 没有这一步，低密度下会出现整小节静音——听感上是「卡带」，比稀疏难受得多。
  const perBar = new Map();
  for (const nt of raw) {
    const b = Math.floor(nt.time / barLen);
    const cur = perBar.get(b);
    if (!cur || nt.salience > cur.salience) perBar.set(b, nt);
  }
  for (const nt of perBar.values()) nt.rank = 1;

  const duration = Math.max(...raw.map((n) => n.time + n.dur));

  return {
    ...meta,
    bpm, timeSignature: ts, beat, barLen, duration,
    estimatedBpm: !hasTempo,
    notes: raw,
    groups,
    noteCount: raw.length,
  };
}

/**
 * 密度门控：d=1 全放，d 越小保留越少。
 * 保底规则——任何一个小节都不会被削成完全静音。
 */
export function gate(piece, d) {
  const keep = piece.notes.filter((n) => n.rank >= 1 - d);
  if (keep.length) return keep;
  return [piece.notes.reduce((a, b) => (a.rank > b.rank ? a : b))];
}
