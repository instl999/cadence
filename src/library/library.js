import { get, set, del } from 'idb-keyval';
import { parseMidi } from '../engine/analyze.js';

const DIR_KEY = 'cadence:music-dir';
const LEGACY_DIR_KEY = 'cadence:midi-dir';
const MIDI_RE = /\.midi?$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|webm)$/i;

const STEM_ROLE = [
  [/(?:no[\s_.-]?vocals?|instrumental|accompaniment|karaoke|backing|伴奏)/i, 'instrumental'],
  [/(?:vocals?|lead[\s_.-]?vox|\bvox\b|人声)/i, 'vocals'],
  [/(?:drums?|鼓组?|鼓)/i, 'drums'],
  [/(?:bass|贝斯|低音)/i, 'bass'],
  [/(?:other|piano|guitar|其他|钢琴|吉他)/i, 'other'],
];
const FILE_STEM_ROLE = [
  [/(?:^|[\s_.-])(?:no[\s_.-]?vocals?|instrumental|accompaniment|karaoke|backing|伴奏)(?:$|[\s_.-])/i, 'instrumental'],
  [/(?:^|[\s_.-])(?:vocals?|lead[\s_.-]?vox|vox|人声)(?:$|[\s_.-])/i, 'vocals'],
  [/(?:^|[\s_.-])(?:drums?|鼓组?|鼓)(?:$|[\s_.-])/i, 'drums'],
  [/(?:^|[\s_.-])(?:bass|贝斯|低音)(?:$|[\s_.-])/i, 'bass'],
  [/(?:^|[\s_.-])(?:other|piano|guitar|其他|钢琴|吉他)(?:$|[\s_.-])/i, 'other'],
];

function withoutExtension(name) {
  return name.replace(/\.[^.]+$/, '');
}

function cleanTitle(name) {
  return name.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function pathParent(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index + 1);
}

function pathLeaf(path) {
  const parts = path.replace(/\/$/, '').split('/');
  return parts.at(-1) || '';
}

function stemInfo(name, parent) {
  const bare = withoutExtension(name);
  const marker = bare.match(/\(([^)]+)\)/);
  const role = marker
    ? (STEM_ROLE.find(([pattern]) => pattern.test(marker[1])) || [])[1]
    : (FILE_STEM_ROLE.find(([pattern]) => pattern.test(bare)) || [])[1];
  if (!role) return null;

  let base = marker
    ? bare.slice(0, marker.index)
    : bare.replace(/(?:^|[\s_.-]+)(?:no[\s_.-]?vocals?|instrumental|accompaniment|karaoke|backing|vocals?|lead[\s_.-]?vox|vox|drums?|bass|other|piano|guitar|人声|伴奏|鼓组?|鼓|贝斯|低音|其他|钢琴|吉他).*$/i, '');
  base = cleanTitle(base.replace(/[\s_.-]+$/, ''));

  // Demucs 常把 vocals.wav / no_vocals.wav 放进以歌曲命名的子目录。
  if (!base) base = cleanTitle(pathLeaf(parent));
  return base ? { base, role } : null;
}

function songKey(parent, title) {
  return `${parent}${title}`.normalize('NFKC').toLocaleLowerCase();
}

/** 将原曲、MIDI 与 UVR/Demucs 分轨归并成统一播放条目。 */
export function groupMusicRecords(records) {
  const buckets = new Map();
  const bucketFor = (parent, title) => {
    const key = songKey(parent, title);
    if (!buckets.has(key)) {
      buckets.set(key, { parent, title, audio: null, midi: null, stems: {} });
    }
    return buckets.get(key);
  };

  for (const record of records) {
    const parent = record.parent ?? pathParent(record.path || '');
    if (MIDI_RE.test(record.file.name)) {
      const title = cleanTitle(withoutExtension(record.file.name));
      bucketFor(parent, title).midi ??= record.file;
      continue;
    }
    if (!AUDIO_RE.test(record.file.name)) continue;

    const stem = stemInfo(record.file.name, parent);
    if (stem) {
      bucketFor(parent, stem.base).stems[stem.role] ??= record.file;
    } else {
      const title = cleanTitle(withoutExtension(record.file.name));
      bucketFor(parent, title).audio ??= record.file;
    }
  }
  return [...buckets.values()];
}

/** 曲库来源：内置曲目、用户选定的音乐文件夹、拖入的音乐文件。 */
export class Library {
  constructor() {
    this.items = [];
    this.cache = new Map();
    this.dirHandle = null;
    this.needsPermission = false;
    this.onChange = () => {};
    this.objectUrls = new Set();
  }

  async init() {
    await this.loadBuiltins();
    await this.restoreFolder();
    this.onChange();
  }

  async loadBuiltins() {
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}midi/manifest.json`);
      const manifest = await res.json();
      for (const m of manifest) {
        this.items.push({
          ...m,
          source: m.builtin === false ? 'local' : 'builtin',
          audioUrl: m.audio ? `${import.meta.env.BASE_URL}${m.audio}` : null,
          stemUrls: m.stems
            ? Object.fromEntries(Object.entries(m.stems)
                .map(([k, v]) => [k, `${import.meta.env.BASE_URL}${v}`]))
            : null,
          get: m.file
            ? async () => (await fetch(`${import.meta.env.BASE_URL}${m.file}`)).arrayBuffer()
            : null,
        });
      }
    } catch (err) {
      console.error('[library] 内置曲目加载失败', err);
    }
  }

  get supportsFolder() { return typeof window.showDirectoryPicker === 'function'; }

  async pickFolder() {
    if (!this.supportsFolder) throw new Error('当前环境不支持文件夹访问，请使用拖入文件');
    const handle = await window.showDirectoryPicker({ id: 'cadence-music', mode: 'read' });
    await set(DIR_KEY, handle);
    await del(LEGACY_DIR_KEY).catch(() => {});
    this.dirHandle = handle;
    this.needsPermission = false;
    const count = await this.scanFolder();
    this.onChange();
    return { name: handle.name, count };
  }

  async restoreFolder() {
    if (!this.supportsFolder) return;
    const handle = await get(DIR_KEY).catch(() => null)
      || await get(LEGACY_DIR_KEY).catch(() => null);
    if (!handle) return;
    const perm = await handle.queryPermission({ mode: 'read' });
    this.dirHandle = handle;
    if (perm !== 'granted') {
      this.needsPermission = true;
      return;
    }
    await this.scanFolder();
  }

  async regrant() {
    if (!this.dirHandle) return false;
    const perm = await this.dirHandle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return false;
    this.needsPermission = false;
    const count = await this.scanFolder();
    this.onChange();
    return { name: this.dirHandle.name, count };
  }

  _revokeSource(source) {
    for (const item of this.items) {
      if (item.source !== source) continue;
      if (item.audioUrl?.startsWith?.('blob:')) {
        URL.revokeObjectURL(item.audioUrl);
        this.objectUrls.delete(item.audioUrl);
      }
      for (const url of Object.values(item.stemUrls || {})) {
        if (!url?.startsWith?.('blob:')) continue;
        URL.revokeObjectURL(url);
        this.objectUrls.delete(url);
      }
    }
  }

  _url(file) {
    const url = URL.createObjectURL(file);
    this.objectUrls.add(url);
    return url;
  }

  _mediaUrl(file) {
    return file.url || this._url(file);
  }

  async _fileBuffer(file) {
    if (file.url) {
      const response = await fetch(file.url);
      if (!response.ok) throw new Error(`音乐文件读取失败：${response.status}`);
      return response.arrayBuffer();
    }
    return file.arrayBuffer();
  }

  _itemsFromRecords(records, source) {
    const items = [];
    for (const bucket of groupMusicRecords(records)) {
      const stemEntries = Object.entries(bucket.stems);
      const hasPair = Boolean(bucket.stems.vocals && bucket.stems.instrumental);
      const idBase = `${source}:${bucket.parent}${bucket.title}`;
      const composer = cleanTitle(bucket.parent.replace(/\/$/, ''))
        || ({ folder: '本地音乐文件夹', resource: '音乐资源', drop: '拖入的音乐' }[source] || '本地音乐');
      const getMidi = bucket.midi ? async () => this._fileBuffer(bucket.midi) : null;

      if (hasPair) {
        items.push({
          id: idBase,
          title: bucket.title,
          composer: `分离音轨 · ${composer}`,
          source,
          stemUrls: Object.fromEntries(stemEntries.map(([role, file]) => [role, this._mediaUrl(file)])),
          get: getMidi,
        });
        continue;
      }

      // 单独伴奏轨也能播放；完整 UVR 双轨才启用跟手显隐。
      const fallbackAudio = bucket.audio
        || bucket.stems.instrumental
        || bucket.stems.vocals
        || stemEntries[0]?.[1];
      if (fallbackAudio) {
        items.push({
          id: idBase,
          title: bucket.title,
          composer,
          source,
          audioUrl: this._mediaUrl(fallbackAudio),
          get: getMidi,
        });
      } else if (bucket.midi) {
        items.push({
          id: idBase,
          title: bucket.title,
          composer,
          source,
          get: getMidi,
        });
      }
    }
    return items;
  }

  setResourceFiles(files = []) {
    this._revokeSource('resource');
    this.items = this.items.filter((item) => item.source !== 'resource');
    for (const key of this.cache.keys()) {
      if (key.startsWith('resource:')) this.cache.delete(key);
    }
    const records = files
      .filter((file) => file?.name && file?.url)
      .map((file) => ({ file, parent: file.parent || '' }));
    const additions = this._itemsFromRecords(records, 'resource')
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    this.items.push(...additions);
    this.onChange();
    return additions.length;
  }

  async scanFolder() {
    this._revokeSource('folder');
    this.items = this.items.filter((item) => item.source !== 'folder');
    const records = [];
    await this._walk(this.dirHandle, '', records, 0);
    const found = this._itemsFromRecords(records, 'folder')
      .sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    this.items.push(...found);
    return found.length;
  }

  async _walk(dir, prefix, out, depth) {
    if (depth > 4) return;
    for await (const entry of dir.values()) {
      if (entry.kind === 'directory') {
        await this._walk(entry, `${prefix}${entry.name}/`, out, depth + 1);
      } else if (AUDIO_RE.test(entry.name) || MIDI_RE.test(entry.name)) {
        out.push({ file: await entry.getFile(), parent: prefix });
      }
    }
  }

  async addFiles(fileList) {
    const records = [];
    for (const file of fileList) {
      if (!AUDIO_RE.test(file.name) && !MIDI_RE.test(file.name)) continue;
      const relative = file.webkitRelativePath || file.name;
      records.push({ file, parent: pathParent(relative) });
    }
    if (!records.length) return 0;

    const additions = this._itemsFromRecords(records, 'drop');
    const newIds = new Set(additions.map((item) => item.id));
    this.items = this.items.filter((item) => !newIds.has(item.id));
    this.items.push(...additions);
    this.onChange();
    return additions.length;
  }

  async forgetFolder() {
    await del(DIR_KEY);
    await del(LEGACY_DIR_KEY).catch(() => {});
    this.dirHandle = null;
    this.needsPermission = false;
    this._revokeSource('folder');
    this.items = this.items.filter((item) => item.source !== 'folder');
    this.onChange();
  }

  async load(item) {
    if (!item.get) return null;
    if (this.cache.has(item.id)) return this.cache.get(item.id);
    const buf = await item.get();
    const piece = parseMidi(buf, {
      id: item.id, title: item.title, composer: item.composer, source: item.source,
    });
    this.cache.set(item.id, piece);
    return piece;
  }
}
