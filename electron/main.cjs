const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.commandLine.appendSwitch('lang', 'en-US');

protocol.registerSchemesAsPrivileged([{
  scheme: 'cadence-media',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

let uIOhook = null;
let UiohookKey = null;
let hookLoadError = null;

try {
  ({ uIOhook, UiohookKey } = require('uiohook-napi'));
} catch (error) {
  hookLoadError = error;
}

let mainWindow = null;
let monitoring = false;
let hookRunning = false;
let musicWatcher = null;
let musicRefreshTimer = null;
let mediaProtocolInstalled = false;
const mediaFiles = new Map();

const MUSIC_RESOURCE_NAME = 'Music Resources';
const LEGACY_MUSIC_RESOURCE_NAME = '\u97f3\u4e50\u8d44\u6e90';
const MUSIC_FILE_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mid|midi)$/i;
const RESOURCE_GUIDES = [
  {
    name: 'Import Instructions.txt',
    content: `Cadence Music Import Instructions

1. Copy the "Sample Song" folder and rename it to the real song title.
2. Add synchronized stems from the same Ultimate Vocal Remover run:

   Song Name_(Vocals).wav
   Song Name_(Instrumental).wav

3. Do not trim or time-stretch only one stem. Both files must share the same start point and duration.
4. Cadence refreshes automatically. WAV or high-quality MP3 is recommended.
5. Use only music you own or are authorized to process.
`,
  },
];

function musicResourceParent() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.resolve(process.env.PORTABLE_EXECUTABLE_DIR);
  }
  if (!app.isPackaged) return app.getAppPath();
  return path.dirname(process.execPath);
}

function musicResourceRoot() {
  if (process.env.CADENCE_MUSIC_ROOT) return path.resolve(process.env.CADENCE_MUSIC_ROOT);
  return path.join(musicResourceParent(), MUSIC_RESOURCE_NAME);
}

async function migrateLegacyMusicResourceRoot(root) {
  if (process.env.CADENCE_MUSIC_ROOT) return;
  const legacyRoot = path.join(musicResourceParent(), LEGACY_MUSIC_RESOURCE_NAME);
  try {
    await fsp.access(legacyRoot);
  } catch {
    return;
  }

  let rootExists = true;
  try {
    await fsp.access(root);
  } catch {
    rootExists = false;
  }

  if (!rootExists) {
    try {
      await fsp.rename(legacyRoot, root);
      return;
    } catch {
      throw new Error(`Could not migrate the legacy music folder to "${MUSIC_RESOURCE_NAME}".`);
    }
  }

  // Preserve every legacy file in an English-named backup before merging any
  // non-conflicting songs into the active resource directory.
  const backupBase = path.join(musicResourceParent(), 'Music Resources Legacy Backup');
  let backupRoot = backupBase;
  let suffix = 2;
  while (true) {
    try {
      await fsp.access(backupRoot);
      backupRoot = `${backupBase} ${suffix++}`;
    } catch {
      break;
    }
  }
  try {
    await fsp.rename(legacyRoot, backupRoot);
    await fsp.cp(backupRoot, root, { recursive: true, force: false, errorOnExist: false });
  } catch {
    throw new Error(`Could not merge the legacy music folder. Its backup was preserved.`);
  }
}

async function ensureMusicResourceRoot() {
  const root = musicResourceRoot();
  await migrateLegacyMusicResourceRoot(root);
  await fsp.mkdir(root, { recursive: true });
  const example = path.join(root, 'Sample Song');
  await fsp.mkdir(example, { recursive: true });
  for (const guide of RESOURCE_GUIDES) {
    const guidePath = path.join(example, guide.name);
    try {
      await fsp.access(guidePath);
    } catch {
      await fsp.writeFile(guidePath, guide.content, 'utf8');
    }
  }
  return root;
}

function mediaUrl(filePath, into = mediaFiles) {
  const token = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 32);
  into.set(token, filePath);
  return `cadence-media://file/${token}`;
}

function isInsideMusicRoot(filePath) {
  const relative = path.relative(musicResourceRoot(), filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Strict check for the protocol boundary, where the guarantee actually matters.
 * Resolving links first stops a symlink placed inside Music Resources from
 * reading through to anywhere else on disk.
 */
async function isServableMediaPath(filePath) {
  try {
    const [realFile, realRoot] = await Promise.all([
      fsp.realpath(filePath),
      fsp.realpath(musicResourceRoot()),
    ]);
    const relative = path.relative(realRoot, realFile);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

async function scanMusicResource() {
  const root = await ensureMusicResourceRoot();
  const folders = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  // Read the song folders concurrently. The renderer needs only name, parent,
  // and url, so no per-file stat is required at all.
  const nextTokens = new Map();
  const perFolder = await Promise.all(folders.map(async (folder) => {
    const songDir = path.join(root, folder.name);
    const entries = (await fsp.readdir(songDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && MUSIC_FILE_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    return entries
      .map((entry) => path.join(songDir, entry.name))
      .filter(isInsideMusicRoot)
      .map((filePath) => ({
        name: path.basename(filePath),
        parent: `${folder.name}/`,
        url: mediaUrl(filePath, nextTokens),
      }));
  }));

  // Swap the token table in only on success, so a song removed from the folder
  // stops being fetchable while a failed scan leaves the old set serving.
  mediaFiles.clear();
  for (const [token, filePath] of nextTokens) mediaFiles.set(token, filePath);

  return { name: MUSIC_RESOURCE_NAME, files: perFolder.flat(), songFolders: folders.length };
}

async function safeScanMusicResource() {
  try {
    return await scanMusicResource();
  } catch (error) {
    return { name: MUSIC_RESOURCE_NAME, files: [], songFolders: 0, error: error.message };
  }
}

function installMediaProtocol() {
  if (mediaProtocolInstalled) return;
  protocol.handle('cadence-media', async (request) => {
    const url = new URL(request.url);
    const token = url.hostname === 'file' ? url.pathname.slice(1) : '';
    const filePath = mediaFiles.get(token);
    if (!filePath || !isInsideMusicRoot(filePath) || !(await isServableMediaPath(filePath))) {
      return new Response('Not found', { status: 404 });
    }

    // Forward Range so a media element can request the part it needs instead of
    // pulling the whole file. Status and Content-Range are passed straight back,
    // so a backend that ignores the header still behaves exactly as before.
    const forwarded = new Headers();
    const range = request.headers.get('range');
    if (range) forwarded.set('range', range);

    const response = await net.fetch(pathToFileURL(filePath).toString(), { headers: forwarded });
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, headers });
  });
  mediaProtocolInstalled = true;
}

function publishMusicResource(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cadence:music-resource-change', payload);
  }
}

function queueMusicRefresh() {
  clearTimeout(musicRefreshTimer);
  musicRefreshTimer = setTimeout(async () => {
    publishMusicResource(await safeScanMusicResource());
  }, 900);
}

async function startMusicWatcher() {
  try {
    const root = await ensureMusicResourceRoot();
    musicWatcher?.close();
    musicWatcher = fs.watch(root, { recursive: true }, queueMusicRefresh);
  } catch (error) {
    console.error('[music-resource] watcher unavailable', error);
  }
}

const modifierKeys = new Set();
if (UiohookKey) {
  modifierKeys.add(UiohookKey.Ctrl);
  modifierKeys.add(UiohookKey.CtrlRight);
  modifierKeys.add(UiohookKey.Alt);
  modifierKeys.add(UiohookKey.AltRight);
  modifierKeys.add(UiohookKey.Shift);
  modifierKeys.add(UiohookKey.ShiftRight);
  modifierKeys.add(UiohookKey.Meta);
  modifierKeys.add(UiohookKey.MetaRight);
}

function keyKind(keycode) {
  if (!UiohookKey || modifierKeys.has(keycode)) return null;
  if (keycode === UiohookKey.Backspace || keycode === UiohookKey.Delete) return 'back';
  if (keycode === UiohookKey.Enter || keycode === UiohookKey.NumpadEnter) return 'enter';
  if (keycode === UiohookKey.Space) return 'space';
  return 'char';
}

function publishState(extra = {}) {
  const state = {
    desktop: true,
    platform: process.platform,
    supported: Boolean(uIOhook),
    enabled: monitoring,
    error: hookLoadError?.message ?? null,
    ...extra,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('cadence:monitoring-state', state);
  }
  return state;
}

function startHook() {
  if (!uIOhook) throw hookLoadError ?? new Error('The global keyboard monitoring module is unavailable');
  if (hookRunning) return;
  uIOhook.start();
  hookRunning = true;
}

function stopHook() {
  if (!uIOhook || !hookRunning) return;
  uIOhook.stop();
  hookRunning = false;
}

async function setMonitoring(enabled) {
  const next = Boolean(enabled);
  try {
    if (next) startHook();
    else stopHook();
    monitoring = next;
    return publishState();
  } catch (error) {
    monitoring = false;
    hookRunning = false;
    return publishState({ supported: false, error: error.message });
  }
}

if (uIOhook) {
  uIOhook.on('keydown', (event) => {
    if (!monitoring || !mainWindow || mainWindow.isDestroyed()) return;
    const kind = keyKind(event.keycode);
    if (!kind) return;

    // Privacy boundary: raw key codes, modifiers, and native events stay in the main process.
    // The renderer receives only the four structural categories required by the music engine.
    mainWindow.webContents.send('cadence:key', { kind });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 452,
    height: 828,
    minWidth: 390,
    minHeight: 640,
    backgroundColor: '#0b0d0c',
    show: false,
    autoHideMenuBar: true,
    title: 'Cadence',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0d0c',
      symbolColor: '#9b9b91',
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  const devUrl = process.env.CADENCE_DEV_URL;
  if (devUrl) mainWindow.loadURL(devUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Compare origins rather than string prefixes: "http://localhost:5173" is
    // also a prefix of "http://localhost:51730.example.com".
    let allowed = false;
    try {
      const target = new URL(url);
      allowed = devUrl ? target.origin === new URL(devUrl).origin : target.protocol === 'file:';
    } catch {
      allowed = false;
    }
    if (!allowed) event.preventDefault();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

ipcMain.handle('cadence:get-state', () => publishState());
ipcMain.handle('cadence:set-enabled', (_event, enabled) => setMonitoring(enabled));
ipcMain.handle('cadence:get-music-resource', () => safeScanMusicResource());
ipcMain.handle('cadence:open-music-resource', async () => {
  try {
    const root = await ensureMusicResourceRoot();
    const error = await shell.openPath(root);
    return { ok: !error, error: error || null };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    installMediaProtocol();
    await ensureMusicResourceRoot().catch((error) => {
      console.error('[music-resource] setup failed', error);
    });
    createWindow();
    await startMusicWatcher();
  });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  app.on('before-quit', () => {
    monitoring = false;
    stopHook();
    clearTimeout(musicRefreshTimer);
    musicWatcher?.close();
    musicWatcher = null;
  });
  app.on('window-all-closed', () => app.quit());
}
