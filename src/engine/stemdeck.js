/**
 * 分轨调音台：所有声部共用一条播放时间轴，各自一个音量门。
 *
 * 关键点是**绝不为击键重新启动采样**。所有轨用同一个 ctx.currentTime 起播、
 * 同一个 offset，之后永远样本级同步。击键只改增益。
 *
 * 这样用户听到的永远是原曲在那一刻本来的样子：
 * 不会跑调、不会对不上、不会口吃成「我…我…我…」。
 * 间奏段也自动正确——那里人声轨本来就是空的，开门也不会有声音。
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
    this._endTimer = null;
    this.onEnded = () => {};
  }

  /** @param entries {role: ArrayBuffer} */
  async load(entries, onProgress = () => {}) {
    this.stop();
    this.stems.clear();
    this.duration = 0;
    const roles = Object.keys(entries);
    let done = 0;
    for (const role of roles) {
      const buffer = await this.ctx.decodeAudioData(entries[role]);
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      this.stems.set(role, { buffer, gain, src: null });
      this.duration = Math.max(this.duration, buffer.duration);
      onProgress(++done / roles.length, role);
    }
    return this;
  }

  has(role) { return this.stems.has(role); }
  get roles() { return [...this.stems.keys()]; }

  /** 所有轨用同一个起播时刻和同一个 offset —— 这是同步的全部秘密 */
  play(offset = this._startOffset) {
    if (this.playing) this._stopSources();
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, this.duration - 0.01)));
    const t = this.ctx.currentTime + 0.06;
    for (const s of this.stems.values()) {
      const src = this.ctx.createBufferSource();
      src.buffer = s.buffer;
      src.connect(s.gain);
      src.start(t, Math.min(safeOffset, s.buffer.duration - 0.01));
      s.src = src;
    }
    this._startCtx = t;
    this._startOffset = safeOffset;
    this.playing = true;
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => {
      if (!this.playing) return;
      this.playing = false;
      this._startOffset = this.duration;
      this.onEnded();
    }, Math.max(0, this.duration - safeOffset) * 1000 + 80);
  }

  seek(sec) {
    const wasPlaying = this.playing;
    this._stopSources();
    this._startOffset = Math.max(0, Math.min(sec, Math.max(0, this.duration - 0.01)));
    if (wasPlaying) this.play(Math.max(0, Math.min(sec, this.duration - 0.5)));
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
    // 增益一并归零：源已经停了不会出声，但留着非零值会让下一次起播
    // 在门控还没跑起来的那一瞬间漏出全音量
    for (const s of this.stems.values()) s.gain.gain.value = 0;
  }

  _stopSources() {
    clearTimeout(this._endTimer);
    this._endTimer = null;
    for (const s of this.stems.values()) {
      if (s.src) { try { s.src.stop(); } catch { /* 已结束 */ } s.src.disconnect(); s.src = null; }
    }
  }

  get position() {
    if (!this.playing) return this._startOffset;
    return this._startOffset + (this.ctx.currentTime - this._startCtx);
  }

  /** 找到背景声部真正开始有声的位置，跳过分轨工具留下的长前导静音。 */
  audibleStart(preferred = ['instrumental', 'other', 'drums', 'bass']) {
    const role = preferred.find((r) => this.stems.has(r)) ?? this.roles[0];
    const buffer = this.stems.get(role)?.buffer;
    if (!buffer) return 0;

    const frame = Math.max(512, Math.floor(buffer.sampleRate * 0.05));
    const limit = Math.min(buffer.length, Math.floor(buffer.sampleRate * 24));
    const threshold = 0.0028; // 约 -51dB RMS
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

  /** 平滑设置某个声部的增益。ramp 秒数决定淡入淡出速度。 */
  setGain(role, value, ramp = 0.05) {
    const s = this.stems.get(role);
    if (!s) return;
    s.gain.gain.setTargetAtTime(Math.max(0, value), this.ctx.currentTime, Math.max(0.005, ramp / 3));
  }

  setMaster(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }

  /** 估算内存占用（MB），用来判断要不要降规格 */
  get memoryMB() {
    let bytes = 0;
    for (const s of this.stems.values()) {
      bytes += s.buffer.length * s.buffer.numberOfChannels * 4;
    }
    return +(bytes / 1048576).toFixed(0);
  }
}
