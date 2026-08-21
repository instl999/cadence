import './styles.css';
import * as Tone from 'tone';
import { Piano } from './engine/piano.js';
import { TypingSensor } from './engine/typing-sensor.js';
import { Arranger } from './engine/state-model.js';
import { Player } from './engine/player.js';
import { Library } from './library/library.js';
import { Backing } from './engine/backing.js';
import { Soloist } from './engine/soloist.js';
import { detectKeyAsync, toAnalysisSamples, ANALYSIS_RATE } from './engine/keydetect.js';
import { StemDeck } from './engine/stemdeck.js';
import { Mixer, MODES, ANCHOR_ROLE, availableModes } from './engine/gate.js';
import { Touch } from './engine/touch.js';

const $ = (id) => document.getElementById(id);

// Elements touched on every keystroke or every frame are resolved once. The
// global hook can fire faster than a repeated getElementById is worth paying for.
const el = {
  app: $('app'),
  power: $('power'),
  powerLabel: $('powerLabel'),
  powerHeadline: $('powerHeadline'),
  powerHint: $('powerHint'),
  playPause: $('playPause'),
  playIcon: $('playIcon'),
  next: $('next'),
  order: $('order'),
  orderLabel: $('orderLabel'),
  npTitle: $('npTitle'),
  npComposer: $('npComposer'),
  sourceTag: $('sourceTag'),
  trackProgress: $('trackProgress'),
  trackTime: $('trackTime'),
  trackDuration: $('trackDuration'),
  stRate: $('stRate'),
  pulseOrb: $('pulseOrb'),
  pulseScope: $('pulseScope'),
  bars: $('bars'),
  mixer: $('mixer'),
  mixerRows: $('mixerRows'),
  statusText: $('statusText'),
  list: $('list'),
  emptyLibrary: $('emptyLibrary'),
  toast: $('toast'),
  dropzone: $('dropzone'),
  platformLabel: $('platformLabel'),
};

const KEY_KINDS = new Set(['char', 'back', 'enter', 'space']);
const desktop = window.cadenceDesktop ?? null;

if (desktop?.isDesktop) document.body.classList.add('desktop');
el.platformLabel.textContent = desktop?.isDesktop ? 'Windows-wide input' : 'Current-window preview';
$('resourceButtonLabel').textContent = desktop?.isDesktop ? 'Music Resources' : 'Import Folder';
if (!desktop?.isDesktop) {
  $('pickDir').title = 'Import a music folder';
  $('pickDir').setAttribute('aria-label', 'Import a music folder');
  $('importHelp').querySelector('.help-title small').textContent = 'Choose a folder manually in browser preview';
}

const piano = new Piano();
const sensor = new TypingSensor();
const arranger = new Arranger();
const player = new Player(piano, arranger);
const library = new Library();
player.mode = 'hybrid';

let backing = null;
let soloist = null;
let deck = null;
let mixer = null;
let touch = null;

let enabled = false;
let isPlaying = false;
let isLoading = false;
let current = null;
let loadedItemId = null;
let currentEngine = null;
let queue = [];
let stemStartOffset = 0;
let orderMode = localStorage.getItem('cadence:order') === 'shuffle' ? 'shuffle' : 'sequence';
let stemMode = MODES[localStorage.getItem('cadence:stemMode')] ? localStorage.getItem('cadence:stemMode') : 'vocal';
let refRate = Number(localStorage.getItem('cadence:refRate')) || 3.2;
let toastTimer = null;
let unduckTimer = null;
let lastRateTune = 0;
let lastUiTick = 0;
let lastSourceTag = '';
let libraryReady = false;
let pendingMusicResource = null;
let powerTransition = false;
let shuffleDeck = [];

// Lightweight visual feedback.
const barEls = [];
for (let i = 0; i < 24; i++) {
  const bar = document.createElement('i');
  el.bars.appendChild(bar);
  barEls.push(bar);
}

// The scope is a ring: flex order decides where each bar sits, so a keystroke
// reuses the oldest element instead of destroying and creating one.
const scopeEls = [];
for (let i = 0; i < 23; i++) {
  const bar = document.createElement('i');
  bar.style.order = String(i);
  el.pulseScope.appendChild(bar);
  scopeEls.push(bar);
}
let scopeCursor = 0;
let scopeOrder = scopeEls.length;

function showToast(message) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.add('show');
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function setSourceTag(text) {
  if (text === lastSourceTag) return;
  lastSourceTag = text;
  el.sourceTag.textContent = text;
}

let orbAnimations = null;

function animateInput(kind) {
  // Restarting the keyframes through the animation API avoids the classic
  // remove-class / read-offsetWidth / add-class trick, which forces a
  // synchronous layout on every single key. The lookup itself flushes pending
  // style, so it happens once and the objects are reused from then on.
  if (!orbAnimations?.length) {
    el.pulseOrb.classList.add('hit');
    orbAnimations = el.pulseOrb.getAnimations({ subtree: true });
  }
  for (const animation of orbAnimations) {
    animation.currentTime = 0;
    animation.play();
  }

  const weight = kind === 'enter' || kind === 'space' ? 1 : kind === 'back' ? 0.72 : 0.86;
  const fresh = scopeEls[scopeCursor];
  scopeCursor = (scopeCursor + 1) % scopeEls.length;
  fresh.style.order = String(scopeOrder++);
  fresh.style.height = `${8 + weight * 36}px`;
  fresh.style.opacity = String(0.45 + weight * 0.45);

  const idx = (sensor.events.length * 7) % barEls.length;
  const bar = barEls[idx];
  bar.style.height = `${10 + weight * 20}px`;
  bar.style.background = 'var(--live)';
  bar.style.opacity = '1';
  clearTimeout(bar._reset);
  bar._reset = setTimeout(() => {
    bar.style.height = '3px';
    bar.style.background = '';
    bar.style.opacity = '';
  }, 300);
}

player.onNote = (note) => {
  const idx = Math.min(barEls.length - 1, Math.max(0,
    Math.round(((note.midi - 24) / 66) * (barEls.length - 1))));
  const bar = barEls[idx];
  bar.style.height = `${7 + note.vel * 23}px`;
  bar.style.background = 'var(--live)';
  clearTimeout(bar._reset);
  bar._reset = setTimeout(() => { bar.style.height = '3px'; bar.style.background = ''; }, 250);
};

// Global and window-local keyboard events enter through the same privacy boundary.
function handleKind(kind) {
  if (!enabled || !KEY_KINDS.has(kind)) return;
  sensor.push(kind);
  animateInput(kind);

  if (!isPlaying) return;
  if (deck?.playing && mixer && touch) {
    touch.hit(kind === 'space' || kind === 'enter');
    mixer.strike(performance.now() / 1000, kind);
    return;
  }
  if (backing?.playing) {
    if (soloist) {
      const midi = soloist.strike(backing.scorePosition, arranger.intensity);
      if (midi !== null) {
        player.onNote({ midi, vel: 0.72, layer: 'melody' });
        backing.duck(0.25 + arranger.intensity * 0.25);
        clearTimeout(unduckTimer);
        unduckTimer = setTimeout(() => backing.duck(0), 600);
      }
    }
    return;
  }
  player.strike();
}

if (desktop?.isDesktop) {
  desktop.onKey(({ kind }) => handleKind(kind));
} else {
  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest?.('button, input, [contenteditable="true"]')) return;
    let kind = null;
    if (event.key === 'Backspace' || event.key === 'Delete') kind = 'back';
    else if (event.key === 'Enter') kind = 'enter';
    else if (event.key === ' ') kind = 'space';
    else if (event.key.length === 1) kind = 'char';
    if (kind) handleKind(kind);
  });
}

function updatePowerUi() {
  el.app.dataset.enabled = String(enabled);
  el.app.dataset.playing = String(isPlaying);
  el.power.setAttribute('aria-pressed', String(enabled));
  el.playIcon.textContent = isPlaying ? 'Ⅱ' : '▶';
  el.playPause.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  el.playPause.title = isPlaying ? 'Pause' : 'Play';

  if (isLoading) {
    el.statusText.textContent = 'Loading';
    el.powerHeadline.textContent = current ? `Loading ${current.title}` : 'Preparing music';
    el.powerHint.textContent = 'The first decode may take a moment';
    return;
  }

  if (enabled) {
    // "Listening" rather than "Paused": pausing the music does not stop the
    // keyboard hook, and that distinction is the app's central privacy promise.
    el.statusText.textContent = isPlaying ? 'Live' : 'Listening';
    el.powerHeadline.textContent = isPlaying ? 'Type anywhere' : 'Music paused';
    el.powerHint.textContent = isPlaying
      ? 'Cadence follows your rhythm in the background'
      : 'Keyboard monitoring remains enabled';
    el.powerLabel.textContent = 'Disable';
  } else {
    el.statusText.textContent = 'Idle';
    el.powerHeadline.textContent = 'Let your keyboard drive the music';
    el.powerHint.textContent = desktop?.isDesktop
      ? 'Enable, switch to any app, and start typing'
      : 'Browser preview responds only to this page';
    el.powerLabel.textContent = 'Enable';
  }
}

function setLoading(value) {
  isLoading = value;
  el.power.disabled = value;
  el.playPause.disabled = value;
  el.next.disabled = value;
  updatePowerUi();
}

function playbackPosition() {
  if (currentEngine === 'stems' && deck) return Math.max(0, deck.position - stemStartOffset);
  if (currentEngine === 'audio' && backing) return backing.position;
  if (currentEngine === 'midi') return player.position;
  return 0;
}

function playbackDuration() {
  if (currentEngine === 'stems' && deck) return Math.max(0, deck.duration - stemStartOffset);
  if (currentEngine === 'audio' && backing) return backing.duration;
  if (currentEngine === 'midi') return player.duration;
  return 0;
}

function updateProgress() {
  const pos = playbackPosition();
  const duration = playbackDuration();
  const pct = duration > 0 ? Math.min(100, Math.max(0, (pos / duration) * 100)) : 0;
  el.trackProgress.style.width = `${pct}%`;
  el.trackTime.textContent = formatTime(pos);
  el.trackDuration.textContent = formatTime(duration);
}

async function ensureAudio() {
  await piano.init(() => {});
}

function stopCurrent() {
  if (deck) deck.stop();
  if (backing) backing.stop();
  player.stop();
  isPlaying = false;
}

function pausePlayback() {
  if (deck?.playing) deck.pause();
  if (backing?.playing) backing.pause();
  if (player.playing) player.pause();
  isPlaying = false;
  updatePowerUi();
}

async function resumePlayback() {
  if (!current) {
    if (!queue.length) return;
    current = queue[0];
  }
  if (loadedItemId !== current.id) {
    await loadTrack(current, { autoplay: true });
    return;
  }

  await ensureAudio();
  if (currentEngine === 'stems' && deck) deck.play(Math.max(deck.position, stemStartOffset));
  else if (currentEngine === 'audio' && backing) await backing.play();
  else if (currentEngine === 'midi') player.resume();
  isPlaying = true;
  updatePowerUi();
}

/**
 * Pick the stem that typing reveals: the listener's remembered choice when this
 * track can honour it, otherwise the first mode the stem set supports.
 */
function followStemMode(roles) {
  const modes = availableModes(roles);
  if (!modes.length) return 'vocal';
  return modes.includes(stemMode) ? stemMode : modes[0];
}

function applyStemMode(mode) {
  stemMode = mode;
  localStorage.setItem('cadence:stemMode', mode);
  if (mixer) mixer.setMode(mode);
  renderMixer();
}

const formatRoleList = (roles) => (roles.length < 2
  ? (roles[0] ?? '')
  : `${roles.slice(0, -1).join(', ')} and ${roles.at(-1)}`);

/** Describe the mix in the listener's terms: what responds, and what always plays. */
function stemModeHint(mode, roles) {
  const foreground = MODES[mode]?.foreground.filter((r) => roles.includes(r)) ?? [];
  const reveals = formatRoleList(foreground) || (MODES[mode]?.short ?? mode).toLowerCase();
  const rest = roles.filter((r) => !foreground.includes(r));
  if (!rest.length) return `Typing reveals ${reveals}.`;

  // Name the anchor first: it is the part that never stops, whatever you type.
  const ordered = rest.includes(ANCHOR_ROLE)
    ? [ANCHOR_ROLE, ...rest.filter((r) => r !== ANCHOR_ROLE)]
    : rest;
  const listed = formatRoleList(ordered);
  const sentence = `${listed[0].toUpperCase()}${listed.slice(1)}`;
  return `Typing reveals ${reveals}. ${sentence} ${ordered.length === 1 ? 'keeps' : 'keep'} playing.`;
}

const ROLE_LABEL = {
  vocals: 'Vocals', instrumental: 'Backing', drums: 'Drums', bass: 'Bass', other: 'Other',
};

/** Which mode, if any, reveals this role. */
function modeForRole(role, roles) {
  return availableModes(roles).find((mode) => MODES[mode].foreground.includes(role)) ?? null;
}

/** Meter elements, keyed by role, so the level loop never queries the DOM. */
let meterEls = new Map();

/**
 * Rebuild the mixer for whatever the loaded track contains.
 *
 * Every stem gets a row, not just the selectable ones: showing the whole mix is
 * what makes the mechanism legible. Rows that some mode can reveal are
 * clickable; the rest are labelled as the bed they are.
 */
function renderMixer() {
  const roles = currentEngine === 'stems' && deck ? deck.roles : [];
  el.mixer.hidden = roles.length === 0;
  // The spectrum belongs to the MIDI and audio engines. With nothing loaded it
  // is a row of inert dashes, so it stays hidden until a track is actually on.
  el.bars.hidden = roles.length > 0 || !currentEngine;
  meterEls = new Map();
  if (el.mixer.hidden) {
    el.mixerRows.replaceChildren();
    return;
  }

  const active = mixer?.mode ?? followStemMode(roles);
  const fragment = document.createDocumentFragment();
  for (const role of roles) {
    const mode = modeForRole(role, roles);
    const selected = mode !== null && mode === active;
    const anchor = role === ANCHOR_ROLE;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'stem-row';
    row.dataset.role = role;
    row.dataset.selectable = String(mode !== null);
    row.dataset.anchor = String(anchor);
    if (mode) {
      row.dataset.mode = mode;
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(selected));
      row.title = MODES[mode].hint;
    } else {
      row.disabled = true;
      row.title = 'This stem plays continuously on this track.';
    }

    const name = document.createElement('span');
    name.className = 'stem-name';
    name.textContent = ROLE_LABEL[role] ?? role;

    const meter = document.createElement('span');
    meter.className = 'stem-meter';
    const fill = document.createElement('i');
    meter.appendChild(fill);
    meterEls.set(role, fill);

    const tag = document.createElement('span');
    tag.className = 'stem-tag';
    tag.textContent = selected ? 'Typing' : anchor ? 'Always' : 'Playing';

    row.append(name, meter, tag);
    fragment.appendChild(row);
  }
  el.mixerRows.replaceChildren(fragment);
}

/** Drive the meters from the gains the mixer actually applied. */
function updateMeters() {
  if (!deck || el.mixer.hidden) return;
  for (const [role, fill] of meterEls) {
    const gain = deck.stems.get(role)?.gain.gain.value ?? 0;
    fill.style.transform = `scaleX(${Math.min(1, gain).toFixed(3)})`;
  }
}

el.mixerRows.addEventListener('click', (event) => {
  const mode = event.target?.closest?.('.stem-row')?.dataset.mode;
  if (!mode || mode === mixer?.mode) return;
  applyStemMode(mode);
  el.npComposer.textContent = stemModeHint(mode, deck?.roles ?? []);
});

/**
 * Measure the key of an audio file already in memory.
 *
 * The full-length PCM is released as soon as the band-limited analysis slice
 * exists, so a long track does not leave a hundred megabytes of Float32
 * resident while the FFT runs.
 */
async function analyzeKey(bytes) {
  let buffer = await piano.ctx.decodeAudioData(bytes);
  const samples = await toAnalysisSamples(buffer);
  buffer = null;
  return detectKeyAsync({ sampleRate: ANALYSIS_RATE, samples });
}

async function loadTrack(item, { autoplay = true } = {}) {
  if (!item || isLoading) return;
  current = item;
  setLoading(true);
  el.npTitle.textContent = item.title;
  el.npComposer.textContent = 'Preparing…';
  setSourceTag('Loading');
  updateListSelection();

  try {
    await ensureAudio();
    stopCurrent();
    // Release whatever the previous engine was holding. Decoded stems alone can
    // be well over 100 MB, and nothing frees them if the deck is only stopped.
    if (deck && !item.stemUrls) { deck.unload(); mixer = null; }
    if (backing && !item.audioUrl) backing.unload();
    current = item;
    loadedItemId = null;
    currentEngine = null;
    stemStartOffset = 0;
    renderMixer();   // Hidden until we know the new track carries stems.

    // Give the browser one frame to paint the loading state. Decoding a large
    // MIDI blocks this thread inside @tonejs/midi, so without this yield the
    // window freezes before the message the freeze is meant to explain appears.
    if (item.get) {
      el.npComposer.textContent = 'Reading score…';
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const piece = await library.load(item);

    if (item.stemUrls) {
      currentEngine = 'stems';
      deck = deck || new StemDeck(piano.ctx);
      touch = touch || new Touch(piano.ctx);
      const roles = Object.keys(item.stemUrls);
      // Fetch every stem at once; the decode inside deck.load() also overlaps.
      let fetched = 0;
      const buffers = Object.fromEntries(await Promise.all(roles.map(async (role) => {
        const response = await fetch(item.stemUrls[role]);
        if (!response.ok) throw new Error(`Stem loading failed: ${response.status}`);
        const data = await response.arrayBuffer();
        el.npComposer.textContent = `Loaded stem ${++fetched}/${roles.length}`;
        return [role, data];
      })));
      await deck.load(buffers, (progress) => {
        el.npComposer.textContent = `Decoding ${Math.round(progress * 100)}%`;
      });
      mixer = new Mixer(deck);
      mixer.setRefRate(refRate);
      mixer.setMode(followStemMode(deck.roles));
      deck.onEnded = () => handleTrackEnded();
      stemStartOffset = deck.audibleStart();
      renderMixer();
      el.npComposer.textContent = stemModeHint(mixer.mode, deck.roles);
      setSourceTag('Typing stems');
      if (autoplay) deck.play(stemStartOffset);
    } else if (item.audioUrl) {
      currentEngine = 'audio';
      backing = backing || new Backing(piano.ctx);
      soloist = soloist || new Soloist(piano);
      piano.ensureSampler();   // This engine performs on the piano, so pay for it now.
      el.npComposer.textContent = 'Loading audio…';

      if (piece) {
        await backing.load(item.audioUrl);
        soloist.fromMidi(piece);
        backing.offset = 0;
        el.npComposer.textContent = 'Original backing — Typing releases melody';
      } else {
        // No score to follow, so the key has to be measured. One read feeds both
        // the player and the analyser instead of transferring the file twice.
        const response = await fetch(item.audioUrl);
        if (!response.ok) throw new Error(`Audio reading failed: ${response.status}`);
        const bytes = await response.arrayBuffer();
        // Blob construction copies, so decoding may detach `bytes` afterwards.
        await backing.load(URL.createObjectURL(new Blob([bytes])), { revokeOnUnload: true });
        el.npComposer.textContent = 'Detecting key…';
        const key = await analyzeKey(bytes);
        soloist.fromKey(key.tonic, key.mode);
        el.npComposer.textContent = `${key.name} — Typing releases melody`;
      }
      backing.onEnded = () => handleTrackEnded();
      setSourceTag('Audio');
      if (autoplay) await backing.play();
    } else {
      if (!piece) throw new Error('This track has no playable content');
      currentEngine = 'midi';
      soloist = null;
      piano.ensureSampler();
      player.mode = 'hybrid';
      player.load(piece);
      el.npComposer.textContent = `${Math.round(piece.bpm)} BPM — Typing releases ornament notes`;
      setSourceTag('MIDI');
      if (autoplay) player.start();
    }

    loadedItemId = item.id;
    isPlaying = autoplay;
    el.trackDuration.textContent = formatTime(playbackDuration());
    updateListSelection();
  } catch (error) {
    stopCurrent();
    reportError(error);
  } finally {
    setLoading(false);
    updateProgress();
  }
}

/** Shuffle consumes a shuffled deck, so every track plays before any repeats. */
function nextItem() {
  if (!queue.length) return null;
  if (!current) return queue[0];
  const index = Math.max(0, queue.findIndex((item) => item.id === current.id));
  if (orderMode !== 'shuffle' || queue.length < 2) return queue[(index + 1) % queue.length];

  const live = new Set(queue.map((item) => item.id));
  shuffleDeck = shuffleDeck.filter((id) => live.has(id) && id !== current.id);
  if (!shuffleDeck.length) {
    shuffleDeck = queue.map((item) => item.id).filter((id) => id !== current.id);
    for (let i = shuffleDeck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffleDeck[i], shuffleDeck[j]] = [shuffleDeck[j], shuffleDeck[i]];
    }
  }
  const nextId = shuffleDeck.shift();
  return queue.find((item) => item.id === nextId) ?? queue[(index + 1) % queue.length];
}

function showStandby(item) {
  current = item;
  loadedItemId = null;
  el.npTitle.textContent = item.title;
  el.npComposer.textContent = 'Enable to play';
  setSourceTag('Standby');
  updateListSelection();
}

async function nextTrack({ autoplay = isPlaying } = {}) {
  const item = nextItem();
  if (!item) return;
  if (!enabled) {
    showStandby(item);
    updateProgress();
    return;
  }
  await loadTrack(item, { autoplay });
}

function handleTrackEnded() {
  isPlaying = false;
  nextTrack({ autoplay: true }).catch(reportError);
}

player.onPieceEnd = handleTrackEnded;

async function setEnabled(next) {
  if (isLoading || next === enabled) return;
  el.power.disabled = true;
  powerTransition = true;
  try {
    if (next) {
      // Unlock WebAudio inside the button gesture before awaiting any IPC call.
      await ensureAudio();
      if (desktop?.isDesktop) {
        const state = await desktop.setEnabled(true);
        if (!state?.supported || !state?.enabled) {
          throw new Error(state?.error || 'Windows global keyboard monitoring could not start');
        }
      }
      enabled = true;
      updatePowerUi();
      await resumePlayback();
    } else {
      pausePlayback();
      if (desktop?.isDesktop) await desktop.setEnabled(false);
      enabled = false;
      updatePowerUi();
    }
  } catch (error) {
    enabled = false;
    pausePlayback();
    reportError(error);
  } finally {
    powerTransition = false;
    el.power.disabled = false;
    updatePowerUi();
  }
}

function renderOrder() {
  const shuffle = orderMode === 'shuffle';
  el.orderLabel.textContent = shuffle ? 'Shuffle' : 'Sequence';
  el.order.querySelector('.order-icon').textContent = shuffle ? '⤨' : '⇥';
  el.order.title = shuffle ? 'Shuffle playback' : 'Sequence playback';
  el.order.setAttribute('aria-label', shuffle ? 'Shuffle playback' : 'Sequence playback');
}

/** Selection changes far more often than the playlist does, so it moves alone. */
function updateListSelection() {
  for (const li of el.list.children) {
    li.classList.toggle('on', li.dataset.id === current?.id);
  }
}

function renderList() {
  el.list.replaceChildren();
  el.emptyLibrary.hidden = queue.length > 0;
  const fragment = document.createDocumentFragment();
  queue.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = item.id === current?.id ? 'on' : '';
    li.dataset.id = item.id;
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `Play ${item.title}`);

    const number = document.createElement('span');
    number.className = 'track-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'list-copy';
    const name = document.createElement('b');
    name.textContent = item.title;
    const source = document.createElement('small');
    source.textContent = item.stemUrls ? 'Typing stems' : item.audioUrl ? 'Audio' : 'MIDI';
    copy.append(name, source);
    const state = document.createElement('span');
    state.className = 'list-state';
    li.append(number, copy, state);
    fragment.appendChild(li);
  });
  el.list.appendChild(fragment);
}

function chooseFromList(target) {
  const li = target?.closest?.('li');
  if (!li || isLoading) return;
  const item = queue.find((entry) => entry.id === li.dataset.id);
  if (!item) return;
  if (!enabled) showStandby(item);
  else loadTrack(item, { autoplay: isPlaying }).catch(reportError);
}

// One delegated pair of listeners instead of two per track.
el.list.addEventListener('click', (event) => chooseFromList(event.target));
el.list.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  chooseFromList(event.target);
});

function reportError(error) {
  console.error(error);
  el.npComposer.textContent = error?.message || 'An unknown error occurred';
  setSourceTag('Error');
  showToast(error?.message || 'The operation failed');
}

el.power.addEventListener('click', () => setEnabled(!enabled));
el.playPause.addEventListener('click', async () => {
  if (isLoading) return;
  if (!enabled) {
    await setEnabled(true);
  } else if (isPlaying) {
    pausePlayback();
  } else {
    await resumePlayback();
  }
});
el.next.addEventListener('click', () => nextTrack({ autoplay: isPlaying }).catch(reportError));
el.order.addEventListener('click', () => {
  orderMode = orderMode === 'sequence' ? 'shuffle' : 'sequence';
  shuffleDeck = [];
  localStorage.setItem('cadence:order', orderMode);
  renderOrder();
  showToast(orderMode === 'shuffle' ? 'Shuffle playback enabled' : 'Sequence playback enabled');
});

$('importHelpButton').addEventListener('click', () => {
  const wrap = $('importHelpButton').closest('.help-wrap');
  const open = !wrap.classList.contains('open');
  wrap.classList.toggle('open', open);
  $('importHelpButton').setAttribute('aria-expanded', String(open));
});

const helpWrap = $('importHelpButton').closest('.help-wrap');
helpWrap.addEventListener('mouseenter', () => $('importHelpButton').setAttribute('aria-expanded', 'true'));
helpWrap.addEventListener('mouseleave', () => {
  if (!helpWrap.classList.contains('open')) $('importHelpButton').setAttribute('aria-expanded', 'false');
});
helpWrap.addEventListener('focusin', () => $('importHelpButton').setAttribute('aria-expanded', 'true'));
helpWrap.addEventListener('focusout', (event) => {
  if (!helpWrap.contains(event.relatedTarget) && !helpWrap.classList.contains('open')) {
    $('importHelpButton').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  helpWrap.classList.remove('open');
  $('importHelpButton').setAttribute('aria-expanded', 'false');
});

$('pickDir').addEventListener('click', async () => {
  try {
    if (desktop?.openMusicResource) {
      const result = await desktop.openMusicResource();
      if (!result?.ok) throw new Error(result?.error || 'Music Resources could not be opened');
      showToast('Music Resources opened — New songs refresh automatically');
      return;
    }
    if (!library.supportsFolder) {
      $('folderInput').click();
      return;
    }
    const result = library.needsPermission ? await library.regrant() : await library.pickFolder();
    if (!result) return;
    showToast(result.count
      ? `Added ${result.count} track${result.count === 1 ? '' : 's'} from ${result.name}`
      : 'No supported music was found in the folder');
  } catch (error) {
    if (error.name !== 'AbortError') reportError(error);
  }
});

$('folderInput').addEventListener('change', async (event) => {
  const count = await library.addFiles(event.target.files);
  showToast(count ? `Added ${count} track${count === 1 ? '' : 's'}` : 'No supported music files were found');
  event.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (++dragDepth === 1) el.dropzone.classList.add('on');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.classList.remove('on'); }
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  el.dropzone.classList.remove('on');
  const count = await library.addFiles(event.dataTransfer.files);
  showToast(count ? `Added ${count} track${count === 1 ? '' : 's'}` : 'No supported music files were found');
});

// Update musical state at 15 Hz; progress and automatic speed calibration run
// less often. The loop idles out once nothing is enabled, playing, or still
// decaying, so a disabled window costs nothing.
let lastTick = performance.now() / 1000;
setInterval(() => {
  const now = performance.now() / 1000;
  const features = sensor.features(now);

  // Keep ticking briefly past the last key so gates and bars finish their decay.
  if (!enabled && !isPlaying && features.idle > 5) {
    lastTick = now;
    return;
  }

  const dt = now - lastTick;
  lastTick = now;
  arranger.update(features, dt);

  if (deck?.playing && mixer) {
    const mix = mixer.update(now, dt, features.rate);
    setSourceTag(mix.fg > 0.04 ? 'Following' : 'Backing');
  } else if (isPlaying && currentEngine === 'midi') {
    player.syncTempo();
  }

  if (now - lastUiTick > 0.18) {
    lastUiTick = now;
    el.stRate.textContent = features.rate.toFixed(1);
    updateProgress();
    updateMeters();
    const newest = (scopeCursor + scopeEls.length - 1) % scopeEls.length;
    for (let i = 0; i < scopeEls.length; i++) {
      if (i === newest) continue;
      const bar = scopeEls[i];
      const height = Number.parseFloat(bar.style.height || '3');
      bar.style.height = `${Math.max(3, height * 0.82)}px`;
      bar.style.opacity = String(Math.max(0.16, Number(bar.style.opacity || 0.2) * 0.9));
    }
  }

  if (now - lastRateTune > 2) {
    lastRateTune = now;
    const typical = sensor.typicalRate();
    if (typical) {
      const target = Math.min(9, Math.max(1.2, typical));
      const next = refRate * 0.82 + target * 0.18;
      // The smoothing converges but never settles exactly, so persist only on a
      // change actually worth a synchronous disk write.
      if (Math.abs(next - refRate) > 0.05) localStorage.setItem('cadence:refRate', next.toFixed(2));
      refRate = next;
      if (mixer) mixer.setRefRate(refRate);
    }
  }
}, 66);

library.onChange = () => {
  queue = library.items;
  if (current) current = queue.find((item) => item.id === current.id) || current;
  if (!current && queue.length) current = queue[0];
  shuffleDeck = [];
  renderList();
};

function applyMusicResource(payload, notify = false) {
  if (!payload) return 0;
  if (!libraryReady) {
    pendingMusicResource = payload;
    return 0;
  }
  const count = library.setResourceFiles(payload.files || []);
  if (payload.error) showToast(`Music Resources could not be read: ${payload.error}`);
  else if (notify) showToast(`Music Resources refreshed — ${count} track${count === 1 ? '' : 's'}`);
  return count;
}

renderOrder();
renderMixer();   // Nothing is loaded yet, so this hides both the mixer and the spectrum.
updatePowerUi();
library.init().then(async () => {
  libraryReady = true;
  if (desktop?.getMusicResource) {
    const payload = pendingMusicResource || await desktop.getMusicResource();
    pendingMusicResource = null;
    applyMusicResource(payload);
  }
  if (!queue.length) return;
  current = current || queue[0];
  el.npTitle.textContent = current.title;
  el.npComposer.textContent = 'Enable to play';
  setSourceTag('Standby');
  updateListSelection();
}).catch(reportError);

if (desktop?.isDesktop) {
  desktop.onMusicResourceChange((payload) => applyMusicResource(payload, true));
  desktop.getState().then((state) => {
    if (!state?.supported) {
      el.platformLabel.textContent = 'Global monitoring unavailable';
      showToast(state?.error || 'Windows global keyboard monitoring is unavailable');
    }
  }).catch(reportError);

  // The main process broadcasts state on every change. Without this the UI keeps
  // claiming input is enabled after a hook that failed once it was already
  // running. Transitions we started ourselves are already reflected in the UI.
  desktop.onState?.((state) => {
    if (!state || powerTransition) return;
    if (!state.supported) el.platformLabel.textContent = 'Global monitoring unavailable';
    if (enabled && !state.enabled) {
      enabled = false;
      pausePlayback();
      updatePowerUi();
      showToast(state.error || 'Global keyboard monitoring stopped');
    }
  });
}

if (import.meta.env.DEV) {
  window.__cadence = {
    piano, sensor, arranger, player, library, Tone,
    get enabled() { return enabled; },
    get isPlaying() { return isPlaying; },
    get backing() { return backing; },
    get deck() { return deck; },
    get mixer() { return mixer; },
    handleKind,
  };
}
