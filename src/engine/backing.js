/**
 * 伴奏轨：播放原曲音频文件。
 *
 * 位置用 AudioContext 时钟推算，不直接读 <audio>.currentTime——
 * 后者在部分浏览器里按帧更新，抖动几十毫秒。击键要挑「此刻该响的旋律音」，
 * 位置误差必须小于一个十六分音符。
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
    this._anchorCtx = 0;   // 起播时的 ctx.currentTime
    this._anchorPos = 0;   // 起播时的曲内位置
    this.playing = false;
    this.offset = 0;       // MIDI 与音频的对齐偏移（秒），可为负
    this.duration = 0;
    this.onEnded = () => {};
  }

  async load(url) {
    this.stop();
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    await new Promise((res, rej) => {
      el.addEventListener('canplaythrough', res, { once: true });
      el.addEventListener('error', () => rej(new Error('音频解码失败')), { once: true });
      setTimeout(res, 8000); // 大文件慢，能播多少算多少
    });
    this.el = el;
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
    // 定期用真实 currentTime 重锚，防止长时间累积漂移
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

  pause() {
    clearInterval(this._reanchor);
    if (this.el) this.el.pause();
    this.playing = false;
  }

  /** 当前曲内位置（秒），由 AudioContext 时钟推算 */
  get position() {
    if (!this.el || this.el.paused) return this.el?.currentTime ?? 0;
    return this._anchorPos + (this.ctx.currentTime - this._anchorCtx) * (this.el.playbackRate || 1);
  }

  /** 对齐后的位置：用来在乐谱里找「此刻该响的音」 */
  get scorePosition() { return this.position + this.offset; }

  /** 用户演奏时把伴奏轻微压下去，让弹出来的音浮在上面 */
  duck(amount) {
    this.duckGain = 1 - Math.min(0.45, Math.max(0, amount));
    this._applyGain();
  }

  setVolume(v) { this.volume = v; this._applyGain(); }

  _applyGain() {
    const g = this.volume * this.duckGain;
    this.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.08);
  }
}
