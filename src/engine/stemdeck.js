/**
 * Stem mixer: every stem shares one timeline and has its own gain gate.
 *
 * A key press never restarts a sample. Every stem starts at the same context
 * time and offset, stays sample-aligned, and responds only through gain changes.
 *
 * This preserves the song's original timing and pitch. Instrumental sections
 * also behave naturally because a silent vocal stem remains silent when opened.
 */
export class StemDeck {
  constructor(ctx) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.stems = new Map();   // role -> { buffer, gain, src }
    this.duration = 0;
    this.playing = false;
    this._startCtx = 0;
    this._startOffset = 0;
    this._generation = 0;
    this.onEnded = () => {};
  }

  /** @param entries {role: ArrayBuffer} */
  async load(entries, onProgress = () => {}) {
    this.stop();
    const roles = Object.keys(entries);
    let done = 0;
    // Decode every stem at once. decodeAudioData runs off the main thread, so
    // these genuinely overlap; serialising them multiplied load time by the
    // number of stems.
    const decoded = await Promise.all(roles.map(async (role) => {
      const buffer = await this.ctx.decodeAudioData(entries[role]);
      onProgress(++done / roles.length, role);
      return [role, buffer];
    }));

    // Swap in only once every stem decoded, so a mid-load failure cannot leave
    // the deck holding a partial mix.
    for (const s of this.stems.values()) s.gain.disconnect();
    this.stems.clear();
    this.duration = 0;
    for (const [role, buffer] of decoded) {
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      this.stems.set(role, { buffer, gain, src: null });
      this.duration = Math.max(this.duration, buffer.duration);
    }
    return this;
  }

  /** Drop decoded audio; a stereo pair can hold well over 100 MB. */
  unload() {
    this.stop();
    for (const s of this.stems.values()) s.gain.disconnect();
    this.stems.clear();
    this.duration = 0;
  }

  has(role) { return this.stems.has(role); }
  get roles() { return [...this.stems.keys()]; }

  /** Start every stem at the same time and offset to keep them synchronized. */
  play(offset = this._startOffset) {
    if (this.playing) this._stopSources();
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, this.duration - 0.01)));
    const t = this.ctx.currentTime + 0.06;
    const generation = ++this._generation;
    let longest = null;
    for (const s of this.stems.values()) {
      const src = this.ctx.createBufferSource();
      src.buffer = s.buffer;
      src.connect(s.gain);
      src.start(t, Math.min(safeOffset, s.buffer.duration - 0.01));
      s.src = src;
      if (!longest || s.buffer.duration > longest.buffer.duration) longest = s;
    }
    this._startCtx = t;
    this._startOffset = safeOffset;
    this.playing = true;

    // End on the AudioContext clock rather than a wall-clock timer. The two
    // diverge across system sleep, and only the audio clock knows the truth.
    if (longest?.src) {
      longest.src.onended = () => {
        if (generation !== this._generation || !this.playing) return;
        this.playing = false;
        this._startOffset = this.duration;
        this.onEnded();
      };
    }
  }

  pause() {
    if (!this.playing) return;
    const pos = Math.max(0, Math.min(this.position, this.duration));
    this._stopSources();
    this._startOffset = pos;
    this.playing = false;
  }

  stop() {
    this._stopSources();
    this.playing = false;
    this._startOffset = 0;
    // Reset gains so the next start cannot leak full volume before gating begins.
    for (const s of this.stems.values()) s.gain.gain.value = 0;
  }

  _stopSources() {
    // Bumping the generation first makes the ended handlers of these sources
    // no-ops, so a deliberate stop cannot be mistaken for the end of the track.
    this._generation++;
    for (const s of this.stems.values()) {
      if (!s.src) continue;
      s.src.onended = null;
      try { s.src.stop(); } catch { /* Already ended. */ }
      s.src.disconnect();
      s.src = null;
    }
  }

  get position() {
    if (!this.playing) return this._startOffset;
    return this._startOffset + (this.ctx.currentTime - this._startCtx);
  }

  /** Find the first audible background frame and skip long separator silence. */
  audibleStart(preferred = ['instrumental', 'other', 'drums', 'bass']) {
    const role = preferred.find((r) => this.stems.has(r)) ?? this.roles[0];
    const buffer = this.stems.get(role)?.buffer;
    if (!buffer) return 0;

    const frame = Math.max(512, Math.floor(buffer.sampleRate * 0.05));
    const limit = Math.min(buffer.length, Math.floor(buffer.sampleRate * 24));
    const threshold = 0.0028; // Approximately -51 dB RMS.
    let consecutive = 0;

    for (let start = 0; start < limit; start += frame) {
      let energy = 0;
      let samples = 0;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        const end = Math.min(start + frame, data.length);
        for (let i = start; i < end; i += 8) {
          energy += data[i] * data[i];
          samples++;
        }
      }
      const rms = samples ? Math.sqrt(energy / samples) : 0;
      consecutive = rms >= threshold ? consecutive + 1 : 0;
      if (consecutive >= 3) return Math.max(0, start / buffer.sampleRate - 0.18);
    }
    return 0;
  }

  /** Smoothly set a stem gain; ramp controls the fade duration in seconds. */
  setGain(role, value, ramp = 0.05) {
    const s = this.stems.get(role);
    if (!s) return;
    s.gain.gain.setTargetAtTime(Math.max(0, value), this.ctx.currentTime, Math.max(0.005, ramp / 3));
  }

}
