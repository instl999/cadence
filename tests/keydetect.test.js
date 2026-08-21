import test from 'node:test';
import assert from 'node:assert/strict';
import { fft, detectKey, pentatonicPool, ANALYSIS_RATE } from '../src/engine/keydetect.js';

/** Reference DFT, used only to prove the fast transform agrees with it. */
function naiveDft(input) {
  const n = input.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const angle = (-2 * Math.PI * k * t) / n;
      re[k] += input[t] * Math.cos(angle);
      im[k] += input[t] * Math.sin(angle);
    }
  }
  return { re, im };
}

test('fft agrees with a direct DFT', () => {
  const n = 64;
  const signal = Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + 0.3 * Math.cos(i * 2.1));
  const expected = naiveDft(signal);

  const re = Float64Array.from(signal);
  const im = new Float64Array(n);
  fft(re, im);

  for (let k = 0; k < n; k++) {
    assert.ok(Math.abs(re[k] - expected.re[k]) < 1e-9, `real bin ${k}`);
    assert.ok(Math.abs(im[k] - expected.im[k]) < 1e-9, `imaginary bin ${k}`);
  }
});

test('fft of a pure tone puts its energy in the matching bin', () => {
  const n = 256;
  const bin = 8;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
  fft(re, im);

  const magnitude = (k) => Math.hypot(re[k], im[k]);
  for (let k = 1; k < n / 2; k++) {
    if (k === bin) continue;
    assert.ok(magnitude(k) < magnitude(bin) / 100, `bin ${k} should be quiet`);
  }
});

/** Sum of sine partials for each pitch, at the analysis rate. */
function synthesize(midiNotes, seconds = 6) {
  const length = Math.floor(ANALYSIS_RATE * seconds);
  const samples = new Float32Array(length);
  for (const midi of midiNotes) {
    const freq = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < length; i++) {
      const t = i / ANALYSIS_RATE;
      samples[i] += 0.3 * Math.sin(2 * Math.PI * freq * t)
        + 0.1 * Math.sin(2 * Math.PI * freq * 2 * t);
    }
  }
  return { sampleRate: ANALYSIS_RATE, samples };
}

test('a C major triad is detected as C major', () => {
  // C4, E4, G4
  const key = detectKey(synthesize([60, 64, 67]));
  assert.equal(key.name, 'C major');
  assert.equal(key.tonic, 0);
  assert.equal(key.mode, 'major');
  assert.ok(key.confidence > 0.4, `confidence was ${key.confidence}`);
});

test('an A minor triad is detected as A minor', () => {
  // A3, C4, E4
  const key = detectKey(synthesize([57, 60, 64]));
  assert.equal(key.name, 'A minor');
  assert.equal(key.tonic, 9);
  assert.equal(key.mode, 'minor');
});

test('transposing the input transposes the detected tonic', () => {
  const c = detectKey(synthesize([60, 64, 67]));
  const d = detectKey(synthesize([62, 66, 69]));
  assert.equal(d.tonic, (c.tonic + 2) % 12);
  assert.equal(d.mode, 'major');
});

test('silence returns a result instead of dividing by zero', () => {
  const key = detectKey({ sampleRate: ANALYSIS_RATE, samples: new Float32Array(ANALYSIS_RATE * 2) });
  assert.ok(Number.isFinite(key.tonic));
  assert.ok(Number.isFinite(key.confidence));
});

test('input shorter than one analysis frame does not throw', () => {
  const key = detectKey({ sampleRate: ANALYSIS_RATE, samples: new Float32Array(100) });
  assert.ok(Number.isFinite(key.tonic));
});

test('an AudioBuffer-shaped input is accepted directly', () => {
  const { samples } = synthesize([60, 64, 67], 3);
  const key = detectKey({ sampleRate: ANALYSIS_RATE, getChannelData: () => samples });
  assert.equal(key.name, 'C major');
});

const pitchClasses = (pool) => [...new Set(pool.map((m) => m % 12))].sort((a, b) => a - b);

test('the pentatonic pool holds only in-key pitch classes', () => {
  // C major pentatonic: C D E G A.
  assert.deepEqual(pitchClasses(pentatonicPool(0, 'major', 60, 84)), [0, 2, 4, 7, 9]);
  // A minor pentatonic is the same set of pitch classes.
  assert.deepEqual(pitchClasses(pentatonicPool(9, 'minor', 57, 81)), [0, 2, 4, 7, 9]);
  // G major pentatonic: G A B D E.
  assert.deepEqual(pitchClasses(pentatonicPool(7, 'major', 55, 79)), [0, 2, 4, 7, 9].map((pc) => (pc + 7) % 12).sort((a, b) => a - b));
});

test('the pentatonic pool stays inside the requested range', () => {
  const pool = pentatonicPool(0, 'major', 55, 91);
  assert.ok(pool.every((m) => m >= 55 && m <= 91));
  assert.ok(pool.length > 0);
});
