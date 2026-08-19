/**
 * 打字传感器。
 *
 * 隐私契约（整个项目最重要的一条设计约束）：
 * 本模块对外只发出 { t, kind }，kind ∈ {char, back, enter, space}。
 * **任何按键的具体字符 / keyCode 都不会离开这个函数的作用域**，
 * 更不会进入音乐引擎、不会被存储、不会上网。
 *
 * 这既是隐私护城河，也是音乐上的正确选择：字母本身没有音乐意义，
 * 把字母映射成音高只会得到随机噪音。真正有信息量的是「节奏结构」。
 */
export class TypingSensor {
  constructor({ window = 60 } = {}) {
    this.window = window;   // 保留多长时间的事件（秒）
    this.events = [];       // [{t, kind}]，只增不查内容
    this.listeners = [];
    this.ikis = [];         // 连打间隔的长期样本，用于估「这个人平常打多快」
  }

  onEvent(fn) { this.listeners.push(fn); return this; }

  /** 从 DOM KeyboardEvent 提取时间戳与「结构类别」，随即丢弃事件本体 */
  ingest(e) {
    let kind;
    if (e.key === 'Backspace' || e.key === 'Delete') kind = 'back';
    else if (e.key === 'Enter') kind = 'enter';
    else if (e.key === ' ') kind = 'space';
    else if (e.key.length === 1) kind = 'char';
    else return; // 方向键 / 修饰键 / 功能键一律不计
    this.push(kind);
  }

  push(kind) {
    const t = performance.now() / 1000;
    const prev = this.events[this.events.length - 1];
    // 只收连打间隔（<1s），跳过思考停顿——否则「平常打多快」会被停顿稀释
    if (prev && t - prev.t < 1) {
      this.ikis.push(t - prev.t);
      if (this.ikis.length > 400) this.ikis.shift();
    }
    this.events.push({ t, kind });
    const cutoff = t - this.window;
    while (this.events.length && this.events[0].t < cutoff) this.events.shift();
    for (const fn of this.listeners) fn(kind, t);
  }

  /**
   * 「这个人平常打多快」（键/秒）。
   * 注意不能用 features().rate —— 那是最近 5 秒的瞬时值，
   * 在用户刚停手时（比如刚点完歌、正在等解码）会接近 0，
   * 拿它去标定会得到完全错误的结果。
   * 这里用连打间隔的中位数，跟采样时刻无关。
   */
  typicalRate() {
    if (this.ikis.length < 20) return null;
    const med = [...this.ikis].sort((a, b) => a - b)[this.ikis.length >> 1];
    return med > 0 ? 1 / med : null;
  }

  /** 返回节奏特征。全部只依赖时间戳。 */
  features(now = performance.now() / 1000) {
    const ev = this.events;
    const last = ev.length ? ev[ev.length - 1].t : -Infinity;
    const idle = now - last;

    const recent = ev.filter((e) => e.t > now - 5);
    const rate = recent.length / 5;                    // 击键/秒

    // 击键间隔的变异系数：稳定连打 -> 小；边想边打 -> 大
    const iki = [];
    for (let i = 1; i < recent.length; i++) iki.push(recent[i].t - recent[i - 1].t);
    let cv = 1;
    if (iki.length >= 3) {
      const mean = iki.reduce((a, b) => a + b) / iki.length;
      const sd = Math.sqrt(iki.reduce((a, b) => a + (b - mean) ** 2, 0) / iki.length);
      cv = mean > 0 ? sd / mean : 1;
    }

    // 退格率：卡壳/反复修改的信号
    const win20 = ev.filter((e) => e.t > now - 20);
    const backRate = win20.length >= 8
      ? win20.filter((e) => e.kind === 'back').length / win20.length
      : 0;

    // 最近是否有段落边界（回车）——用于把音乐变化对齐到"乐句"
    const lastEnter = [...ev].reverse().find((e) => e.kind === 'enter');
    const sinceEnter = lastEnter ? now - lastEnter.t : Infinity;

    return { idle, rate, cv, backRate, sinceEnter, count: ev.length };
  }
}
