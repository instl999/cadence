import test from 'node:test';
import assert from 'node:assert/strict';
import midiPkg from '@tonejs/midi';
import { parseMidi, gate } from '../src/engine/analyze.js';

const { Midi } = midiPkg;

/**
 * Build a real SMF in memory so the tests exercise the same path as an imported
 * file rather than a hand-made object.
 */
function buildMidi(notes, { bpm = 120, timeSignature = [4, 4], withTempo = true } = {}) {
  const midi = new Midi();
  if (withTempo) midi.header.setTempo(bpm);
  midi.header.timeSignatures = [{ ticks: 0, timeSignature }];
  const track = midi.addTrack();
  track.channel = 0;
  for (const [time, pitch, duration = 0.4, velocity = 0.7] of notes) {
    track.addNote({ midi: pitch, time, duration, velocity });
  }
  return midi.toArray().buffer;
}

const scale = (bars = 4) => {
  const notes = [];
  const pitches = [60, 62, 64, 65, 67, 69, 71, 72];
  for (let bar = 0; bar < bars; bar++) {
    for (let i = 0; i < 8; i++) {
      notes.push([bar * 2 + i * 0.25, pitches[i], 0.22, 0.7]);
      if (i % 4 === 0) notes.push([bar * 2 + i * 0.25, 36 + (i % 8), 0.9, 0.8]);  // bass
    }
  }
  return notes;
};

test('a parsed piece reports the notes it was given', () => {
  const source = scale();
  const piece = parseMidi(buildMidi(source));
  assert.equal(piece.noteCount, source.length);
  assert.equal(piece.notes.length, source.length);
  assert.equal(piece.bpm, 120);
  assert.equal(piece.estimatedBpm, false);
  assert.deepEqual(piece.timeSignature, [4, 4]);
});

test('beat and bar length follow the tempo and time signature', () => {
  const piece = parseMidi(buildMidi(scale(), { bpm: 120, timeSignature: [3, 4] }));
  assert.ok(Math.abs(piece.beat - 0.5) < 1e-6);
  assert.ok(Math.abs(piece.barLen - 1.5) < 1e-6, '3/4 at 120 bpm is 1.5 s per bar');
});

test('every note is ranked within zero and one', () => {
  const piece = parseMidi(buildMidi(scale()));
  for (const note of piece.notes) {
    assert.ok(note.rank >= 0 && note.rank <= 1, `rank ${note.rank} out of range`);
    assert.ok(note.salience > 0);
    assert.ok(['bass', 'melody', 'inner'].includes(note.layer), `unexpected layer ${note.layer}`);
  }
});

test('the lowest voice is identified as bass and the highest as melody', () => {
  const piece = parseMidi(buildMidi([
    [0, 36, 1.8, 0.8],
    [0, 72, 0.4, 0.7],
    [0, 64, 0.4, 0.7],
  ]));
  const byPitch = Object.fromEntries(piece.notes.map((n) => [n.midi, n]));
  assert.equal(byPitch[36].layer, 'bass');
  assert.equal(byPitch[72].layer, 'melody');
});

test('percussion on channel 10 is skipped', () => {
  const midi = new Midi();
  midi.header.setTempo(120);
  const drums = midi.addTrack();
  drums.channel = 9;
  drums.addNote({ midi: 38, time: 0, duration: 0.2 });
  const piano = midi.addTrack();
  piano.channel = 0;
  for (let i = 0; i < 10; i++) piano.addNote({ midi: 60 + i, time: i * 0.25, duration: 0.2 });

  const piece = parseMidi(midi.toArray().buffer);
  assert.equal(piece.noteCount, 10);
  assert.ok(piece.notes.every((n) => n.midi >= 60));
});

test('every bar keeps at least one top-ranked note', () => {
  const piece = parseMidi(buildMidi(scale(6)));
  const bars = new Map();
  for (const note of piece.notes) {
    const bar = Math.floor(note.time / piece.barLen);
    if (note.rank === 1) bars.set(bar, true);
  }
  const lastBar = Math.floor((piece.duration - 0.01) / piece.barLen);
  for (let bar = 0; bar <= lastBar; bar++) {
    assert.ok(bars.get(bar), `bar ${bar} lost every note`);
  }
});

test('notes are clamped to the range the sampler can play', () => {
  const piece = parseMidi(buildMidi([
    [0, 3, 0.4], [0.5, 125, 0.4], [1, 60, 0.4],
    [1.5, 62, 0.4], [2, 64, 0.4], [2.5, 65, 0.4],
  ]));
  assert.ok(piece.notes.every((n) => n.midi >= 21 && n.midi <= 108));
});

test('duration spans the last note-off, not the last note-on', () => {
  const piece = parseMidi(buildMidi([
    [0, 60, 0.4], [1, 62, 0.4], [2, 64, 3.0],
    [2.5, 65, 0.2], [3, 67, 0.2], [3.5, 69, 0.2],
  ]));
  assert.ok(Math.abs(piece.duration - 5.0) < 1e-6, `expected 5 s, got ${piece.duration}`);
});

test('tempo is estimated when the file carries none', () => {
  const notes = [];
  for (let i = 0; i < 40; i++) notes.push([i * 0.5, 60 + (i % 7), 0.4]);
  const piece = parseMidi(buildMidi(notes, { withTempo: false }));
  assert.equal(piece.estimatedBpm, true);
  assert.ok(piece.bpm >= 60 && piece.bpm <= 150, `estimated ${piece.bpm}`);
});

test('a file with no notes is rejected rather than parsed into nothing', () => {
  const midi = new Midi();
  midi.header.setTempo(120);
  midi.addTrack().channel = 0;
  assert.throws(() => parseMidi(midi.toArray().buffer), /no notes/i);
});

test('metadata is carried through onto the parsed piece', () => {
  const piece = parseMidi(buildMidi(scale()), { id: 'x:1', title: 'Study', composer: 'Anon' });
  assert.equal(piece.id, 'x:1');
  assert.equal(piece.title, 'Study');
  assert.equal(piece.composer, 'Anon');
});

test('the density gate keeps more notes as density rises', () => {
  const piece = parseMidi(buildMidi(scale(6)));
  const sparse = gate(piece, 0.2).length;
  const middle = gate(piece, 0.5).length;
  const full = gate(piece, 1).length;
  assert.ok(sparse < middle, `${sparse} should be under ${middle}`);
  assert.ok(middle < full, `${middle} should be under ${full}`);
  assert.equal(full, piece.noteCount);
});

test('the density gate never returns an empty score', () => {
  const piece = parseMidi(buildMidi(scale()));
  assert.ok(gate(piece, 0).length >= 1);
});

test('a score dense enough to break argument spreading still parses',
  { skip: process.env.CADENCE_SLOW_TESTS ? false : 'slow: set CADENCE_SLOW_TESTS=1 (builds a 130k-note fixture)' },
  () => {
  // Math.max(...notes) throws RangeError past roughly 125k arguments. A large
  // orchestral or transcribed score reaches that, and used to fail on import.
  const notes = [];
  for (let i = 0; i < 130000; i++) notes.push([i * 0.002, 21 + (i % 88), 0.05, 0.7]);
  const piece = parseMidi(buildMidi(notes));

  assert.equal(piece.noteCount, 130000);
  assert.ok(Number.isFinite(piece.duration) && piece.duration > 0, 'duration must be a real number');
  assert.ok(piece.notes.every((n) => Number.isFinite(n.salience)), 'every note must be scored');
  assert.ok(piece.groups.every((g) => Number.isFinite(g.lowSounding) && Number.isFinite(g.highSounding)));
  });
