/**
 * Typing sensor.
 *
 * Privacy contract (the project's most important design constraint):
 * this module exposes only { t, kind }, where kind is one of
 * { char, back, enter, space }. Specific characters and key codes never leave
 * this function, enter the music engine, persist to storage, or reach a network.
 *
 * This is both a privacy boundary and the musically correct choice: letters
 * have no musical meaning. The useful signal is the rhythm structure.
 */
export class TypingSensor {
  constructor({ window = 60 } = {}) {
    this.window = window;   // Event retention window, in seconds.
    this.events = [];       // [{t, kind}]; contains no key content.
    this.ikis = [];         // Long-term inter-key intervals for baseline speed.
  }

  /** Extract a timestamp and structural category, then discard the event. */
  ingest(e) {
    let kind;
    if (e.key === 'Backspace' || e.key === 'Delete') kind = 'back';
    else if (e.key === 'Enter') kind = 'enter';
    else if (e.key === ' ') kind = 'space';
    else if (e.key.length === 1) kind = 'char';
    else return; // Ignore arrows, modifiers, and function keys.
    this.push(kind);
  }

  push(kind) {
    const t = performance.now() / 1000;
    const prev = this.events[this.events.length - 1];
    // Keep burst intervals under one second; thinking pauses skew the baseline.
    if (prev && t - prev.t < 1) {
      this.ikis.push(t - prev.t);
      if (this.ikis.length > 400) this.ikis.shift();
    }
    this.events.push({ t, kind });
    // Evict in one splice rather than one shift per expired event.
    const cutoff = t - this.window;
    let expired = 0;
    while (expired < this.events.length && this.events[expired].t < cutoff) expired++;
    if (expired) this.events.splice(0, expired);
  }

  /**
   * Estimate the user's typical typing speed in keys per second.
   * features().rate is a five-second instantaneous value and approaches zero
   * during brief pauses, so it is unsuitable for calibration. The median burst
   * interval remains independent of the sampling moment.
   */
  typicalRate() {
    if (this.ikis.length < 20) return null;
    const med = [...this.ikis].sort((a, b) => a - b)[this.ikis.length >> 1];
    return med > 0 ? 1 / med : null;
  }

  /**
   * Return rhythm features derived only from timestamps.
   *
   * This runs 15 times a second, so it walks the already-sorted event buffer by
   * index instead of allocating filtered copies of it.
   */
  features(now = performance.now() / 1000) {
    const ev = this.events;
    const n = ev.length;
    const idle = n ? now - ev[n - 1].t : Infinity;

    // Find where the 5 s and 20 s windows begin. Events are time-ordered, so a
    // backwards walk touches only the events inside each window.
    let from5 = n;
    while (from5 > 0 && ev[from5 - 1].t > now - 5) from5--;
    let from20 = from5;
    while (from20 > 0 && ev[from20 - 1].t > now - 20) from20--;

    const rate = (n - from5) / 5;                      // Keys per second.

    // Inter-key variation: steady bursts are low; stop-and-think typing is high.
    // Accumulate sum and sum of squares so one pass yields the deviation.
    let sum = 0, sumSquares = 0, gaps = 0;
    for (let i = from5 + 1; i < n; i++) {
      const d = ev[i].t - ev[i - 1].t;
      sum += d; sumSquares += d * d; gaps++;
    }
    let cv = 1;
    if (gaps >= 3) {
      const mean = sum / gaps;
      const variance = Math.max(0, sumSquares / gaps - mean * mean);
      cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
    }

    // Backspace rate indicates hesitation or repeated editing.
    const window20 = n - from20;
    let backs = 0;
    for (let i = from20; i < n; i++) if (ev[i].kind === 'back') backs++;
    const backRate = window20 >= 8 ? backs / window20 : 0;

    return { idle, rate, cv, backRate, count: n };
  }
}
