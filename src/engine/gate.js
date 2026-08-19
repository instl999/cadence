/**
 * 打字 -> 声部音量门。
 *
 * 核心规则：**打字速度控制「显现时长」，不控制「轨道数量」。**
 * 越打越快不是加更多乐器，而是让当前声部保持打开更久，
 * 直到接近原曲的完整混音为止——然后封顶，不再增加任何东西。
 *
 * 每次击键把「保持打开到」这个时刻往后推。
 * 单键 -> 约 150ms 的显现窗口；持续打字 -> 窗口不断被推后，变成连续；
 * 停手 -> 按 release 自然淡出，而不是像拔掉音频线一样瞬断。
 */
export class Gate {
  constructor(opts = {}) {
    /**
     * 窗口用「相对用户正常击键间隔的倍数」表示，不用绝对秒数。
     *
     * 用绝对秒数等于写死了一个速度门槛：0.14s 的窗口意味着要 7 键/秒
     * 才能连续，正常写字根本达不到，只能靠乱按键盘去够——
     * 那不是这个产品该有的样子。
     *
     * 换成相对量之后：按自己正常速度打字 = 连续；明显慢下来 = 断续。
     * 无论这个人本来打多快都成立。
     */
    this.refRate = opts.refRate ?? 3.2;          // 正常打字速度（键/秒），可校准
    this.winMin = opts.winMin ?? 1.05;           // 窗口 = 正常击键间隔 × 这个倍数
    this.winMax = opts.winMax ?? 1.45;
    this.attack = opts.attack ?? 0.028;          // 开门要快，否则击键像慢半拍
    this.release = opts.release ?? 0.11;         // 3τ ≈ 330ms，停手后的自然渐出
    this.value = 0;
    this.sustain = 0;                            // 持续投入度 0..1
    this.holdUntil = 0;
  }

  /** 用户正常打字时的击键间隔（秒） */
  get refIki() { return 1 / Math.max(0.5, this.refRate); }

  /** 击键。多次击键落在同一个窗口内会自然合并，不会各自触发一次声音。 */
  strike(now) {
    const k = this.winMin + this.sustain * (this.winMax - this.winMin);
    const win = Math.min(0.95, Math.max(0.12, this.refIki * k));
    this.holdUntil = Math.max(this.holdUntil, now + win);
  }

  /** @param rate 当前打字速率（键/秒） */
  update(now, dt, rate) {
    // 以「用户自己的正常速度」为满格，而不是写死的 5 键/秒
    const drive = Math.min(1, rate / Math.max(0.5, this.refRate));
    this.sustain += (drive - this.sustain) * (1 - Math.exp(-dt / 1.6));
    const target = now < this.holdUntil ? 1 : 0;
    const tau = target ? this.attack : this.release;
    this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
    if (this.value < 1e-4) this.value = 0;
    return this.value;
  }
}

/**
 * 混音策略。
 *
 * 最终声音 = 背景 × 背景系数 + 前景声部 × 打字活动值 + 极轻的触感音
 * 注意背景系数会随前景升高而下降（−2.5dB 左右），不是简单相加——
 * 否则前景一开总响度就往上窜，打字越久越吵。
 */
export const MODES = {
  vocal: {
    label: '人声演奏',
    hint: '默认只有伴奏。打字时原唱逐渐显现，停手退回卡拉 OK。',
    foreground: ['vocals'],
    background: ['instrumental', 'drums', 'bass', 'other'],
  },
  instrument: {
    label: '乐器演奏',
    hint: '默认保留人声和节奏。打字时旋律乐器恢复。',
    foreground: ['other'],
    background: ['vocals', 'drums', 'bass'],
  },
  drums: {
    label: '鼓组演奏',
    hint: '默认无鼓。打字时节拍进来，停手只剩旋律。',
    foreground: ['drums'],
    background: ['vocals', 'instrumental', 'bass', 'other'],
  },
};

/** 某个模式在当前分轨集合下能不能用（前景和背景都得有东西） */
export function modeAvailable(mode, roles) {
  const m = MODES[mode];
  if (!m) return false;
  const has = (list) => list.some((r) => roles.includes(r));
  return has(m.foreground) && has(m.background);
}

export class Mixer {
  constructor(deck) {
    this.deck = deck;
    this.gate = new Gate();
    this.accent = new Gate({ winMin: 1.6, winMax: 1.6, attack: 0.01, release: 0.5 });
    this.mode = 'vocal';
    this.bgLevel = 0.85;
    this.fgLevel = 1.0;
    this.duck = 0.25;          // 前景全开时背景降到 75%（约 −2.5dB）
    this.FG_CAP = 2;           // 同时开放的前景声部上限
  }

  /** 设置用户的正常打字速度（键/秒）。两个门都要跟着改。 */
  setRefRate(rate) {
    this.gate.refRate = rate;
    this.accent.refRate = rate;
  }

  setMode(mode) {
    this.mode = mode;
    // 换模式时把所有轨归零，下一帧的 apply 会重新铺开
    for (const r of this.deck.roles) this.deck.setGain(r, 0, 0.15);
  }

  strike(now, kind) {
    this.gate.strike(now);
    // 空格/回车 = 词边界/段落边界，给一次更明显的重音
    if (kind === 'space' || kind === 'enter') this.accent.strike(now);
  }

  update(now, dt, rate) {
    const fg = this.gate.update(now, dt, rate);
    const ac = this.accent.update(now, dt, rate);
    const m = MODES[this.mode];
    const roles = this.deck.roles;

    const fgRoles = m.foreground.filter((r) => roles.includes(r)).slice(0, this.FG_CAP);
    const bgRoles = m.background.filter((r) => roles.includes(r));

    // 前景开启时背景退让，总响度基本不变
    const bg = this.bgLevel * (1 - this.duck * fg);
    for (const r of bgRoles) this.deck.setGain(r, bg, 0.12);
    for (const r of fgRoles) this.deck.setGain(r, this.fgLevel * fg, fg > 0.5 ? 0.03 : 0.18);

    // 重音：鼓在背景里时，空格/回车给它一个短暂的抬升
    if (bgRoles.includes('drums') && ac > 0.01) {
      this.deck.setGain('drums', bg * (1 + 0.45 * ac), 0.05);
    }
    return { fg, ac, fgRoles, bgRoles };
  }
}
