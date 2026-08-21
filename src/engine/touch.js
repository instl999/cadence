/**
 * First feedback layer: an immediate tactile response for every key press.
 *
 * A quiet 20-60 ms transient confirms each key press. The second feedback layer
 * aggregates stem gating over a window, so one key may not cause an audible
 * change; this layer keeps slow typing responsive.
 *
 * A synthesized transient avoids media dependencies, keeps latency predictable,
 * and stays harmonically neutral.
 */
export class Touch {
  constructor(ctx) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.05;
    this.out.connect(ctx.destination);
    this._noise = this._makeNoise();
    this._last = 0;
  }

  _makeNoise() {
    const n = Math.floor(this.ctx.sampleRate * 0.08);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1);
    return buf;
  }

  /** @param accent Use a stronger response for Space or Enter. */
  hit(accent = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.002;   // Use the native clock without look-ahead.
    if (t - this._last < 0.02) return;   // Rate-limit extreme bursts.
    this._last = t;

    const dur = accent ? 0.055 : 0.03;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = accent ? 320 : 1400;
    bp.Q.value = accent ? 1.2 : 2.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(accent ? 1 : 0.55, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    src.connect(bp); bp.connect(g); g.connect(this.out);
    src.start(t); src.stop(t + dur + 0.02);
  }
}
