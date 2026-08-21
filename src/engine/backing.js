/**
 * Backing track for the original audio file.
 *
 * Position is derived from the AudioContext clock rather than reading
 * <audio>.currentTime directly, which updates per frame in some browsers. The
 * timing error must remain below a sixteenth note for responsive note selection.
 */
export class Backing {
  constructor(ctx) {
    this.ctx = ctx;
    this.el = null;
    this.src = null;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.duckGain = 1;
    this.volume = 0.75;
    this._anchorCtx = 0;   // Context time at playback start.
    this._anchorPos = 0;   // Track position at playback start.
    this.playing = false;
    this.offset = 0;       // MIDI-to-audio offset in seconds; may be negative.
    this.duration = 0;
    this._ownedUrl = null; // Object URL to revoke on unload, when we created it.
    this.onEnded = () => {};
  }

  /**
   * @param url Media URL to play.
   * @param revokeOnUnload Set when the URL is an object URL this deck owns.
   */
  async load(url, { revokeOnUnload = false } = {}) {
    this.stop();
    this.unload();
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    await new Promise((res, rej) => {
      // Large files may become playable before they finish loading.
      const timer = setTimeout(res, 8000);
      const settle = (fn) => (value) => { clearTimeout(timer); fn(value); };
      el.addEventListener('canplaythrough', settle(res), { once: true });
      el.addEventListener('error', settle(() => rej(new Error('Audio decoding failed'))), { once: true });
    });
    this.el = el;
    this._ownedUrl = revokeOnUnload ? url : null;
    el.addEventListener('ended', () => {
      this.playing = false;
      clearInterval(this._reanchor);
      this.onEnded();
    });
    this.duration = el.duration || 0;
    this.src = this.ctx.createMediaElementSource(el);
    this.src.connect(this.gain);
    this._applyGain();
    return this;
  }

  async play() {
    if (!this.el) return;
    if (this.el.currentTime >= this.duration - 0.05) this.el.currentTime = 0;
    await this.el.play();
    this._anchorCtx = this.ctx.currentTime;
    this._anchorPos = this.el.currentTime;
    this.playing = true;
    // Re-anchor periodically to prevent long-running clock drift.
    clearInterval(this._reanchor);
    this._reanchor = setInterval(() => {
      if (!this.el || this.el.paused) return;
      const drift = Math.abs(this.position - this.el.currentTime);
      if (drift > 0.08) { this._anchorCtx = this.ctx.currentTime; this._anchorPos = this.el.currentTime; }
    }, 2000);
  }

  stop() {
    this.pause();
    if (this.el) this.el.currentTime = 0;
  }

  /**
   * Release the current element and its source node.
   *
   * A MediaElementAudioSourceNode keeps a strong reference to its media element,
   * and stays reachable while it remains connected to the graph. Overwriting
   * this.src without disconnecting pins every element the instance ever loaded.
   */
  unload() {
    clearInterval(this._reanchor);
    if (this.src) { this.src.disconnect(); this.src = null; }
    if (this._ownedUrl) { URL.revokeObjectURL(this._ownedUrl); this._ownedUrl = null; }
    if (!this.el) return;
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();     // Drops the buffered media rather than leaving it resident.
    this.el = null;
    this.duration = 0;
    this.playing = false;
  }

  pause() {
    clearInterval(this._reanchor);
    if (this.el) this.el.pause();
    this.playing = false;
  }

  /** Current track position in seconds, derived from the AudioContext clock. */
  get position() {
    if (!this.el || this.el.paused) return this.el?.currentTime ?? 0;
    return this._anchorPos + (this.ctx.currentTime - this._anchorCtx) * (this.el.playbackRate || 1);
  }

  /** Aligned position used to select the score note for the current moment. */
  get scorePosition() { return this.position + this.offset; }

  /** Duck the backing track slightly so performed notes stay prominent. */
  duck(amount) {
    this.duckGain = 1 - Math.min(0.45, Math.max(0, amount));
    this._applyGain();
  }

  _applyGain() {
    const g = this.volume * this.duckGain;
    this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08);
  }
}
