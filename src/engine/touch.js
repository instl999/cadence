/**
 * 第一层反馈：每次击键的即时触感。
 *
 * 20~60ms 的极轻瞬态，音量很低（默认 −26dB 左右）。
 * 它的职责不是「音乐」，而是保证每一次击键都有确认感——
 * 第二层（声部门控）是按窗口合并的，单次击键不一定引起可闻变化，
 * 没有这一层的话慢速打字会觉得「我按了但没反应」。
 *
 * 用合成瞬态而不是原曲采样：不依赖素材、延迟可控、
 * 而且音色可以刻意做得中性，不和任何调性打架。
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

  /** @param accent true 时给一个更明显的（空格/回车） */
  hit(accent = false) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.002;   // 直接用原生时钟，不经 Tone 的 lookAhead
    if (t - this._last < 0.02) return;   // 极限连打时限流，避免叠成噪音
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

  setLevel(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
}
