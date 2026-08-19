import * as Tone from 'tone';
import { SplendidGrandPiano, Reverb } from 'smplr';

/**
 * 音源层。首选 smplr 的采样钢琴（音质对古典钢琴很关键），
 * 加载失败（离线 / CDN 不通）时回退到合成器，保证应用永远能出声。
 */
export class Piano {
  constructor() {
    this.ready = false;
    this.mode = 'loading';
    this.ctx = null;
    this.sampler = null;
    this.synth = null;
    this._pedal = false;
    this._sustained = [];
  }

  async init(onStatus = () => {}) {
    if (this.ready) {
      await Tone.start();
      return;
    }
    await Tone.start();
    // Tone 的 rawContext 是 standardized-audio-context 的包装层，不是原生 BaseAudioContext；
    // smplr 的 AudioWorklet 必须拿到底下的原生 context。两者共用同一时钟，调度不受影响。
    const wrapped = Tone.getContext().rawContext;
    const ctx = wrapped._nativeAudioContext ?? wrapped._nativeContext ?? wrapped;
    this.ctx = ctx;

    // 先把回退合成器建好——它是同步可用的，采样还没到就用它顶上
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.004, decay: 1.6, sustain: 0.06, release: 1.4 },
      volume: -10,
    });
    const verb = new Tone.Reverb({ decay: 2.4, wet: 0.22 }).toDestination();
    this.synth.connect(verb);
    this.mode = 'synth';
    this.ready = true;
    onStatus('synth');

    // 采样钢琴在后台升级。界面无需等 CDN 和 AudioWorklet，合成器已经可以立刻响应。
    this._samplerPromise = this._loadSampler(ctx, onStatus);
  }

  async _loadSampler(ctx, onStatus) {
    try {
      const piano = new SplendidGrandPiano(ctx, { volume: 100 });
      await Promise.race([
        piano.load,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
      ]);
      // 混响用 AudioWorklet，某些环境会拒；失败了不影响钢琴本体
      try {
        const reverb = new Reverb(ctx);
        await reverb.ready();
        piano.output.addEffect('reverb', reverb, 0.16);
      } catch (e) {
        console.warn('[piano] 混响不可用，干声播放:', e.message);
      }
      this.sampler = piano;
      this.mode = 'sampler';
      onStatus('sampler');
    } catch (err) {
      console.warn('[piano] 采样加载失败，继续使用合成器:', err.message);
      onStatus('synth-fallback');
    }
  }

  /** @param time AudioContext 绝对时间（秒）; velocity 0..1 */
  note(midi, time, duration, velocity) {
    const v = Math.min(1, Math.max(0.02, velocity));
    // 踏板：延长实际发声时长，但不改变乐谱时值
    const dur = this._pedal ? Math.max(duration, 2.2) : duration;
    if (this.sampler) {
      this.sampler.start({ note: midi, time, duration: dur, velocity: Math.round(v * 127) });
    } else if (this.synth) {
      try {
        this.synth.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), dur, time, v);
      } catch { /* 极端调度抖动时忽略 */ }
    }
  }

  /**
   * 击键触发的音必须用这个时间，不能用 Tone.now()。
   * Tone.now() = currentTime + lookAhead，而 lookAhead 默认是 100ms——
   * 对预排的乐谱这是必要的缓冲，但加在击键响应上就直接把
   * 「我按了键」和「听到声音」推出了因果感知窗口。实测总延迟 163ms。
   */
  immediate() { return (this.ctx?.currentTime ?? 0) + 0.003; }

  setPedal(on) { this._pedal = on; }

  allOff() {
    if (this.sampler) this.sampler.stop();
    if (this.synth) this.synth.releaseAll();
  }
}
