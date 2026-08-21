import test from 'node:test';
import assert from 'node:assert/strict';
import { groupMusicRecords, Library } from '../src/library/library.js';

const rec = (name, parent = '') => ({ file: { name }, parent });
const byTitle = (buckets) => Object.fromEntries(buckets.map((b) => [b.title, b]));

test('a UVR pair collapses into one bucket carrying both stems', () => {
  const buckets = groupMusicRecords([
    rec('Clair de Lune_(Vocals).wav', 'Clair de Lune/'),
    rec('Clair de Lune_(Instrumental).wav', 'Clair de Lune/'),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].title, 'Clair de Lune');
  assert.equal(buckets[0].stems.vocals.name, 'Clair de Lune_(Vocals).wav');
  assert.equal(buckets[0].stems.instrumental.name, 'Clair de Lune_(Instrumental).wav');
});

test('Demucs role-only names group under their song folder', () => {
  const buckets = groupMusicRecords([
    rec('no_vocals.wav', 'Nocturne/'),
    rec('vocals.wav', 'Nocturne/'),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].title, 'Nocturne');
  // The pairing that the role-ordering bug used to destroy.
  assert.equal(buckets[0].stems.instrumental.name, 'no_vocals.wav');
  assert.equal(buckets[0].stems.vocals.name, 'vocals.wav');
});

test('a full four-stem Demucs set keeps every role', () => {
  const [bucket] = groupMusicRecords([
    rec('vocals.wav', 'Etude/'),
    rec('drums.wav', 'Etude/'),
    rec('bass.wav', 'Etude/'),
    rec('other.wav', 'Etude/'),
  ]);
  assert.deepEqual(Object.keys(bucket.stems).sort(), ['bass', 'drums', 'other', 'vocals']);
});

test('a four-stem set becomes one typing entry carrying all four stems', () => {
  const library = new Library();
  const items = library._itemsFromRecords([
    { file: { name: 'vocals.wav', url: 'x://vocals' }, parent: 'Etude/' },
    { file: { name: 'drums.wav', url: 'x://drums' }, parent: 'Etude/' },
    { file: { name: 'bass.wav', url: 'x://bass' }, parent: 'Etude/' },
    { file: { name: 'other.wav', url: 'x://other' }, parent: 'Etude/' },
  ], 'resource');

  assert.equal(items.length, 1);
  // The regression: with no "instrumental" file this used to fall back to a
  // single-file audio entry, so only one stem ever played.
  assert.ok(items[0].stemUrls, 'a four-stem split must be a stem entry');
  assert.deepEqual(Object.keys(items[0].stemUrls).sort(), ['bass', 'drums', 'other', 'vocals']);
  assert.equal(items[0].audioUrl, undefined);
});

test('a two-stem UVR pair is still a typing entry', () => {
  const library = new Library();
  const items = library._itemsFromRecords([
    { file: { name: 'Song_(Vocals).wav', url: 'x://v' }, parent: 'Song/' },
    { file: { name: 'Song_(Instrumental).wav', url: 'x://i' }, parent: 'Song/' },
  ], 'resource');
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0].stemUrls).sort(), ['instrumental', 'vocals']);
});

test('a lone stem falls back to plain audio rather than a broken stem entry', () => {
  const library = new Library();
  const items = library._itemsFromRecords([
    { file: { name: 'vocals.wav', url: 'x://v' }, parent: 'Song/' },
  ], 'resource');
  assert.equal(items.length, 1);
  assert.equal(items[0].stemUrls, undefined);
  assert.equal(items[0].audioUrl, 'x://v');
});

test('songs in different folders never share a bucket', () => {
  const buckets = groupMusicRecords([
    rec('vocals.wav', 'Song A/'),
    rec('vocals.wav', 'Song B/'),
  ]);
  assert.equal(buckets.length, 2);
  assert.deepEqual(buckets.map((b) => b.title).sort(), ['Song A', 'Song B']);
});

test('a plain audio file stays plain audio', () => {
  const [bucket] = groupMusicRecords([rec('Prelude in C.mp3', 'Bach/')]);
  assert.equal(bucket.title, 'Prelude in C');
  assert.equal(bucket.audio.name, 'Prelude in C.mp3');
  assert.deepEqual(bucket.stems, {});
});

test('a song titled after an instrument is audio, not an "other" stem', () => {
  const [bucket] = groupMusicRecords([rec('Piano Man.mp3', 'Sample Artist/')]);
  assert.equal(bucket.title, 'Piano Man');
  assert.equal(bucket.audio.name, 'Piano Man.mp3');
  assert.deepEqual(bucket.stems, {});
});

test('MIDI pairs with audio of the same name in the same folder', () => {
  const buckets = groupMusicRecords([
    rec('Gymnopedie.mid', 'Satie/'),
    rec('Gymnopedie.mp3', 'Satie/'),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].midi.name, 'Gymnopedie.mid');
  assert.equal(buckets[0].audio.name, 'Gymnopedie.mp3');
});

test('unsupported extensions are ignored', () => {
  const buckets = groupMusicRecords([
    rec('cover.jpg', 'Song/'),
    rec('notes.txt', 'Song/'),
    rec('Song.mp3', 'Song/'),
  ]);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].audio.name, 'Song.mp3');
});

test('grouping is case and separator insensitive', () => {
  const buckets = groupMusicRecords([
    rec('Song Name_(Vocals).wav', 'X/'),
    rec('song name_(Instrumental).wav', 'X/'),
  ]);
  assert.equal(buckets.length, 1);
  const bucket = buckets[0];
  assert.ok(bucket.stems.vocals && bucket.stems.instrumental);
});

test('the first file of a role wins rather than the last', () => {
  const [bucket] = groupMusicRecords([
    rec('Song_(Vocals).wav', 'X/'),
    rec('Song_(Vocals).mp3', 'X/'),
  ]);
  assert.equal(bucket.stems.vocals.name, 'Song_(Vocals).wav');
});

test('an empty record list yields no buckets', () => {
  assert.deepEqual(groupMusicRecords([]), []);
  assert.deepEqual(byTitle(groupMusicRecords([])), {});
});
