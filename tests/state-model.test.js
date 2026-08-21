import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, Arranger, STATES } from '../src/engine/state-model.js';

const features = (over = {}) => ({ idle: 0, rate: 0, cv: 1, backRate: 0, count: 50, ...over });

test('no input at all reads as away', () => {
  assert.equal(classify(features({ count: 0 })), 'away');
});

test('a long silence reads as away, a short one as paused', () => {
  assert.equal(classify(features({ idle: 60 })), 'away');
  assert.equal(classify(features({ idle: 10 })), 'pause');
  assert.equal(classify(features({ idle: 3.5 })), 'pause');
});

test('heavy correction reads as struggling before anything else', () => {
  assert.equal(classify(features({ idle: 0.2, backRate: 0.4, rate: 6, cv: 0.2 })), 'struggling');
});

test('fast and even typing reads as flow', () => {
  assert.equal(classify(features({ idle: 0.2, rate: 4, cv: 0.5 })), 'flow');
});

test('fast but erratic typing is not flow', () => {
  assert.notEqual(classify(features({ idle: 0.2, rate: 4, cv: 1.5 })), 'flow');
});

test('anything else reads as thinking', () => {
  assert.equal(classify(features({ idle: 1, rate: 1, cv: 0.5 })), 'thinking');
});

test('every classified state has a definition', () => {
  const inputs = [
    features({ count: 0 }),
    features({ idle: 60 }),
    features({ idle: 5 }),
    features({ backRate: 0.5 }),
    features({ rate: 5, cv: 0.3 }),
    features({ rate: 1 }),
  ];
  for (const f of inputs) assert.ok(STATES[classify(f)], `missing state for ${classify(f)}`);
});

test('the arranger moves toward the target rather than jumping to it', () => {
  const arranger = new Arranger();
  const start = arranger.smooth.velocity;
  arranger.update(features({ rate: 6, cv: 0.3 }), 1 / 15);
  assert.notEqual(arranger.smooth.velocity, start);
  // One 66 ms tick must not cover the whole distance to the flow target.
  assert.ok(Math.abs(arranger.smooth.velocity - STATES.flow.velocity) > 0.05);
});

test('sustained flow input eventually converges near the flow target', () => {
  const arranger = new Arranger();
  for (let i = 0; i < 400; i++) arranger.update(features({ rate: 6, cv: 0.3 }), 1 / 15);
  assert.equal(arranger.state, 'flow');
  assert.ok(Math.abs(arranger.smooth.tempo - STATES.flow.tempo) < 0.02);
});

test('smoothed values stay inside their clamps under extreme input', () => {
  const arranger = new Arranger();
  for (let i = 0; i < 200; i++) arranger.update(features({ rate: 1000, cv: 0 }), 1);
  assert.ok(arranger.smooth.density <= 1 && arranger.smooth.density >= 0.1);
  assert.ok(arranger.smooth.velocity <= 1.35 && arranger.smooth.velocity >= 0.15);
});

test('octave doubling has hysteresis so it cannot flutter at the threshold', () => {
  const arranger = new Arranger();
  arranger.intensity = 0.7;
  assert.equal(arranger.octaveDouble, true);
  // Between the two thresholds the previous decision must hold.
  arranger.intensity = 0.55;
  assert.equal(arranger.octaveDouble, true);
  arranger.intensity = 0.4;
  assert.equal(arranger.octaveDouble, false);
  arranger.intensity = 0.55;
  assert.equal(arranger.octaveDouble, false);
});

test('density and tempo are committed on musical boundaries, not continuously', () => {
  const arranger = new Arranger();
  for (let i = 0; i < 60; i++) arranger.update(features({ rate: 6, cv: 0.3 }), 1 / 15);
  const beforeDensity = arranger.density;
  assert.equal(beforeDensity, arranger.applied.density);
  arranger.commitBeat();
  assert.equal(arranger.density, arranger.smooth.density);
  arranger.commitBar();
  assert.equal(arranger.tempoScale, arranger.smooth.tempo);
});
