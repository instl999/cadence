import { pentatonicPool } from './keydetect.js';

/**
 * Performance layer that turns key presses into playing the current song.
 *
 * Two note sources are supported, in priority order:
 * A. Matching MIDI: extract its melody and release the song's actual notes near
 *    the playhead.
 * B. Audio only: estimate the key and use an in-key pentatonic pool.
 *
 * Selecting notes near the playhead prevents fast typing from outrunning the
 * backing track.
 */
export class Soloist {
  constructor(piano) {
    this.piano = piano;
    this.source = 'none';        // 'midi' | 'pentatonic' | 'none'
    this.line = [];              // Time-sorted melody notes for MIDI mode.
    this.pool = [];              // Available pitches for pentatonic mode.
    this.octave = 0;
    this._last = 0;
    this._lastIdx = -1;
    this._poolIdx = 0;
    this._dir = 1;
    this._lastMidi = null;
    this.loMidi = 55;    // G3
    this.hiMidi = 88;    // E6
    this.minGap = 0.045;
  }

  /** Extract the most salient melody-layer notes from a parsed score. */
  fromMidi(piece) {
    const mel = piece.notes
      .filter((n) => n.layer === 'melody' && n.midi >= 55 && n.midi <= 96)
      .sort((a, b) => a.time - b.time);

    // Keep only the highest note at each onset to avoid chord bursts.
    const line = [];
    for (const n of mel) {
      const prev = line[line.length - 1];
      if (prev && n.time - prev.time < 0.06) {
        if (n.midi > prev.midi) line[line.length - 1] = n;
      } else line.push(n);
    }
    // Limit density to a singable rate. Recorded MIDI melody layers may include
    // an entire upper texture rather than one perceivable melodic line.
    const TARGET_RATE = 3.5;
    const budget = Math.ceil(TARGET_RATE * (piece.duration || 1));
    if (line.length > budget) {
      const keep = new Set(
        [...line].sort((a, b) => b.salience - a.salience).slice(0, budget)
      );
      this.line = line.filter((n) => keep.has(n));
    } else {
      this.line = line;
    }

    this.source = this.line.length > 8 ? 'midi' : 'none';
    return this.line.length;
  }

  fromKey(tonic, mode) {
    this.pool = pentatonicPool(tonic, mode);
    this.source = 'pentatonic';
    this._poolIdx = Math.floor(this.pool.length / 2);
    return this.pool.length;
  }

  /**
   * Process one key press.
   * @param scorePos Current playhead position on the score timeline, in seconds.
   * @param intensity Typing intensity from 0..1, used for velocity.
   * @returns The played MIDI pitch, or null if no note was played.
   */
  strike(scorePos, intensity = 0.5) {
    const now = this.piano.immediate();
    if (now - this._last < this.minGap) return null;
    this._last = now;

    const vel = Math.min(1, 0.45 + intensity * 0.5);
    let midi = null;

    if (this.source === 'midi' && this.line.length) {
      const i = this._nearestIdx(scorePos);
      // Advance when the same note was just played to avoid local repetition.
      const idx = (i === this._lastIdx) ? Math.min(this.line.length - 1, i + 1) : i;
      this._lastIdx = idx;
      midi = this.line[idx].midi + this.octave * 12;
      // Normalize octave placement. Keep the pitch class while balancing melodic
      // continuity against proximity to a comfortable center register.
      const CENTER = 74;   // D5, a comfortable melodic register.
      let bestM = midi, bestCost = Infinity;
      for (let k = -3; k <= 3; k++) {
        const cand = midi + k * 12;
        if (cand < this.loMidi || cand > this.hiMidi) continue;
        const cost = (this._lastMidi === null ? 0 : Math.abs(cand - this._lastMidi))
          + Math.abs(cand - CENTER) * 0.7;
        if (cost < bestCost) { bestCost = cost; bestM = cand; }
      }
      midi = bestM;
      this._lastMidi = midi;
    } else if (this.source === 'pentatonic' && this.pool.length) {
      // Shape an ascending or descending contour instead of jumping randomly.
      this._poolIdx += this._dir * (Math.random() < 0.72 ? 1 : 2);
      if (this._poolIdx >= this.pool.length - 1) { this._poolIdx = this.pool.length - 1; this._dir = -1; }
      if (this._poolIdx <= 0) { this._poolIdx = 0; this._dir = 1; }
      if (Math.random() < 0.14) this._dir *= -1;
      midi = this.pool[this._poolIdx] + this.octave * 12;
    }
    if (midi === null) return null;

    this.piano.note(midi, now, 0.9, vel);
    return midi;
  }

  /** Find the melody note nearest the playhead with binary search. */
  _nearestIdx(t) {
    const L = this.line;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].time < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(L[lo - 1].time - t) < Math.abs(L[lo].time - t)) lo--;
    return lo;
  }
}
