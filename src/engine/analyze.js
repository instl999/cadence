import * as midiNS from '@tonejs/midi';
// @tonejs/midi is CommonJS; support both Node and Vite interop shapes.
const Midi = midiNS.Midi ?? midiNS.default?.Midi ?? midiNS.default;

/**
 * Parse any MIDI file into a note stream with salience scores.
 *
 * The algorithm does not invent notes; it decides which existing notes should
 * sound at the current density. Each note receives salience in the 0..1 range,
 * and density d keeps the highest-ranked fraction. At d=0.3, the prominent
 * bass and melody preserve the song's harmonic skeleton.
 *
 * The same process works for any piano MIDI imported by the user.
 */

const ONSET_WINDOW = 0.032; // Treat onsets within 32 ms as one group.
const GROUP_SPAN_MAX = 0.05; // Prevent dense performances from merging long runs.

/**
 * Estimate tempo from onset gaps. Map common short intervals into the 60-150
 * BPM range and choose the best-supported candidate. Approximate timing is
 * sufficient for metric weighting.
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
      // Count gaps near a quarter, half, one, or two beats at this tempo.
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
    if (track.channel === 9) continue; // Skip the percussion channel.
    for (const nt of track.notes) {
      raw.push({
        midi: nt.midi,
        time: nt.time,
        dur: Math.max(0.05, nt.duration),
        vel: nt.velocity || 0.7,
      });
    }
  }
  if (!raw.length) throw new Error('This MIDI file contains no notes');
  raw.sort((a, b) => a.time - b.time || a.midi - b.midi);
  // Clamp notes to the piano range supported by the sampler.
  for (const nt of raw) nt.midi = Math.min(108, Math.max(21, nt.midi));
  const medDur = raw.map((n) => n.dur).sort((a, b) => a - b)[raw.length >> 1] || 0.2;

  const hasTempo = midi.header.tempos.length > 0;
  const ts = midi.header.timeSignatures[0]?.timeSignature || [4, 4];
  // Estimate tempo when metadata is missing so metric weighting remains useful.
  const bpm = hasTempo ? midi.header.tempos[0].bpm : (meta.bpm || estimateBpm(raw));
  const beat = 60 / bpm;
  const barLen = beat * (ts[0] * (4 / ts[1]));

  // 1. Group notes by onset time.
  const groups = [];
  for (const nt of raw) {
    const last = groups[groups.length - 1];
    if (last && nt.time - last.notes[last.notes.length - 1].time <= ONSET_WINDOW
        && nt.time - last.time <= GROUP_SPAN_MAX) last.notes.push(nt);
    else groups.push({ time: nt.time, notes: [nt] });
  }

  // 2. Build sounding context and an in-beat pitch skyline.
  // Arpeggios may contain only one onset at a time, so role detection must also
  // consider notes that are still sounding.
  const active = [];
  for (const g of groups) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].time + active[i].dur <= g.time + 0.01) active.splice(i, 1);
    }
    // Scan for the extremes instead of spreading into Math.min/Math.max. Spread
    // throws RangeError past roughly 125k arguments, which a dense orchestral
    // score reaches, and it allocated two throwaway arrays per group besides.
    let low = Infinity;
    let high = -Infinity;
    for (const nt of active) {
      if (nt.midi < low) low = nt.midi;
      if (nt.midi > high) high = nt.midi;
    }
    for (const nt of g.notes) {
      if (nt.midi < low) low = nt.midi;
      if (nt.midi > high) high = nt.midi;
      active.push(nt);
    }
    g.lowSounding = low;
    g.highSounding = high;
  }

  // The highest onset in each beat forms a melodic skyline, which separates
  // structural notes from passing notes in single-voice runs.
  const winTop = new Map(), winLow = new Map();
  for (const nt of raw) {
    const w = Math.floor(nt.time / beat);
    winTop.set(w, Math.max(winTop.get(w) ?? -1, nt.midi));
    winLow.set(w, Math.min(winLow.get(w) ?? 999, nt.midi));
  }

  // Score each note.
  for (const g of groups) {
    // Only the extremes are needed, so scan for them rather than sorting a copy
    // of every group. On ties this keeps the same notes a stable sort would pick.
    let gHi = g.notes[0];
    let gLo = g.notes[0];
    for (const nt of g.notes) {
      if (nt.midi >= gHi.midi) gHi = nt;
      if (nt.midi < gLo.midi) gLo = nt;
    }
    const polyphonic = g.notes.length > 1;

    for (const nt of g.notes) {
      const w = Math.floor(nt.time / beat);
      // A bass note must be both the lowest sounding pitch and the lowest onset
      // in its beat; otherwise every note in a left-hand arpeggio looks like bass.
      const isBass = nt.midi <= g.lowSounding + 2 && nt.midi === winLow.get(w);
      const isTop = nt.midi === winTop.get(w);

      // (a) Voice role.
      let role, layer;
      if (isBass) { role = 0.95; layer = 'bass'; }
      else if (isTop) { role = 1.0; layer = 'melody'; }
      else if (polyphonic && nt === gHi) { role = 0.8; layer = 'melody'; }
      else if (polyphonic && nt === gLo) { role = 0.7; layer = 'inner'; }
      else { role = 0.4; layer = 'inner'; }
      // Sustained notes carry harmony regardless of their texture layer.
      if (nt.dur >= beat * 1.5) role = Math.max(role, 0.85);

      // (b) Metric weight: bar start, beat, eighth note, then finer divisions.
      const pos = nt.time % barLen;
      const inBeats = pos / beat;
      const frac = Math.abs(inBeats - Math.round(inBeats));
      let metric;
      if (pos < 0.02) metric = 1.0;
      else if (frac < 0.06) metric = 0.75;
      else if (Math.abs(inBeats * 2 - Math.round(inBeats * 2)) < 0.06) metric = 0.5;
      else metric = 0.28;

      // (c) Duration relative to this song's median rather than one beat.
      // Recorded performances can have very short median durations.
      const durW = Math.min(1, nt.dur / (medDur * 2.5)) * 0.7 + 0.3;

      nt.salience = 0.55 * role + 0.25 * metric + 0.2 * durW;
      nt.layer = layer;
    }
  }

  // 3. Normalize by percentile so density 0.4 consistently means keeping the
  // most important 40 percent of notes across sparse and dense arrangements.
  const bySal = [...raw].sort((a, b) => a.salience - b.salience);
  bySal.forEach((nt, i) => { nt.rank = i / (bySal.length - 1 || 1); });

  // Keep at least one top-ranked note per bar to avoid full-bar dropouts.
  const perBar = new Map();
  for (const nt of raw) {
    const b = Math.floor(nt.time / barLen);
    const cur = perBar.get(b);
    if (!cur || nt.salience > cur.salience) perBar.set(b, nt);
  }
  for (const nt of perBar.values()) nt.rank = 1;

  let duration = 0;
  for (const nt of raw) {
    const end = nt.time + nt.dur;
    if (end > duration) duration = end;
  }

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
 * Density gate: d=1 keeps everything; smaller values keep fewer notes.
 * At least one note remains in every bar.
 */
export function gate(piece, d) {
  const keep = piece.notes.filter((n) => n.rank >= 1 - d);
  if (keep.length) return keep;
  return [piece.notes.reduce((a, b) => (a.rank > b.rank ? a : b))];
}
