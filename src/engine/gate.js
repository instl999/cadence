/**
 * Typing-to-stem gain gate.
 *
 * Typing speed controls reveal duration rather than stem count. Faster typing
 * keeps the current stems open longer until the original mix is nearly restored.
 *
 * Every key extends the open-until time. A single key creates a short reveal;
 * continuous typing joins the windows, and stopping produces a natural release.
 */
export class Gate {
  constructor(opts = {}) {
    /**
     * Express the window as a multiple of the user's normal inter-key interval.
     *
     * A fixed 0.14-second window would require seven keys per second to remain
     * continuous, excluding ordinary writing speeds.
     *
     * With a relative window, normal typing stays continuous while clearly slower
     * input becomes intermittent, regardless of the user's baseline speed.
     */
    this.refRate = opts.refRate ?? 3.2;          // Calibrated baseline keys per second.
    this.winMin = opts.winMin ?? 1.05;           // Baseline interval multiplier.
    this.winMax = opts.winMax ?? 1.45;
    this.attack = opts.attack ?? 0.028;          // Fast attack keeps input responsive.
    this.release = opts.release ?? 0.11;         // 3 tau is about a 330 ms fade.
    this.value = 0;
    this.sustain = 0;                            // Sustained engagement, 0..1.
    this.holdUntil = 0;
  }

  /** Typical inter-key interval in seconds. */
  get refIki() { return 1 / Math.max(0.5, this.refRate); }

  /** Register a key press; overlapping windows merge naturally. */
  strike(now) {
    const k = this.winMin + this.sustain * (this.winMax - this.winMin);
    const win = Math.min(0.95, Math.max(0.12, this.refIki * k));
    this.holdUntil = Math.max(this.holdUntil, now + win);
  }

  /** @param rate Current typing rate in keys per second. */
  update(now, dt, rate) {
    // Treat the user's own baseline speed as full drive.
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
 * Mixing strategy.
 *
 * Final sound = background * background gain + foreground * typing activity +
 * a quiet touch transient. The background ducks by about 2.5 dB as the
 * foreground rises, keeping overall loudness stable.
 */
/**
 * A mode names only the stems that typing reveals. Everything else the track
 * has becomes background, so a four-stem Demucs set and a two-stem UVR pair
 * both work without listing every combination here.
 */
export const MODES = {
  vocal: {
    label: 'Vocals',
    short: 'Vocals',
    hint: 'The backing plays on its own. Typing reveals the original vocals.',
    foreground: ['vocals'],
  },
  instrument: {
    label: 'Instruments',
    short: 'Other',
    hint: 'Rhythm and vocals keep playing. Typing restores melodic instruments.',
    foreground: ['other'],
  },
  drums: {
    label: 'Drums',
    short: 'Drums',
    hint: 'The track starts without drums. Typing brings the beat back in.',
    foreground: ['drums'],
  },
  bass: {
    label: 'Bass',
    short: 'Bass',
    hint: 'The track starts without bass. Typing brings the low end back in.',
    foreground: ['bass'],
  },
};

/**
 * The stem that holds a steady level no matter what the typist does, so the
 * track always keeps a foundation. It is only gated when it is itself the
 * stem the listener chose to reveal.
 */
export const ANCHOR_ROLE = 'bass';

/** Which foreground roles a mode can actually drive on this stem set. */
export function foregroundRoles(mode, roles) {
  return (MODES[mode]?.foreground ?? []).filter((r) => roles.includes(r));
}

/** A mode needs a foreground stem to reveal and at least one other to reveal against. */
export function modeAvailable(mode, roles) {
  const fg = foregroundRoles(mode, roles);
  return fg.length > 0 && roles.some((r) => !fg.includes(r));
}

/** Every mode this stem set supports, in menu order. */
export function availableModes(roles) {
  return Object.keys(MODES).filter((mode) => modeAvailable(mode, roles));
}

export class Mixer {
  constructor(deck) {
    this.deck = deck;
    this.gate = new Gate();
    this.accent = new Gate({ winMin: 1.6, winMax: 1.6, attack: 0.01, release: 0.5 });
    this.mode = 'vocal';
    this.bgLevel = 0.85;
    this.fgLevel = 1.0;
    this.duck = 0.25;          // Background reaches 75 percent at full foreground.
    this.FG_CAP = 2;           // Maximum simultaneous foreground stems.
    this.anchor = ANCHOR_ROLE; // Never ducked, so the track keeps its foundation.
  }

  /** Set the user's baseline typing rate for both gates. */
  setRefRate(rate) {
    this.gate.refRate = rate;
    this.accent.refRate = rate;
  }

  setMode(mode) {
    this.mode = mode;
    // Reset every stem; the next update rebuilds the mix.
    for (const r of this.deck.roles) this.deck.setGain(r, 0, 0.15);
  }

  strike(now, kind) {
    this.gate.strike(now);
    // Space and Enter mark boundaries and receive a stronger accent.
    if (kind === 'space' || kind === 'enter') this.accent.strike(now);
  }

  update(now, dt, rate) {
    const fg = this.gate.update(now, dt, rate);
    const ac = this.accent.update(now, dt, rate);
    const roles = this.deck.roles;

    // Everything the mode does not reveal is background, whatever the stem set.
    const fgRoles = foregroundRoles(this.mode, roles).slice(0, this.FG_CAP);
    const bgRoles = roles.filter((r) => !fgRoles.includes(r));

    // Duck the background as the foreground opens, but hold the anchor steady:
    // it plays at a constant level whether or not anyone is typing.
    const bg = this.bgLevel * (1 - this.duck * fg);
    for (const r of bgRoles) {
      this.deck.setGain(r, r === this.anchor ? this.bgLevel : bg, 0.12);
    }
    for (const r of fgRoles) this.deck.setGain(r, this.fgLevel * fg, fg > 0.5 ? 0.03 : 0.18);

    // Briefly lift background drums for Space or Enter accents.
    if (bgRoles.includes('drums') && this.anchor !== 'drums' && ac > 0.01) {
      this.deck.setGain('drums', bg * (1 + 0.45 * ac), 0.05);
    }
    return { fg, ac, fgRoles, bgRoles };
  }
}
