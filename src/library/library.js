import { get, set, del } from 'idb-keyval';
import { roleFromMarker, roleFromFileName, ROLE_SUFFIX_RE } from '../shared/stem-roles.js';
import { availableModes } from '../engine/gate.js';

const DIR_KEY = 'cadence:music-dir';
const LEGACY_DIR_KEY = 'cadence:midi-dir';
const MIDI_RE = /\.midi?$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|webm)$/i;

// @tonejs/midi is only needed once a track that actually carries MIDI is opened,
// so it is imported on demand instead of shipping in the initial chunk.
let parseMidiPromise = null;
const loadParseMidi = () => (parseMidiPromise ??= import('../engine/analyze.js').then((m) => m.parseMidi));

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
  const role = marker ? roleFromMarker(marker[1]) : roleFromFileName(bare);
  if (!role) return null;

  let base = marker ? bare.slice(0, marker.index) : bare.replace(ROLE_SUFFIX_RE, '');
  base = cleanTitle(base.replace(/[\s_.-]+$/, ''));

  // Demucs commonly places vocals.wav or no_vocals.wav inside a song-named directory.
  if (!base) base = cleanTitle(pathLeaf(parent));
  return base ? { base, role } : null;
}

function songKey(parent, title) {
  // Case folding stays locale-independent on purpose: under a Turkish locale
  // toLocaleLowerCase maps "I" to a dotless "ı" and stems stop grouping.
  return `${parent}${title}`.normalize('NFKC').toLowerCase();
}

/** Merge original audio, MIDI, and UVR/Demucs stems into unified playlist entries. */
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

/** Library sources include built-in tracks, a selected folder, and dropped files. */
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
      console.error('[library] Built-in tracks failed to load', err);
    }
  }

  get supportsFolder() { return typeof window.showDirectoryPicker === 'function'; }

  async pickFolder() {
    if (!this.supportsFolder) throw new Error('Folder access is unavailable in this environment; drop files instead');
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

  /** Release every object URL an item holds; a blob stays alive until revoked. */
  _revokeItem(item) {
    for (const url of [item.audioUrl, ...Object.values(item.stemUrls || {})]) {
      if (!url?.startsWith?.('blob:')) continue;
      URL.revokeObjectURL(url);
      this.objectUrls.delete(url);
    }
  }

  _revokeSource(source) {
    for (const item of this.items) {
      if (item.source === source) this._revokeItem(item);
    }
  }

  /** Release everything; call before discarding the library. */
  revokeAll() {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
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
      if (!response.ok) throw new Error(`Music file reading failed: ${response.status}`);
      return response.arrayBuffer();
    }
    return file.arrayBuffer();
  }

  _itemsFromRecords(records, source) {
    const items = [];
    for (const bucket of groupMusicRecords(records)) {
      const stemEntries = Object.entries(bucket.stems);
      // Any stem set the mixer can drive becomes a typing entry, not just the
      // vocals + instrumental pair. A four-stem Demucs split has no
      // "instrumental" file at all, and used to collapse to a single stem.
      const playableModes = availableModes(stemEntries.map(([role]) => role));
      const hasPair = playableModes.length > 0;
      const idBase = `${source}:${bucket.parent}${bucket.title}`;
      const composer = cleanTitle(bucket.parent.replace(/\/$/, ''))
        || ({ folder: 'Local Music Folder', resource: 'Music Resources', drop: 'Dropped Music' }[source] || 'Local Music');
      const getMidi = bucket.midi ? async () => this._fileBuffer(bucket.midi) : null;

      if (hasPair) {
        items.push({
          id: idBase,
          title: bucket.title,
          composer: `Separated Stems — ${composer}`,
          source,
          stemUrls: Object.fromEntries(stemEntries.map(([role, file]) => [role, this._mediaUrl(file)])),
          get: getMidi,
        });
        continue;
      }

      // A single backing stem can play, but the complete reveal effect requires a UVR pair.
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
      .sort((a, b) => a.title.localeCompare(b.title, 'en'));
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
      .sort((a, b) => a.title.localeCompare(b.title, 'en'));
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
    // Replaced entries own object URLs that nothing else references. Revoke them
    // before dropping the items, or re-importing a folder pins every earlier copy.
    for (const item of this.items) {
      if (newIds.has(item.id)) this._revokeItem(item);
    }
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
    const [parseMidi, buf] = await Promise.all([loadParseMidi(), item.get()]);
    const piece = parseMidi(buf, {
      id: item.id, title: item.title, composer: item.composer, source: item.source,
    });
    this.cache.set(item.id, piece);
    return piece;
  }
}
