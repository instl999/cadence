/**
 * Infer an engagement state from rhythm features and map it to musical values.
 *
 * Design principles:
 * 1. Flow avoids structural disruption, while loudness and texture still respond.
 * 2. High backspace rates simplify and quiet the music rather than adding tension.
 * 3. Idle is not silent; typing grows the music from a persistent base texture.
 */

// At sensitivity zero, every state converges on this neutral point.
const NEUTRAL = { density: 0.58, velocity: 0.72, tempo: 1.0 };

export const STATES = {
  flow:       { label: 'Flow', density: 0.82, velocity: 1.00, tempo: 1.20, hold: true },
  thinking:   { label: 'Thinking', density: 0.68, velocity: 0.70, tempo: 0.99, hold: false },
  struggling: { label: 'Struggling', density: 0.40, velocity: 0.50, tempo: 0.84, hold: false },
  pause:      { label: 'Paused', density: 0.46, velocity: 0.55, tempo: 0.92, hold: false },
  away:       { label: 'Away', density: 0.34, velocity: 0.42, tempo: 0.82, hold: false },
};

export function classify(f) {
  if (f.count === 0 || f.idle > 45) return 'away';
  if (f.idle > 3) return 'pause';
  if (f.backRate > 0.18) return 'struggling';
  if (f.rate > 2.0 && f.cv < 1.0) return 'flow';  // Allow margin above measured CV.
  return 'thinking';
}

const lerp = (a, b, t) => a + (b - a) * t;

export class Arranger {
  constructor() {
    this.state = 'away';
    this.sens = 1;                 // Sensitivity: 0 is neutral; 1.6 is exaggerated.
    this.smooth = { density: 0.4, velocity: 0.5, tempo: 0.9 };
    this.applied = { density: 0.4, tempo: 0.9 };
    this.intensity = 0;            // Fast component for direct responsiveness.
  }

  update(features, dt) {
    const s = this.sens;
    this.state = classify(features);
    const raw = STATES[this.state];

    // Sensitivity contracts state targets toward neutral or expands them outward.
    const target = {
      density: lerp(NEUTRAL.density, raw.density, s),
      velocity: lerp(NEUTRAL.velocity, raw.velocity, s),
      tempo: lerp(NEUTRAL.tempo, raw.tempo, s),
    };

    // Scale time constants with sensitivity for perceptible response.
    const speed = 0.5 + 0.5 * s;
    const k = (tau) => 1 - Math.exp(-dt / (tau / speed));

    // A 0.8-second intensity component follows typing rate directly, while the
    // slower state machine controls the broader atmosphere.
    const drive = Math.min(1, features.rate / 5.5);
    this.intensity += (drive - this.intensity) * k(0.8);

    this.smooth.density += (target.density + this.intensity * 0.14 * s - this.smooth.density) * k(raw.hold ? 4 : 2.5);
    this.smooth.velocity += (target.velocity + this.intensity * 0.22 * s - this.smooth.velocity) * k(1.0);
    this.smooth.tempo += (target.tempo - this.smooth.tempo) * k(5);

    this.smooth.density = Math.min(1, Math.max(0.1, this.smooth.density));
    this.smooth.velocity = Math.min(1.35, Math.max(0.15, this.smooth.velocity));
    return this.state;
  }

  /** Commit density on beats; smoothing prevents key-by-key jitter. */
  commitBeat() { this.applied.density = this.smooth.density; return this.applied; }
  /** Commit tempo on bars because mid-bar changes are more disruptive. */
  commitBar() { this.applied.tempo = this.smooth.tempo; return this.applied; }

  get density() { return this.applied.density; }
  get tempoScale() { return this.applied.tempo; }
  get velocity() { return this.smooth.velocity; }
  /**
   * Double the melody at the octave during high intensity. Hysteresis prevents
   * rapid toggling when intensity hovers near the threshold.
   */
  get octaveDouble() {
    if (this.sens <= 0.3) return (this._oct = false);
    if (this.intensity > 0.66) this._oct = true;
    else if (this.intensity < 0.50) this._oct = false;
    return !!this._oct;
  }
}
