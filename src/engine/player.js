import * as Tone from 'tone';

/**
 * Playback engine. Both modes share one parsed score.
 *
 * ambient
 *   The score follows its own clock. Typing changes density, velocity, and tempo
 *   gradually, with structural changes applied only at musical boundaries.
 *
 * hybrid
 *   A clock plays the bass and melodic skeleton while key presses release inner
 *   voices, passing notes, and ornaments for tightly coupled feedback.
 */
export class Player {
  constructor(piano, arranger) {
    this.piano = piano;
    this.arranger = arranger;
    this.mode = 'ambient';
    this.piece = null;
    this.part = null;
    this.onBar = () => {};
    this.onPieceEnd = () => {};
    this.onNote = () => {};
    this._lastPerfTime = 0;
    this._barEvent = null;
    this._beatEvent = null;
    this._lastBpm = 0;
    this._masterGain = 1;
    this.playing = false;
  }

  load(piece) {
    this.stop();
    this.piece = piece;
    this._buildPools(piece);
    const t = Tone.getTransport();
    t.bpm.value = piece.bpm;
    t.timeSignature = piece.timeSignature;
    return this;
  }

  /**
   * Split notes into a structural skeleton and ornament pools by salience.
   * Selecting ornaments from the current beat keeps them harmonically compatible.
   */
  _buildPools(piece) {
    // Adapt the skeleton fraction to notes per second. A fixed percentage makes
    // dense recorded performances far too busy to function as a skeleton.
    const TARGET_RATE = 7;
    const frac = Math.min(0.65, Math.max(0.06,
      (TARGET_RATE * piece.duration) / piece.noteCount));
    const cut = 1 - frac;

    this.skeleton = piece.notes.filter((n) => n.rank >= cut);
    this.ornaments = piece.notes.filter((n) => n.rank < cut);
    this.skeletonRate = +(this.skeleton.length / piece.duration).toFixed(1);

    this.pools = new Map();
    for (const nt of this.ornaments) {
      const b = Math.floor(nt.time / piece.beat);
      if (!this.pools.has(b)) this.pools.set(b, []);
      this.pools.get(b).push(nt);
    }
    // Rank ornaments by salience and favor the middle-to-upper register. Bass
    // belongs in the skeleton and muddies the texture when released as ornament.
    // The weight is precomputed: inside a comparator it would be recalculated
    // O(n log n) times per pool instead of once per note.
    for (const nt of this.ornaments) {
      nt.pickWeight = nt.salience
        + (nt.midi >= 58 && nt.midi <= 92 ? 0.25 : 0)
        - (nt.midi < 45 ? 0.35 : 0);
    }
    for (const arr of this.pools.values()) arr.sort((a, b) => b.pickWeight - a.pickWeight);
    this._poolIdx = 0;
    this._lastBeat = -1;
    this._loopLen = piece.duration + piece.barLen;
  }

  /** Hybrid mode: release one ornament for each key press. */
  strike() {
    if (this.mode !== 'hybrid' || !this.piece) return;
    const now = this.piano.immediate();            // Bypass Tone's 100 ms look-ahead.
    if (now - this._lastPerfTime < 0.045) return;  // Prevent machine-gun bursts.
    this._lastPerfTime = now;

    // Derive beats from ticks and PPQ. Seconds diverge from score time after a
    // tempo change because Part events are scheduled in ticks.
    const t = Tone.getTransport();
    const totalBeats = Math.max(1, Math.round(this._loopLen / this.piece.beat));
    const beat = Math.floor((t.ticks / t.PPQ) % totalBeats);
    let pool = this.pools.get(beat);
    // Search nearby earlier beats when the current beat has no ornaments.
    for (let k = 1; k <= 4 && (!pool || !pool.length); k++) pool = this.pools.get(beat - k);
    if (!pool || !pool.length) return;

    if (beat !== this._lastBeat) { this._lastBeat = beat; this._poolIdx = 0; }
    const nt = pool[this._poolIdx % pool.length];
    this._poolIdx++;

    const vel = Math.min(1, nt.vel * (0.5 + this.arranger.velocity * 0.9)) * this._masterGain;
    this.piano.note(nt.midi, now, Math.max(nt.dur, 0.22), vel);
    this.onNote(nt, now);
  }

  start() {
    if (!this.piece) return;
    const t = Tone.getTransport();
    if (this.part) {
      t.start();
      this.playing = true;
      return;
    }
    this._buildPart();
    t.start();
    // Apply tempo by bar and density by beat for responsive, stable changes.
    this._barEvent = t.scheduleRepeat(() => { this.onBar(this.arranger.commitBar()); }, '1m');
    this._beatEvent = t.scheduleRepeat(() => { this.arranger.commitBeat(); }, '4n');
    this.playing = true;
  }

  pause() {
    if (!this.piece || !this.playing) return;
    Tone.getTransport().pause();
    this.piano.allOff();
    this.playing = false;
  }

  resume() {
    if (!this.piece) return;
    if (!this.part) { this.start(); return; }
    Tone.getTransport().start();
    this.playing = true;
  }

  get position() { return this.piece ? Tone.getTransport().seconds : 0; }
  get duration() { return this.piece?.duration ?? 0; }

  _buildPart() {
    if (this.part) { this.part.dispose(); this.part = null; }
    const piece = this.piece;

    // Schedule the whole score once and gate notes against live density in the
    // callback. Ambient mode also needs a rate limit for dense recorded MIDI.
    const AMBIENT_MAX_RATE = 16;
    const ambientCut = 1 - Math.min(1, (AMBIENT_MAX_RATE * piece.duration) / piece.noteCount);
    const clockNotes = this.mode === 'hybrid'
      ? this.skeleton
      : piece.notes.filter((n) => n.rank >= ambientCut);
    this.part = new Tone.Part((time, nt) => {
      // Skip notes ranked below the current density threshold.
      if (nt.rank < 1 - this.arranger.density) return;
      // Use a broad velocity range so input intensity remains audible.
      const vel = Math.min(1, nt.vel * (0.28 + this.arranger.velocity * 1.2)) * this._masterGain;
      if (vel < 0.03) return;
      const dur = nt.dur / this.arranger.tempoScale;
      this.piano.note(nt.midi, time, dur, vel);
      // Double the melody at the octave during high-intensity passages.
      if (this.arranger.octaveDouble && nt.layer === 'melody' && nt.midi + 12 <= 96) {
        this.piano.note(nt.midi + 12, time, dur, vel * 0.42);
      }
      this.onNote(nt, time);
    }, clockNotes.map((n) => [n.time, n]));

    this.part.loop = true;
    this.part.loopEnd = piece.duration + piece.barLen;
    this.part.start(0);

    // Move to the next song after two loops.
    Tone.getTransport().scheduleOnce(() => this.onPieceEnd(), `+${piece.duration * 2 + 2}`);
  }

  setGain(g) { this._masterGain = g; }

  stop() {
    const t = Tone.getTransport();
    if (this._barEvent !== null) { t.clear(this._barEvent); this._barEvent = null; }
    if (this._beatEvent !== null) { t.clear(this._beatEvent); this._beatEvent = null; }
    if (this.part) { this.part.dispose(); this.part = null; }
    t.stop();
    t.cancel();
    t.position = 0;
    this.piano.allOff();
    this.playing = false;
  }

  /**
   * Drive Transport tempo from typing state. Calling rampTo every frame restarts
   * the ramp indefinitely, so schedule a new ramp only after a meaningful change.
   */
  syncTempo() {
    if (!this.piece) return;
    const target = this.piece.bpm * this.arranger.tempoScale;
    if (Math.abs(target - this._lastBpm) < 0.4) return;
    this._lastBpm = target;
    Tone.getTransport().bpm.rampTo(target, 2.5);
  }
}
