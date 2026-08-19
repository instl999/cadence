import * as Tone from 'tone';
import { gate } from './analyze.js';

/**
 * 播放引擎。两种模式共用同一份乐谱数据。
 *
 * ambient（氛围模式，日常主力）
 *   曲子有自己的时钟，你停手它也不会死。打字只在 10–30 秒尺度上
 *   影响密度/力度/速度，而且密度与速度**只在小节线上生效**。
 *   你感觉不到它在跟你，但停下来会发现音乐确实变了。
 *
 * hybrid（跟手模式，默认）
 *   乐谱劈成两半：骨架（低音线+旋律主干）由时钟播放，保证歌不会断；
 *   装饰（内声部、经过音、加花）**只由你的击键释放**。
 *   这是唯一能做出「跟手感」的结构——参数调制永远做不到，因为人脑判断因果
 *   需要 200ms 内的紧耦合，而密度/力度/速度都是几秒尺度的统计量。
 *
 * performance（演奏模式）
 *   每次击键把乐谱推进一个「起音组」。永远不会弹错音——音符全是原作者写的，
 *   你只控制什么时候发生。停手音乐就停在原地（踏板延音）。
 */
export class Player {
  constructor(piano, arranger) {
    this.piano = piano;
    this.arranger = arranger;
    this.mode = 'ambient';
    this.piece = null;
    this.part = null;
    this.onBar = () => {};
    this.onPieceEnd = () => {};
    this.onNote = () => {};
    this._cursor = 0;
    this._lastPerfTime = 0;
    this._barEvent = null;
    this._beatEvent = null;
    this._lastBpm = 0;
    this._masterGain = 1;
    this.playing = false;
  }

  load(piece) {
    this.stop();
    this.piece = piece;
    this._cursor = 0;
    this._buildPools(piece);
    const t = Tone.getTransport();
    t.bpm.value = piece.bpm;
    t.timeSignature = piece.timeSignature;
    return this;
  }

  /**
   * 按显著度把音符切成骨架 / 装饰，装饰音再按拍装进池子。
   * 击键时只从「当前这一拍」的池子里取音，所以放出来的音一定和
   * 此刻正在响的和声相容——不会弹错。
   */
  _buildPools(piece) {
    // 骨架比例按「每秒音符数」自适应，不能用固定比例：
    // 巴赫是 4.4 音/秒，一份实录流行曲可能是 105 音/秒，
    // 同一个比例在后者身上会让「骨架」变成每秒 40 个音，根本不成其为骨架。
    const TARGET_RATE = 7;
    const frac = Math.min(0.65, Math.max(0.06,
      (TARGET_RATE * piece.duration) / piece.noteCount));
    const cut = 1 - frac;

    this.skeleton = piece.notes.filter((n) => n.rank >= cut);
    this.ornaments = piece.notes.filter((n) => n.rank < cut);
    this.skeletonRate = +(this.skeleton.length / piece.duration).toFixed(1);

    this.pools = new Map();
    for (const nt of this.ornaments) {
      const b = Math.floor(nt.time / piece.beat);
      if (!this.pools.has(b)) this.pools.set(b, []);
      this.pools.get(b).push(nt);
    }
    // 按显著度降序：第一次击键放出这一拍里最好听的那个装饰音，
    // 之后依次往下。按音高排的话会一直放最低最浑的内声部。
    // 排序权重再叠一层音区：加花该落在中高音区，
    // 低音属于骨架，被当装饰随机放出来只会让织体变浑。
    const w = (n) => n.salience
      + (n.midi >= 58 && n.midi <= 92 ? 0.25 : 0)
      - (n.midi < 45 ? 0.35 : 0);
    for (const arr of this.pools.values()) arr.sort((a, b) => w(b) - w(a));
    this._poolIdx = 0;
    this._lastBeat = -1;
    this._loopLen = piece.duration + piece.barLen;
  }

  /** 跟手模式：一次击键释放一个装饰音 */
  strike() {
    if (this.mode !== 'hybrid' || !this.piece) return;
    const now = this.piano.immediate();            // 绕开 Tone 的 100ms lookAhead
    if (now - this._lastPerfTime < 0.045) return;  // 防连打机关枪
    this._lastPerfTime = now;

    // 用 ticks/PPQ 算已过拍数，而不是 seconds。
    // Part 按 tick 排程，一旦变速 seconds 和乐谱时间就不再 1:1，拍号会错位。
    const t = Tone.getTransport();
    const totalBeats = Math.max(1, Math.round(this._loopLen / this.piece.beat));
    const beat = Math.floor((t.ticks / t.PPQ) % totalBeats);
    let pool = this.pools.get(beat);
    // 这一拍没有装饰音就顺延找最近的下一拍，避免击键落空
    for (let k = 1; k <= 4 && (!pool || !pool.length); k++) pool = this.pools.get(beat - k);
    if (!pool || !pool.length) return;

    if (beat !== this._lastBeat) { this._lastBeat = beat; this._poolIdx = 0; }
    const nt = pool[this._poolIdx % pool.length];
    this._poolIdx++;

    const vel = Math.min(1, nt.vel * (0.5 + this.arranger.velocity * 0.9)) * this._masterGain;
    this.piano.note(nt.midi, now, Math.max(nt.dur, 0.22), vel);
    this.onNote(nt, now);
  }

  start() {
    if (!this.piece) return;
    const t = Tone.getTransport();
    if (this.part && (this.mode === 'ambient' || this.mode === 'hybrid')) {
      t.start();
      this.playing = true;
      return;
    }
    if (this.mode === 'ambient' || this.mode === 'hybrid') {
      this._buildPart();
      t.start();
    } else {
      // 演奏模式下 Transport 不推进乐谱，只用来打小节线
      t.start();
    }
    // 速度按小节落地，密度按拍落地。
    // 原来密度也压在小节线上（60BPM 时 4 秒一次），是「没反应」的主因之一。
    this._barEvent = t.scheduleRepeat(() => { this.onBar(this.arranger.commitBar()); }, '1m');
    this._beatEvent = t.scheduleRepeat(() => { this.arranger.commitBeat(); }, '4n');
    this.playing = true;
  }

  pause() {
    if (!this.piece || !this.playing) return;
    Tone.getTransport().pause();
    this.piano.allOff();
    this.playing = false;
  }

  resume() {
    if (!this.piece) return;
    if (!this.part && this.mode !== 'performance') this.start();
    else {
      Tone.getTransport().start();
      this.playing = true;
    }
  }

  get position() { return this.piece ? Tone.getTransport().seconds : 0; }
  get duration() { return this.piece?.duration ?? 0; }

  _buildPart() {
    if (this.part) { this.part.dispose(); this.part = null; }
    const piece = this.piece;

    // 一次性把全曲音符排进 Part。是否真正发声由回调里的实时密度决定，
    // 这样密度变化立刻生效，不需要重排。
    // 氛围模式也要限流：一份实录流行曲有 105 音/秒，
    // 全放出去就是噪音，密度调节在饱和区完全失去区分度。
    const AMBIENT_MAX_RATE = 16;
    const ambientCut = 1 - Math.min(1, (AMBIENT_MAX_RATE * piece.duration) / piece.noteCount);
    const clockNotes = this.mode === 'hybrid'
      ? this.skeleton
      : piece.notes.filter((n) => n.rank >= ambientCut);
    this.part = new Tone.Part((time, nt) => {
      // 门控：rank 低于当前密度阈值的音符直接跳过
      if (nt.rank < 1 - this.arranger.density) return;
      // 力度范围从原来的 0.72~1.16 拉到 0.28~1.5——原来全程只有 6% 波动，听不出来
      const vel = Math.min(1, nt.vel * (0.28 + this.arranger.velocity * 1.2)) * this._masterGain;
      if (vel < 0.03) return;
      const dur = nt.dur / this.arranger.tempoScale;
      this.piano.note(nt.midi, time, dur, vel);
      // 强度高时给旋律叠高八度：最容易被听出来的一档变化
      if (this.arranger.octaveDouble && nt.layer === 'melody' && nt.midi + 12 <= 96) {
        this.piano.note(nt.midi + 12, time, dur, vel * 0.42);
      }
      this.onNote(nt, time);
    }, clockNotes.map((n) => [n.time, n]));

    this.part.loop = true;
    this.part.loopEnd = piece.duration + piece.barLen;
    this.part.start(0);

    // 循环若干遍后换下一首
    Tone.getTransport().scheduleOnce(() => this.onPieceEnd(), `+${piece.duration * 2 + 2}`);
  }

  /** 演奏模式：一次击键 = 推进一个起音组 */
  advance() {
    if (this.mode !== 'performance' || !this.piece) return;
    const now = this.piano.immediate();  // 同样绕开 lookAhead
    // 防连打机关枪：最小间隔 55ms
    if (now - this._lastPerfTime < 0.055) return;
    this._lastPerfTime = now;

    const groups = this.piece.groups;
    const g = groups[this._cursor % groups.length];
    this._cursor++;
    if (this._cursor % groups.length === 0) this.onPieceEnd();

    const d = this.arranger.density;
    let notes = g.notes.filter((n) => n.rank >= 1 - Math.max(d, 0.5));
    if (!notes.length) notes = [g.notes[g.notes.length - 1]];

    for (const nt of notes) {
      const vel = Math.min(1, nt.vel * (0.6 + this.arranger.velocity * 0.6)) * this._masterGain;
      this.piano.note(nt.midi, now, Math.max(nt.dur, 0.6), vel);
      this.onNote(nt, now);
    }
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.stop();
    this.mode = mode;
    this.piano.setPedal(mode === 'performance');
    if (this.piece) this._buildPools(this.piece);
    this._cursor = 0;
    this.start();
  }

  setGain(g) { this._masterGain = g; }

  stop() {
    const t = Tone.getTransport();
    if (this._barEvent !== null) { t.clear(this._barEvent); this._barEvent = null; }
    if (this._beatEvent !== null) { t.clear(this._beatEvent); this._beatEvent = null; }
    if (this.part) { this.part.dispose(); this.part = null; }
    t.stop();
    t.cancel();
    t.position = 0;
    this.piano.allOff();
    this.playing = false;
  }

  /**
   * 打字状态驱动 Transport 速度。
   * 注意：每帧都调 rampTo 会不断取消并重发斜坡，速度永远到不了目标——
   * 必须等目标真正变了、且变化够大，才重新发一次。
   */
  syncTempo() {
    if (!this.piece) return;
    const target = this.piece.bpm * this.arranger.tempoScale;
    if (Math.abs(target - this._lastBpm) < 0.4) return;
    this._lastBpm = target;
    Tone.getTransport().bpm.rampTo(target, 2.5);
  }
}
