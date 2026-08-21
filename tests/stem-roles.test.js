import test from 'node:test';
import assert from 'node:assert/strict';
import { roleFromMarker, roleFromFileName, roleFromLooseName } from '../src/shared/stem-roles.js';

test('instrumental is matched before vocals, so "no_vocals" is not a vocal stem', () => {
  // The regression this table exists to prevent: "no_vocals" contains "vocals",
  // so testing the vocal patterns first files a Demucs instrumental as vocals
  // and silently drops the real vocal stem.
  assert.equal(roleFromLooseName('no_vocals.wav'), 'instrumental');
  assert.equal(roleFromLooseName('no vocals.wav'), 'instrumental');
  assert.equal(roleFromLooseName('no-vocals.flac'), 'instrumental');
  assert.equal(roleFromLooseName('novocals.mp3'), 'instrumental');
  assert.equal(roleFromLooseName('vocals.wav'), 'vocals');
});

test('every canonical Demucs output name is recognised from a bare filename', () => {
  assert.equal(roleFromFileName('vocals'), 'vocals');
  assert.equal(roleFromFileName('no_vocals'), 'instrumental');
  assert.equal(roleFromFileName('drums'), 'drums');
  assert.equal(roleFromFileName('bass'), 'bass');
  assert.equal(roleFromFileName('other'), 'other');
});

test('UVR marker labels are recognised inside parentheses', () => {
  assert.equal(roleFromMarker('Vocals'), 'vocals');
  assert.equal(roleFromMarker('Instrumental'), 'instrumental');
  assert.equal(roleFromMarker('No Vocals'), 'instrumental');
  assert.equal(roleFromMarker('Drums'), 'drums');
  assert.equal(roleFromMarker('Bass'), 'bass');
  assert.equal(roleFromMarker('Piano'), 'other');
  assert.equal(roleFromMarker('Guitar'), 'other');
});

test('title-prone words count as roles only inside a marker', () => {
  // "Piano Man.mp3" is a song, not an "other" stem; "Song_(Piano).wav" is a stem.
  assert.equal(roleFromFileName('Piano Man'), null);
  assert.equal(roleFromFileName('Guitar Town'), null);
  assert.equal(roleFromFileName('Backing Up'), null);
  assert.equal(roleFromMarker('Piano'), 'other');
});

test('titles that merely contain a role word are not stems', () => {
  assert.equal(roleFromFileName('Bassline Junkie'), null);
  assert.equal(roleFromFileName('Vocalise'), null);
  assert.equal(roleFromFileName('Drumming Song'), null);
});

test('separators act as word boundaries in bare filenames', () => {
  assert.equal(roleFromFileName('Song - Vocals'), 'vocals');
  assert.equal(roleFromFileName('Song_drums'), 'drums');
  assert.equal(roleFromFileName('Song.bass'), 'bass');
});

test('legacy non-English labels still resolve', () => {
  assert.equal(roleFromMarker('人声'), 'vocals');
  assert.equal(roleFromMarker('伴奏'), 'instrumental');
  assert.equal(roleFromMarker('鼓组'), 'drums');
});

test('an unrecognised label yields no role rather than a wrong one', () => {
  assert.equal(roleFromMarker('Remastered 2011'), null);
  assert.equal(roleFromFileName('Live at Wembley'), null);
});
