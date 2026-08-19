const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

const MUSIC_RESOURCE_NAME = '音乐资源';
const MUSIC_FILE_RE = /\.(mp3|wav|m4a|aac|ogg|opus|flac|webm|mid|midi)$/i;
const RESOURCE_GUIDES = [
  {
    name: '将UVR分离文件放在这里.txt',
    content: `Cadence 音乐导入说明

1. 复制“歌曲名示例”文件夹，并把副本改成真实歌名。
2. 放入同一次 Ultimate Vocal Remover 处理得到的同步分轨：

   歌名_(Vocals).wav
   歌名_(Instrumental).wav

3. 不要只裁剪或变速其中一条。Cadence 会自动刷新播放列表。
4. 推荐 WAV 或高质量 MP3；请只使用你拥有或获准处理的音乐。
`,
  },
  {
    name: 'Import Instructions-English.txt',
    content: `Cadence Music Import Instructions

1. Copy the example folder and rename it to the real song title.
2. Add two synchronized stems from the same Ultimate Vocal Remover run:

   Song Name_(Vocals).wav
   Song Name_(Instrumental).wav

3. Do not trim or time-stretch only one stem. Cadence refreshes automatically.
4. WAV or high-quality MP3 is recommended. Use only music you are authorized to process.
`,
  },
];

function musicResourceRoot() {
  if (process.env.CADENCE_MUSIC_ROOT) return path.resolve(process.env.CADENCE_MUSIC_ROOT);
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, MUSIC_RESOURCE_NAME);
  }
  if (!app.isPackaged) return path.join(app.getAppPath(), MUSIC_RESOURCE_NAME);
  return path.join(path.dirname(process.execPath), MUSIC_RESOURCE_NAME);
}

async function ensureMusicResourceRoot() {
  const root = musicResourceRoot();
  await fsp.mkdir(root, { recursive: true });
  const example = path.join(root, '歌曲名示例');
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

function mediaUrl(filePath) {
  const token = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 32);
  mediaFiles.set(token, filePath);
  return `cadence-media://file/${token}`;
}

function isInsideMusicRoot(filePath) {
  const relative = path.relative(musicResourceRoot(), filePath);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function scanMusicResource() {
  const root = await ensureMusicResourceRoot();
  const records = [];
  const folders = (await fsp.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  for (const folder of folders) {
    const songDir = path.join(root, folder.name);
    const entries = (await fsp.readdir(songDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && MUSIC_FILE_RE.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const entry of entries) {
      const filePath = path.join(songDir, entry.name);
      if (!isInsideMusicRoot(filePath)) continue;
      const info = await fsp.stat(filePath);
      records.push({
        name: entry.name,
        parent: `${folder.name}/`,
        url: mediaUrl(filePath),
        size: info.size,
        lastModified: info.mtimeMs,
      });
    }
  }
  return { name: MUSIC_RESOURCE_NAME, files: records, songFolders: folders.length };
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
    if (!filePath || !isInsideMusicRoot(filePath)) {
      return new Response('Not found', { status: 404 });
    }
    const response = await net.fetch(pathToFileURL(filePath).toString());
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
  if (!uIOhook) throw hookLoadError ?? new Error('全局键盘监听模块不可用');
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

    // 隐私边界：keycode、修饰键和原始事件停留在主进程。
    // 渲染层只会收到音乐所需的四种结构类别。
    mainWindow.webContents.send('cadence:key', { kind });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 760,
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
    const allowed = devUrl ? url.startsWith(devUrl) : url.startsWith('file:');
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
