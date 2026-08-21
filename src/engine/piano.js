import * as Tone from 'tone';

/**
 * Sound-source layer. Prefer smplr's sampled piano, then fall back to a
 * synthesizer when offline or when the sample host is unavailable.
 */
export class Piano {
  constructor() {
    this.ready = false;
    this.mode = 'loading';
    this.ctx = null;
    this.sampler = null;
    this.synth = null;
    this._samplerPromise = null;
  }

  async init(onStatus = () => {}) {
    if (this.ready) {
      await Tone.start();
      return;
    }
    await Tone.start();
    // Tone wraps standardized-audio-context; smplr's AudioWorklet needs the
    // underlying native context. Both share one clock, so scheduling is stable.
    const wrapped = Tone.getContext().rawContext;
    const ctx = wrapped._nativeAudioContext ?? wrapped._nativeContext ?? wrapped;
    this.ctx = ctx;

    // Create the synchronous fallback synth before loading samples.
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
  }

  /**
   * Upgrade to the sampled piano, in the background, while the synth stays ready.
   *
   * Stem playback never sounds the piano, so pulling several megabytes of
   * samples from the smplr CDN on every Enable was wasted on the app's most
   * common path. Only the audio and MIDI engines ask for it.
   */
  ensureSampler(onStatus = () => {}) {
    if (!this.ctx) return Promise.resolve();
    this._samplerPromise ??= this._loadSampler(this.ctx, onStatus);
    return this._samplerPromise;
  }

  async _loadSampler(ctx, onStatus) {
    try {
      // Imported here so smplr stays out of the initial chunk.
      const { SplendidGrandPiano, Reverb } = await import('smplr');
      const piano = new SplendidGrandPiano(ctx, { volume: 100 });
      await Promise.race([
        piano.load,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 20000)),
      ]);
      // Reverb is optional because some environments reject its AudioWorklet.
      try {
        const reverb = new Reverb(ctx);
        await reverb.ready();
        piano.output.addEffect('reverb', reverb, 0.16);
      } catch (e) {
        console.warn('[piano] Reverb unavailable; using dry audio:', e.message);
      }
      this.sampler = piano;
      this.mode = 'sampler';
      onStatus('sampler');
    } catch (err) {
      console.warn('[piano] Sample loading failed; continuing with synth:', err.message);
      onStatus('synth-fallback');
    }
  }

  /** @param time Absolute AudioContext time in seconds; velocity is 0..1. */
  note(midi, time, duration, velocity) {
    const v = Math.min(1, Math.max(0.02, velocity));
    if (this.sampler) {
      this.sampler.start({ note: midi, time, duration, velocity: Math.round(v * 127) });
    } else if (this.synth) {
      try {
        this.synth.triggerAttackRelease(Tone.Frequency(midi, 'midi').toFrequency(), duration, time, v);
      } catch { /* Ignore rare scheduling jitter. */ }
    }
  }

  /**
   * Key-triggered notes use this time instead of Tone.now(). Tone.now() adds a
   * default 100 ms look-ahead, which helps prearranged scores but makes direct
   * interaction feel disconnected. A 3 ms offset avoids scheduling in the past.
   */
  immediate() { return (this.ctx?.currentTime ?? 0) + 0.003; }

  allOff() {
    if (this.sampler) this.sampler.stop();
    if (this.synth) this.synth.releaseAll();
  }
}
