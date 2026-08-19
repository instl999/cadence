/**
 * 从节奏特征推断认知状态，再映射到音乐参数。
 *
 * 设计原则（比参数本身更重要）：
 *  1. 心流时不做「结构性」改变——不换曲、不转调。但**响度和织体仍然跟着走**，
 *     否则用户根本感觉不到音乐在回应他。
 *  2. 退格率高 = 卡住了，音乐该托住他而不是嘲讽他：变简单变安静。
 *  3. 空闲不等于静音。底噪必须一直在，打字是让它「长起来」——
 *     从静音升起比从底噪长起来难感知得多。
 */

// 中性点：灵敏度为 0 时所有状态都收敛到这里（音乐完全不理你）
const NEUTRAL = { density: 0.58, velocity: 0.72, tempo: 1.0 };

export const STATES = {
  flow:       { label: '心流', density: 0.82, velocity: 1.00, tempo: 1.20, hold: true },
  thinking:   { label: '构思', density: 0.68, velocity: 0.70, tempo: 0.99, hold: false },
  struggling: { label: '卡壳', density: 0.40, velocity: 0.50, tempo: 0.84, hold: false },
  pause:      { label: '停顿', density: 0.46, velocity: 0.55, tempo: 0.92, hold: false },
  away:       { label: '离开', density: 0.34, velocity: 0.42, tempo: 0.82, hold: false },
};

export function classify(f) {
  if (f.count === 0 || f.idle > 45) return 'away';
  if (f.idle > 3) return 'pause';
  if (f.backRate > 0.18) return 'struggling';
  if (f.rate > 2.0 && f.cv < 1.0) return 'flow';  // 真人打字实测 cv≈0.84，阈值必须留余量
  return 'thinking';
}

const lerp = (a, b, t) => a + (b - a) * t;

export class Arranger {
  constructor() {
    this.state = 'away';
    this.sens = 1;                 // 灵敏度：0 = 完全不理你，1.6 = 夸张
    this.smooth = { density: 0.4, velocity: 0.5, tempo: 0.9 };
    this.applied = { density: 0.4, tempo: 0.9 };
    this.intensity = 0;            // 快速项：跟手感的主要来源
  }

  update(features, dt) {
    const s = this.sens;
    this.state = classify(features);
    const raw = STATES[this.state];

    // 灵敏度把各状态的目标值向中性点收缩 / 向外放大
    const target = {
      density: lerp(NEUTRAL.density, raw.density, s),
      velocity: lerp(NEUTRAL.velocity, raw.velocity, s),
      tempo: lerp(NEUTRAL.tempo, raw.tempo, s),
    };

    // 时间常数也随灵敏度缩放。基线比第一版快了 3 倍多——
    // 原来密度要 8~14 秒才动，用户早就放弃观察了。
    const speed = 0.5 + 0.5 * s;
    const k = (tau) => 1 - Math.exp(-dt / (tau / speed));

    // 快速强度项：0.8 秒时间常数，直接跟击键速率走。
    // 慢速状态机负责「氛围」，这一项负责「跟手」。
    const drive = Math.min(1, features.rate / 5.5);
    this.intensity += (drive - this.intensity) * k(0.8);

    this.smooth.density += (target.density + this.intensity * 0.14 * s - this.smooth.density) * k(raw.hold ? 4 : 2.5);
    this.smooth.velocity += (target.velocity + this.intensity * 0.22 * s - this.smooth.velocity) * k(1.0);
    this.smooth.tempo += (target.tempo - this.smooth.tempo) * k(5);

    this.smooth.density = Math.min(1, Math.max(0.1, this.smooth.density));
    this.smooth.velocity = Math.min(1.35, Math.max(0.15, this.smooth.velocity));
    return this.state;
  }

  /** 密度按拍落地——比按小节快得多，但平滑已经保证了不会跟着击键抖 */
  commitBeat() { this.applied.density = this.smooth.density; return this.applied; }
  /** 速度按小节落地：中途变速比中途变织体刺耳得多 */
  commitBar() { this.applied.tempo = this.smooth.tempo; return this.applied; }

  get density() { return this.applied.density; }
  get tempoScale() { return this.applied.tempo; }
  get velocity() { return this.smooth.velocity; }
  /**
   * 高强度时给旋律加八度——钢琴家堆张力的惯用手法，也是最容易听出来的一档变化。
   * 带滞回：不加的话强度在阈值附近抖动会让八度反复开关，听起来很毛躁。
   */
  get octaveDouble() {
    if (this.sens <= 0.3) return (this._oct = false);
    if (this.intensity > 0.66) this._oct = true;
    else if (this.intensity < 0.50) this._oct = false;
    return !!this._oct;
  }
}
