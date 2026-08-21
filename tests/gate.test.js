import test from 'node:test';
import assert from 'node:assert/strict';
import { Gate, Mixer, modeAvailable, availableModes, MODES, ANCHOR_ROLE } from '../src/engine/gate.js';

const DEMUCS = ['vocals', 'drums', 'bass', 'other'];

test('a mode needs both a foreground and something to reveal against', () => {
  assert.equal(modeAvailable('vocal', ['vocals', 'instrumental']), true);
  assert.equal(modeAvailable('vocal', ['vocals']), false, 'no background to reveal against');
  assert.equal(modeAvailable('vocal', ['instrumental']), false, 'nothing to reveal');
  assert.equal(modeAvailable('drums', ['drums', 'bass']), true);
  assert.equal(modeAvailable('nonsense', ['vocals', 'instrumental']), false);
});

test('a four-stem Demucs split offers every stem as a choice', () => {
  assert.deepEqual(availableModes(DEMUCS).sort(), ['bass', 'drums', 'instrument', 'vocal']);
});

test('a two-stem UVR pair offers only the vocal reveal', () => {
  assert.deepEqual(availableModes(['vocals', 'instrumental']), ['vocal']);
});

test('a single stem offers no choice at all', () => {
  assert.deepEqual(availableModes(['vocals']), []);
});

test('every mode names at least one foreground role', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.ok(mode.foreground.length > 0, `${name} reveals nothing`);
    assert.ok(mode.label && mode.hint, `${name} is missing display copy`);
  }
});

test('a gate opens quickly after a strike', () => {
  const gate = new Gate();
  gate.strike(0);
  let value = 0;
  for (let t = 0; t < 0.1; t += 1 / 60) value = gate.update(t, 1 / 60, 4);
  assert.ok(value > 0.8, `expected a fast attack, got ${value}`);
});

test('a gate releases to silence once the hold window passes', () => {
  const gate = new Gate();
  gate.strike(0);
  for (let t = 0; t < 0.2; t += 1 / 60) gate.update(t, 1 / 60, 4);

  let value = 1;
  for (let t = 0.2; t < 2.5; t += 1 / 60) value = gate.update(t, 1 / 60, 0);
  assert.equal(value, 0, 'the gate should snap to exactly zero once negligible');
});

test('continuous typing keeps the gate open across strikes', () => {
  const gate = new Gate();
  const step = 1 / 60;
  const keyInterval = 0.25;   // Four keys a second, above the 3.2 baseline.
  let nextKey = 0;
  let value = 0;
  for (let t = 0; t < 3; t += step) {
    if (t >= nextKey) { gate.strike(t); nextKey += keyInterval; }
    value = gate.update(t, step, 4);
    if (t > 0.5) assert.ok(value > 0.5, `gate dipped to ${value} at t=${t}`);
  }
  assert.ok(value > 0.5);
});

test('the hold window scales with the baseline rate, not a fixed duration', () => {
  const fast = new Gate({ refRate: 8 });
  const slow = new Gate({ refRate: 1.5 });
  fast.strike(0);
  slow.strike(0);
  assert.ok(slow.holdUntil > fast.holdUntil,
    'a slower typist needs a longer window to stay continuous');
});

test('the gate never exceeds one or falls below zero', () => {
  const gate = new Gate();
  for (let t = 0; t < 5; t += 1 / 60) {
    gate.strike(t);
    const value = gate.update(t, 1 / 60, 20);
    assert.ok(value >= 0 && value <= 1, `value ${value} out of range`);
  }
});

/** Minimal deck stand-in that records the gains the mixer requests. */
function fakeDeck(roles) {
  return {
    roles,
    gains: {},
    setGain(role, value) { this.gains[role] = value; },
  };
}

test('the mixer opens the foreground and ducks the background', () => {
  const deck = fakeDeck(['vocals', 'instrumental']);
  const mixer = new Mixer(deck);
  mixer.setMode('vocal');

  // Silence: the background carries the track alone.
  mixer.update(0, 1 / 15, 0);
  assert.equal(deck.gains.vocals, 0);
  assert.ok(deck.gains.instrumental > 0.8);

  const quietBackground = deck.gains.instrumental;
  for (let t = 0; t < 1; t += 1 / 15) {
    mixer.strike(t, 'char');
    mixer.update(t, 1 / 15, 4);
  }
  assert.ok(deck.gains.vocals > 0.8, 'typing should reveal the vocal stem');
  assert.ok(deck.gains.instrumental < quietBackground, 'the background should duck');
});

test('the mixer only touches roles the deck actually has', () => {
  const deck = fakeDeck(['vocals', 'instrumental']);
  const mixer = new Mixer(deck);
  mixer.setMode('vocal');
  mixer.update(0, 1 / 15, 2);
  assert.deepEqual(Object.keys(deck.gains).sort(), ['instrumental', 'vocals']);
});

test('on a four-stem split, only the chosen stem is gated', () => {
  const deck = fakeDeck(DEMUCS);
  const mixer = new Mixer(deck);
  mixer.setMode('vocal');

  mixer.update(0, 1 / 15, 0);
  assert.equal(deck.gains.vocals, 0, 'the chosen stem waits for typing');
  for (const role of ['drums', 'bass', 'other']) {
    assert.ok(deck.gains[role] > 0, `${role} should keep playing untouched`);
  }
});

test('bass holds a steady level while other background stems duck', () => {
  const deck = fakeDeck(DEMUCS);
  const mixer = new Mixer(deck);
  mixer.setMode('vocal');

  mixer.update(0, 1 / 15, 0);
  const restingBass = deck.gains[ANCHOR_ROLE];
  const restingDrums = deck.gains.drums;

  for (let t = 0; t < 1; t += 1 / 15) {
    mixer.strike(t, 'char');
    mixer.update(t, 1 / 15, 4);
  }
  assert.ok(deck.gains.vocals > 0.8, 'typing should reveal the chosen stem');
  assert.equal(deck.gains[ANCHOR_ROLE], restingBass, 'bass must not duck');
  assert.ok(deck.gains.drums < restingDrums, 'the rest of the bed should duck');
});

test('choosing bass gates bass and leaves the rest playing', () => {
  const deck = fakeDeck(DEMUCS);
  const mixer = new Mixer(deck);
  mixer.setMode('bass');

  mixer.update(0, 1 / 15, 0);
  assert.equal(deck.gains.bass, 0, 'the chosen stem is the one that waits');
  for (const role of ['vocals', 'drums', 'other']) {
    assert.ok(deck.gains[role] > 0, `${role} should keep playing`);
  }

  for (let t = 0; t < 1; t += 1 / 15) {
    mixer.strike(t, 'char');
    mixer.update(t, 1 / 15, 4);
  }
  assert.ok(deck.gains.bass > 0.8, 'typing should bring the low end in');
});

test('every stem the deck has is either revealed or kept playing', () => {
  const deck = fakeDeck(DEMUCS);
  const mixer = new Mixer(deck);
  for (const mode of availableModes(DEMUCS)) {
    deck.gains = {};
    mixer.setMode(mode);
    const { fgRoles, bgRoles } = mixer.update(0, 1 / 15, 0);
    assert.deepEqual([...fgRoles, ...bgRoles].sort(), [...DEMUCS].sort(),
      `${mode} left a stem unaccounted for`);
    assert.deepEqual(fgRoles.filter((r) => bgRoles.includes(r)), [],
      `${mode} put a stem on both sides`);
  }
});

test('setting the reference rate reaches both gates', () => {
  const mixer = new Mixer(fakeDeck(['vocals', 'instrumental']));
  mixer.setRefRate(6.5);
  assert.equal(mixer.gate.refRate, 6.5);
  assert.equal(mixer.accent.refRate, 6.5);
});
