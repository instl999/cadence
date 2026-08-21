import test from 'node:test';
import assert from 'node:assert/strict';
import { TypingSensor } from '../src/engine/typing-sensor.js';

/** Seed the buffer directly so features() can be measured against a known clock. */
function seed(events) {
  const sensor = new TypingSensor();
  sensor.events = events.map(([t, kind = 'char']) => ({ t, kind }));
  return sensor;
}

test('rate counts only the last five seconds', () => {
  // Ten keys inside the window, ten well outside it.
  const old = Array.from({ length: 10 }, (_, i) => [i * 0.1]);
  const recent = Array.from({ length: 10 }, (_, i) => [96 + i * 0.1]);
  const sensor = seed([...old, ...recent]);
  assert.equal(sensor.features(100).rate, 2);   // 10 keys / 5 s
});

test('idle measures the gap since the last key', () => {
  const sensor = seed([[10], [12]]);
  assert.equal(sensor.features(15).idle, 3);
});

test('an empty buffer is infinitely idle and rates at zero', () => {
  const sensor = seed([]);
  const f = sensor.features(100);
  assert.equal(f.idle, Infinity);
  assert.equal(f.rate, 0);
  assert.equal(f.count, 0);
  assert.equal(f.backRate, 0);
});

test('even typing gives a low coefficient of variation', () => {
  const sensor = seed(Array.from({ length: 20 }, (_, i) => [95 + i * 0.2]));
  assert.ok(sensor.features(99.2).cv < 0.05, 'metronomic input should be near zero');
});

test('stop-and-start typing gives a high coefficient of variation', () => {
  const times = [95, 95.05, 95.1, 95.15, 96.8, 96.85, 98.4, 98.45, 98.5];
  const sensor = seed(times.map((t) => [t]));
  assert.ok(sensor.features(98.6).cv > 0.8, 'bursty input should vary widely');
});

test('the coefficient of variation needs enough gaps to be meaningful', () => {
  const sensor = seed([[99.8], [99.9]]);
  assert.equal(sensor.features(100).cv, 1, 'too few samples falls back to neutral');
});

test('backspace rate is measured over twenty seconds', () => {
  const events = [];
  for (let i = 0; i < 20; i++) events.push([85 + i * 0.5, i % 4 === 0 ? 'back' : 'char']);
  const sensor = seed(events);
  assert.ok(Math.abs(sensor.features(95).backRate - 0.25) < 1e-9);
});

test('backspace rate stays at zero below the sample threshold', () => {
  const sensor = seed([[99, 'back'], [99.2, 'back'], [99.4, 'char']]);
  assert.equal(sensor.features(100).backRate, 0, 'under eight events is not a signal');
});

test('features allocates no view of the buffer it was given', () => {
  const sensor = seed(Array.from({ length: 100 }, (_, i) => [i * 0.5]));
  const before = sensor.events;
  sensor.features(50);
  assert.equal(sensor.events, before, 'the event buffer must not be replaced');
  assert.equal(sensor.events.length, 100, 'the event buffer must not be mutated');
});

test('the reported count is the whole retained buffer', () => {
  const sensor = seed(Array.from({ length: 42 }, (_, i) => [i * 0.1]));
  assert.equal(sensor.features(100).count, 42);
});

test('typical rate needs a baseline before it will answer', () => {
  const sensor = new TypingSensor();
  sensor.ikis = Array.from({ length: 19 }, () => 0.25);
  assert.equal(sensor.typicalRate(), null);
});

test('typical rate is the reciprocal of the median interval', () => {
  const sensor = new TypingSensor();
  sensor.ikis = Array.from({ length: 41 }, (_, i) => (i < 20 ? 0.1 : i === 20 ? 0.25 : 0.9));
  assert.ok(Math.abs(sensor.typicalRate() - 4) < 1e-9, 'median 0.25 s means 4 keys/s');
});

test('typical rate does not disturb the stored intervals', () => {
  const sensor = new TypingSensor();
  sensor.ikis = [0.5, 0.1, 0.3, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 1.0,
    0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95, 0.05, 0.11];
  const copy = [...sensor.ikis];
  sensor.typicalRate();
  assert.deepEqual(sensor.ikis, copy, 'sorting must not reorder the live buffer');
});

test('events older than the retention window are evicted on push', () => {
  const sensor = new TypingSensor({ window: 1 });
  sensor.push('char');
  assert.equal(sensor.events.length, 1);
  // Backdate everything so the next push finds the whole buffer expired.
  for (const event of sensor.events) event.t -= 10;
  sensor.push('char');
  assert.equal(sensor.events.length, 1, 'only the fresh event should remain');
});

test('only structural categories are recorded, never key content', () => {
  const sensor = new TypingSensor();
  sensor.ingest({ key: 'q' });
  sensor.ingest({ key: ' ' });
  sensor.ingest({ key: 'Enter' });
  sensor.ingest({ key: 'Backspace' });
  sensor.ingest({ key: 'ArrowLeft' });   // Ignored.
  sensor.ingest({ key: 'Shift' });       // Ignored.

  assert.deepEqual(sensor.events.map((e) => e.kind), ['char', 'space', 'enter', 'back']);
  for (const event of sensor.events) {
    assert.deepEqual(Object.keys(event).sort(), ['kind', 't'],
      'an event must carry nothing but a timestamp and a category');
  }
});
