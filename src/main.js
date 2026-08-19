import './styles.css';
import * as Tone from 'tone';
import { Piano } from './engine/piano.js';
import { TypingSensor } from './engine/typing-sensor.js';
import { Arranger } from './engine/state-model.js';
import { Player } from './engine/player.js';
import { Library } from './library/library.js';
import { Backing } from './engine/backing.js';
import { Soloist } from './engine/soloist.js';
import { detectKey } from './engine/keydetect.js';
import { StemDeck } from './engine/stemdeck.js';
import { Mixer, modeAvailable } from './engine/gate.js';
import { Touch } from './engine/touch.js';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const desktop = window.cadenceDesktop ?? null;

if (desktop?.isDesktop) document.body.classList.add('desktop');
$('platformLabel').textContent = desktop?.isDesktop ? 'Windows 全局输入' : '当前窗口预览';
$('resourceButtonLabel').textContent = desktop?.isDesktop ? '音乐资源' : '导入文件夹';
if (!desktop?.isDesktop) {
  $('pickDir').title = '导入音乐文件夹';
  $('pickDir').setAttribute('aria-label', '导入音乐文件夹');
  $('importHelp').querySelector('.help-title small').textContent = '网页预览需手动选择目录';
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
let refRate = Number(localStorage.getItem('cadence:refRate')) || 3.2;
let toastTimer = null;
let lastRateTune = 0;
let lastUiTick = 0;
let foreground = 0;
let libraryReady = false;
let pendingMusicResource = null;

// —— 轻量可视反馈 ——
const barEls = [];
for (let i = 0; i < 24; i++) {
  const el = document.createElement('i');
  $('bars').appendChild(el);
  barEls.push(el);
}

const scopeEls = [];
for (let i = 0; i < 23; i++) {
  const el = document.createElement('i');
  $('pulseScope').appendChild(el);
  scopeEls.push(el);
}

function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.add('show');
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function animateInput(kind) {
  const orb = $('pulseOrb');
  orb.classList.remove('hit');
  void orb.offsetWidth;
  orb.classList.add('hit');
  setTimeout(() => orb.classList.remove('hit'), 330);

  const weight = kind === 'enter' || kind === 'space' ? 1 : kind === 'back' ? 0.72 : 0.86;
  scopeEls.shift().remove();
  const fresh = document.createElement('i');
  fresh.style.height = `${8 + weight * 36}px`;
  fresh.style.opacity = String(0.45 + weight * 0.45);
  $('pulseScope').appendChild(fresh);
  scopeEls.push(fresh);

  const idx = (sensor.events.length * 7) % barEls.length;
  const bar = barEls[idx];
  bar.style.height = `${10 + weight * 20}px`;
  bar.style.background = 'var(--accent)';
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
  bar.style.background = 'var(--accent)';
  clearTimeout(bar._reset);
  bar._reset = setTimeout(() => { bar.style.height = '3px'; bar.style.background = ''; }, 250);
};

// —— 全局/窗口键盘输入统一进入这一条隐私边界 ——
function handleKind(kind) {
  if (!enabled || !['char', 'back', 'enter', 'space'].includes(kind)) return;
  sensor.push(kind);
  animateInput(kind);

  if (!isPlaying) return;
  if (deck?.playing && mixer && touch) {
    touch.hit(kind === 'space' || kind === 'enter');
    mixer.strike(performance.now() / 1000, kind);
    return;
  }
  if (backing?.playing) {
    let fired = false;
    if (soloist) {
      const midi = soloist.strike(backing.scorePosition, arranger.intensity);
      if (midi !== null) {
        fired = true;
        player.onNote({ midi, vel: 0.72, layer: 'melody' });
      }
    }
    if (fired) {
      backing.duck(0.25 + arranger.intensity * 0.25);
      clearTimeout(window.__cadenceUnduck);
      window.__cadenceUnduck = setTimeout(() => backing.duck(0), 600);
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
  appEl.dataset.enabled = String(enabled);
  appEl.dataset.playing = String(isPlaying);
  $('power').setAttribute('aria-pressed', String(enabled));
  $('playIcon').textContent = isPlaying ? 'Ⅱ' : '▶';
  $('playPause').setAttribute('aria-label', isPlaying ? '暂停' : '播放');
  $('playPause').title = isPlaying ? '暂停' : '播放';

  if (isLoading) {
    $('powerState').textContent = enabled ? '已启用 · 正在准备' : '正在准备';
    $('powerHeadline').textContent = current ? `载入 ${current.title}` : '正在准备音乐';
    $('powerHint').textContent = '第一次解码会稍久一些';
    return;
  }

  if (enabled) {
    $('powerState').textContent = '全局输入已启用';
    $('powerHeadline').textContent = isPlaying ? '去任何地方打字' : '音乐已暂停';
    $('powerHint').textContent = isPlaying ? 'Cadence 会在后台跟随你的节奏' : '键盘监听仍保持启用';
    $('powerLabel').textContent = '停用';
  } else {
    $('powerState').textContent = '未启用';
    $('powerHeadline').textContent = '让键盘接管音乐';
    $('powerHint').textContent = desktop?.isDesktop
      ? '启用后，切到任意应用直接输入'
      : '网页预览仅响应当前页面的输入';
    $('powerLabel').textContent = '启用';
  }
}

function setLoading(value) {
  isLoading = value;
  $('power').disabled = value;
  $('playPause').disabled = value;
  $('next').disabled = value;
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
  $('trackProgress').style.width = `${pct}%`;
  $('trackTime').textContent = formatTime(pos);
  $('trackDuration').textContent = formatTime(duration);
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

function followStemMode(roles) {
  return ['vocal', 'instrument', 'drums'].find((mode) => modeAvailable(mode, roles)) ?? 'vocal';
}

async function loadTrack(item, { autoplay = true } = {}) {
  if (!item || isLoading) return;
  current = item;
  setLoading(true);
  $('npTitle').textContent = item.title;
  $('npComposer').textContent = '准备中…';
  $('sourceTag').textContent = '载入';
  renderList();

  try {
    await ensureAudio();
    stopCurrent();
    current = item;
    loadedItemId = null;
    currentEngine = null;
    stemStartOffset = 0;
    const piece = await library.load(item);

    if (item.stemUrls) {
      currentEngine = 'stems';
      deck = deck || new StemDeck(piano.ctx);
      touch = touch || new Touch(piano.ctx);
      const buffers = {};
      const roles = Object.keys(item.stemUrls);
      for (let i = 0; i < roles.length; i++) {
        $('npComposer').textContent = `载入分轨 ${i + 1}/${roles.length}`;
        const response = await fetch(item.stemUrls[roles[i]]);
        if (!response.ok) throw new Error(`分轨载入失败：${response.status}`);
        buffers[roles[i]] = await response.arrayBuffer();
      }
      await deck.load(buffers, (progress) => {
        $('npComposer').textContent = `解码 ${Math.round(progress * 100)}%`;
      });
      mixer = new Mixer(deck);
      mixer.setRefRate(refRate);
      mixer.setMode(followStemMode(deck.roles));
      deck.onEnded = () => handleTrackEnded();
      stemStartOffset = deck.audibleStart();
      $('npComposer').textContent = '伴奏常驻 · 输入时人声显现';
      $('sourceTag').textContent = '跟手分轨';
      if (autoplay) deck.play(stemStartOffset);
    } else if (item.audioUrl) {
      currentEngine = 'audio';
      backing = backing || new Backing(piano.ctx);
      soloist = soloist || new Soloist(piano);
      $('npComposer').textContent = '载入音频…';
      await backing.load(item.audioUrl);
      if (piece) {
        soloist.fromMidi(piece);
        backing.offset = 0;
        $('npComposer').textContent = '原曲伴奏 · 输入释放旋律';
      } else {
        $('npComposer').textContent = '识别调性…';
        const response = await fetch(item.audioUrl);
        const buffer = await piano.ctx.decodeAudioData(await response.arrayBuffer());
        const key = detectKey(buffer);
        soloist.fromKey(key.tonic, key.mode);
        $('npComposer').textContent = `${key.name} · 输入释放旋律`;
      }
      backing.onEnded = () => handleTrackEnded();
      $('sourceTag').textContent = '音频';
      if (autoplay) await backing.play();
    } else {
      if (!piece) throw new Error('曲目没有可播放内容');
      currentEngine = 'midi';
      soloist = null;
      player.mode = 'hybrid';
      player.load(piece);
      $('npComposer').textContent = `${Math.round(piece.bpm)} BPM · 输入释放装饰音`;
      $('sourceTag').textContent = 'MIDI';
      if (autoplay) player.start();
    }

    loadedItemId = item.id;
    isPlaying = autoplay;
    $('trackDuration').textContent = formatTime(playbackDuration());
    renderList();
  } catch (error) {
    stopCurrent();
    reportError(error);
  } finally {
    setLoading(false);
    updateProgress();
  }
}

function nextItem() {
  if (!queue.length) return null;
  if (!current) return queue[0];
  const index = Math.max(0, queue.findIndex((item) => item.id === current.id));
  if (orderMode === 'shuffle' && queue.length > 1) {
    let next = index;
    while (next === index) next = Math.floor(Math.random() * queue.length);
    return queue[next];
  }
  return queue[(index + 1) % queue.length];
}

async function nextTrack({ autoplay = isPlaying } = {}) {
  const item = nextItem();
  if (!item) return;
  if (!enabled) {
    current = item;
    loadedItemId = null;
    $('npTitle').textContent = item.title;
    $('npComposer').textContent = '启用后播放';
    $('sourceTag').textContent = '待机';
    updateProgress();
    renderList();
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
  $('power').disabled = true;
  try {
    if (next) {
      // 必须在按钮手势内先解锁 WebAudio，再等待任何 IPC。
      await ensureAudio();
      if (desktop?.isDesktop) {
        const state = await desktop.setEnabled(true);
        if (!state?.supported || !state?.enabled) {
          throw new Error(state?.error || 'Windows 全局键盘监听未能启动');
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
    $('power').disabled = false;
    updatePowerUi();
  }
}

function renderOrder() {
  const shuffle = orderMode === 'shuffle';
  $('orderLabel').textContent = shuffle ? '随机' : '顺序';
  $('order').querySelector('.order-icon').textContent = shuffle ? '⤨' : '⇥';
  $('order').title = shuffle ? '随机播放' : '顺序播放';
  $('order').setAttribute('aria-label', `当前为${shuffle ? '随机' : '顺序'}播放`);
}

function renderList() {
  const list = $('list');
  list.innerHTML = '';
  $('emptyLibrary').hidden = queue.length > 0;
  queue.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = item.id === current?.id ? 'on' : '';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `播放 ${item.title}`);

    const number = document.createElement('span');
    number.className = 'track-index';
    number.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('span');
    copy.className = 'list-copy';
    const name = document.createElement('b');
    name.textContent = item.title;
    const source = document.createElement('small');
    source.textContent = item.stemUrls ? '跟手分轨' : item.audioUrl ? '音频' : 'MIDI';
    copy.append(name, source);
    const state = document.createElement('span');
    state.className = 'list-state';
    li.append(number, copy, state);

    const choose = () => {
      if (isLoading) return;
      if (!enabled) {
        current = item;
        loadedItemId = null;
        $('npTitle').textContent = item.title;
        $('npComposer').textContent = '启用后播放';
        $('sourceTag').textContent = '待机';
        renderList();
      } else {
        loadTrack(item, { autoplay: isPlaying }).catch(reportError);
      }
    };
    li.addEventListener('click', choose);
    li.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); }
    });
    list.appendChild(li);
  });
}

function reportError(error) {
  console.error(error);
  $('npComposer').textContent = error?.message || '发生了未知错误';
  $('sourceTag').textContent = '错误';
  showToast(error?.message || '操作失败');
}

$('power').addEventListener('click', () => setEnabled(!enabled));
$('playPause').addEventListener('click', async () => {
  if (isLoading) return;
  if (!enabled) {
    await setEnabled(true);
  } else if (isPlaying) {
    pausePlayback();
  } else {
    await resumePlayback();
  }
});
$('next').addEventListener('click', () => nextTrack({ autoplay: isPlaying }).catch(reportError));
$('order').addEventListener('click', () => {
  orderMode = orderMode === 'sequence' ? 'shuffle' : 'sequence';
  localStorage.setItem('cadence:order', orderMode);
  renderOrder();
  showToast(orderMode === 'shuffle' ? '已切换为随机播放' : '已切换为顺序播放');
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
      if (!result?.ok) throw new Error(result?.error || '音乐资源文件夹无法打开');
      showToast('音乐资源已打开 · 放入歌曲会自动刷新');
      return;
    }
    if (!library.supportsFolder) {
      $('folderInput').click();
      return;
    }
    const result = library.needsPermission ? await library.regrant() : await library.pickFolder();
    if (!result) return;
    showToast(result.count
      ? `已从 ${result.name} 加入 ${result.count} 首音乐`
      : '文件夹里没有找到支持的音乐');
  } catch (error) {
    if (error.name !== 'AbortError') reportError(error);
  }
});

$('folderInput').addEventListener('change', async (event) => {
  const count = await library.addFiles(event.target.files);
  showToast(count ? `已加入 ${count} 首音乐` : '没有找到支持的音乐文件');
  event.target.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (++dragDepth === 1) $('dropzone').classList.add('on');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('on'); }
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('on');
  const count = await library.addFiles(event.dataTransfer.files);
  showToast(count ? `已加入 ${count} 首音乐` : '没有找到支持的音乐文件');
});

// 15Hz 音乐状态更新；进度和自动速度标定使用更低频率。
let lastTick = performance.now() / 1000;
setInterval(() => {
  const now = performance.now() / 1000;
  const dt = now - lastTick;
  lastTick = now;
  const features = sensor.features(now);
  arranger.update(features, dt);

  if (deck?.playing && mixer) {
    const mix = mixer.update(now, dt, features.rate);
    foreground = mix.fg;
    $('sourceTag').textContent = foreground > 0.04 ? '跟手中' : '伴奏';
  } else if (isPlaying && currentEngine === 'midi') {
    player.syncTempo();
  }

  if (now - lastUiTick > 0.18) {
    lastUiTick = now;
    $('stRate').textContent = features.rate.toFixed(1);
    updateProgress();
    scopeEls.forEach((el, index) => {
      if (index < scopeEls.length - 1) {
        const h = Number.parseFloat(el.style.height || '3');
        el.style.height = `${Math.max(3, h * 0.82)}px`;
        el.style.opacity = String(Math.max(0.16, Number(el.style.opacity || 0.2) * 0.9));
      }
    });
  }

  if (now - lastRateTune > 2) {
    lastRateTune = now;
    const typical = sensor.typicalRate();
    if (typical) {
      const target = Math.min(9, Math.max(1.2, typical));
      refRate = refRate * 0.82 + target * 0.18;
      localStorage.setItem('cadence:refRate', String(refRate));
      if (mixer) mixer.setRefRate(refRate);
    }
  }
}, 66);

library.onChange = () => {
  queue = library.items;
  if (current) current = queue.find((item) => item.id === current.id) || current;
  if (!current && queue.length) current = queue[0];
  renderList();
};

function applyMusicResource(payload, notify = false) {
  if (!payload) return 0;
  if (!libraryReady) {
    pendingMusicResource = payload;
    return 0;
  }
  const count = library.setResourceFiles(payload.files || []);
  if (payload.error) showToast(`音乐资源读取失败：${payload.error}`);
  else if (notify) showToast(`音乐资源已刷新 · ${count} 首`);
  return count;
}

renderOrder();
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
  $('npTitle').textContent = current.title;
  $('npComposer').textContent = '启用后播放';
  $('sourceTag').textContent = '待机';
  renderList();
}).catch(reportError);

if (desktop?.isDesktop) {
  desktop.onMusicResourceChange((payload) => applyMusicResource(payload, true));
  desktop.getState().then((state) => {
    if (!state?.supported) {
      $('platformLabel').textContent = '全局监听不可用';
      showToast(state?.error || 'Windows 全局键盘监听不可用');
    }
  }).catch(reportError);
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
