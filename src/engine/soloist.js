import { pentatonicPool } from './keydetect.js';

/**
 * 演奏层：把击键变成「你在弹这首歌」。
 *
 * 两种音源，优先用第一种：
 *  A. 配套 MIDI —— 抽出旋律线，击键按播放头顺序释放**原曲真正的音符**。
 *     这是「我在弹这首歌」而不是「我在随便按」的关键。
 *  B. 只有 MP3 —— 从音频估调性，用五声音阶音池。
 *     五声音阶在调内几乎不与任何和弦冲突，所以怎么按都不会难听。
 *
 * 同步策略：击键释放的是「播放头附近该响的那个音」，不是「下一个没弹过的音」。
 * 后者会让打字快的人跑到伴奏前面去，几秒就散架。
 */
export class Soloist {
  constructor(piano) {
    this.piano = piano;
    this.source = 'none';        // 'midi' | 'pentatonic' | 'none'
    this.line = [];              // MIDI 模式：按时间排序的旋律音
    this.pool = [];              // 五声模式：可用音高
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

  /** 从已解析的乐谱抽旋律线。取显著度最高的一批 melody 层音符。 */
  fromMidi(piece) {
    const mel = piece.notes
      .filter((n) => n.layer === 'melody' && n.midi >= 55 && n.midi <= 96)
      .sort((a, b) => a.time - b.time);

    // 同一时刻只留最高音，避免和弦式旋律一次放出一堆
    const line = [];
    for (const n of mel) {
      const prev = line[line.length - 1];
      if (prev && n.time - prev.time < 0.06) {
        if (n.midi > prev.midi) line[line.length - 1] = n;
      } else line.push(n);
    }
    // 限流到「能唱出来」的密度。
    // 实录 MIDI 的 melody 层可能有 25 音/秒——那是整个上层织体，不是旋律。
    // 用户按 5 键/秒等于在里面每 5 个取 1 个，听起来是散音不是曲调。
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
   * 一次击键。
   * @param scorePos 当前播放头在乐谱时间轴上的位置（秒）
   * @param intensity 打字强度 0..1，驱动力度
   * @returns 实际弹出的音高，没弹则返回 null
   */
  strike(scorePos, intensity = 0.5) {
    const now = this.piano.immediate();
    if (now - this._last < this.minGap) return null;
    this._last = now;

    const vel = Math.min(1, 0.45 + intensity * 0.5);
    let midi = null;

    if (this.source === 'midi' && this.line.length) {
      const i = this._nearestIdx(scorePos);
      // 同一个音已经弹过就往后挪一个，避免连打时原地重复同一个音
      const idx = (i === this._lastIdx) ? Math.min(this.line.length - 1, i + 1) : i;
      this._lastIdx = idx;
      midi = this.line[idx].midi + this.octave * 12;
      // 八度归位：实录的 melody 层横跨三四个八度，直接照搬会出现 40 个半音的大跳。
      // 保留音级（还是这首歌的音），只选一个八度位置，同时满足两件事：
      //   1. 离上一个音近（旋律连贯）
      //   2. 离中心音区近（否则会一路走高，卡死在最尖的那几个音上）
      const CENTER = 74;   // D5，人声主旋律的舒适区
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
      // 按打字强度做上下行的旋律走向，而不是纯随机跳
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

  /** 二分找最接近播放头的旋律音 */
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
