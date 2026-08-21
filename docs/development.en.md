# Cadence Development and Release Guide (English)

[Home](../README.md) | [User Guide](user-guide.en.md)

## 1. Stack and Environment

- Electron 43, Vite 7, and vanilla JavaScript/HTML/CSS
- Tone.js, smplr, and `@tonejs/midi`
- `uiohook-napi` for Windows-wide keyboard events
- electron-builder for the portable Windows target

64-bit Windows 11 is recommended. The Node.js version must satisfy the currently locked Vite dependency; Node.js 22.12 or later is recommended. Keep `package-lock.json` with every dependency change.

## 2. Install and Commands

```powershell
npm install
npm run midi
npm run dev
npm run build
npm run desktop
npm run package:win
```

| Command | Purpose |
|---|---|
| `npm run midi` | Generates `public/midi/manifest.json` and built-in MIDI assets |
| `npm run dev` | Starts the Vite browser preview; keyboard input is page-local |
| `npm run build` | Produces `dist/` |
| `npm run desktop` | Builds and launches the Electron desktop app |
| `npm run package:win` | Excludes local songs with `--no-local`, builds the portable `.exe`, then merges examples and documentation |

The browser preview is useful for fast UI work, but it cannot validate the global hook, external resource root, custom media protocol, or Explorer integration. Verify those paths in Electron.

## 3. Repository Layout

```text
electron/
  main.cjs            Electron lifecycle, global hook, resource scan, IPC
  preload.cjs         Minimal contextBridge surface
scripts/
  build-midi.mjs      Builds the MIDI manifest
  prepare-release.mjs Merges example music resources into release output
src/
  main.js             UI state, transport, and engine orchestration
  styles.css          UI styling
  library/library.js  Local grouping, stem recognition, and cache
  engine/             Playback, gating, analysis, and typing rhythm
  shared/             Rules used by both the renderer and the build scripts
tests/                Unit tests for the pure logic, run by the Node test runner
Music Resources/
  Sample Song/        User example copied beside release builds
public/midi/           Maintained or generated built-in resources
docs/                  Chinese and English documentation
```

Do not commit these directories:

```text
node_modules/ dist/ release/
local-midi/ local-audio/ local-stems/
public/midi/local/ public/midi/audio/ public/midi/stems/
public/midi/manifest.json
```

They can contain large generated artifacts or copyrighted user music. Everything under `Music Resources` except `Sample Song` is ignored as well. Still inspect `git status` and the staged diff before every publication.

`public/midi/manifest.json` is generated, not authored. `build-midi.mjs` rewrites it on every `npm run dev`, `npm run build`, and `npm run build:release`, and it names whatever currently sits in `local-midi/`, `local-audio/`, and `local-stems/` — so tracking it would put private song titles into source control even though the media itself is ignored. Every command that runs the app regenerates it first, so nothing depends on a committed copy.

## 4. Runtime Architecture

### Electron Main Process

`electron/main.cjs` is responsible for:

- The single-instance lock and window lifecycle.
- Loading `uiohook-napi` and starting the global hook only after explicit user enablement.
- Classifying raw key codes as `char`, `back`, `enter`, or `space`.
- Ensuring that `Music Resources` exists beside the executable.
- Scanning the fixed “one song folder, then files” layout.
- Watching changes with `fs.watch` and a debounce.
- Registering opaque, hashed `cadence-media://` URLs so absolute paths are not exposed to the renderer.
- Opening the resource directory through Electron `shell.openPath`.

### Preload Security Boundary

`electron/preload.cjs` exposes a minimal interface under `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. Input categories are allow-listed. The renderer has no direct Node.js access and does not receive raw key codes.

### Renderer and Library

`src/main.js` owns enablement and loading state, transport controls, sequence/shuffle, playlist behavior, drag-and-drop, and UI updates. The stem mixer is rendered by `renderMixer()` and metered by `updateMeters()`, which reads the gains the `Mixer` actually applied rather than recomputing them. Desktop input arrives through preload; the browser preview uses only page-local `keydown` events.

`src/library/library.js` normalizes built-in MIDI, normal audio, selected browser folders, dropped files, and desktop resources into playable entries. Stems are grouped by directory and cleaned title. Any set the mixer can drive becomes a typing entry, from a two-stem UVR pair to a four-stem Demucs split; a set with nothing to reveal against falls back to normal audio.

## 5. Keyboard Privacy Data Flow

```text
Windows keydown
  -> uiohook-napi (raw event in main process)
  -> keyKind() (immediate classification)
  -> IPC sends only { kind }
  -> TypingSensor stores timestamp + category
  -> gain gate and tactile feedback
```

Non-negotiable constraints:

- Do not send `event.keycode` or modifier state to the renderer.
- Do not record characters, reconstruct text, or persist input events.
- Enable starts the hook; Disable and app exit stop it.
- Pause intentionally does not equal Disable. The UI and documentation must keep this distinction explicit.

Any feature that changes this boundary is a security- and privacy-sensitive change and requires focused review.

## 6. Music Resource Contract

### Root Resolution

- Development: `Music Resources` under the project root.
- Windows portable build: `PORTABLE_EXECUTABLE_DIR/Music Resources`.
- Other packaged layouts: `Music Resources` beside `process.execPath`.
- Tests may isolate the root with `CADENCE_MUSIC_ROOT`.

### Scan and Security Rules

- Only direct child directories of `Music Resources` are scanned; each is one song container.
- Only allow-listed extensions are read.
- Absolute file paths are never returned over IPC. The main process creates hashed tokens and `cadence-media://file/<token>` URLs.
- The protocol handler revalidates that every resolved file remains under the music root.

### Stem Recognition

`library.js` strips extensions, normalizes titles, and detects role labels. A Vocal + Instrumental pair becomes a full stem entry; an incomplete set falls back to normal audio.

All role rules live in one table, `src/shared/stem-roles.js`, which both the renderer and `scripts/build-midi.mjs` import. Add labels there and nowhere else.

Two properties of that table are load-bearing:

- **Row order.** The instrumental patterns are tested before the vocal patterns because `no_vocals` contains `vocals`. Reversing them files a Demucs instrumental as the vocal stem and silently drops the real vocals.
- **The `titleProne` column.** Words that also appear in ordinary song titles — `piano`, `guitar`, `backing` — are matched only inside a parenthesized UVR marker, never against a bare filename, so `Piano Man.mp3` stays a song rather than becoming an `other` stem. Separator tools write canonical bare names, so nothing real is missed.

`tests/stem-roles.test.js` and `tests/library.test.js` lock both properties down. Run `npm test` after any edit to the table.

## 7. Playback Model

The core model is synchronized stems plus an input-controlled gain gate—not one sample start per key:

```text
final output = background stems × background coefficient
             + foreground stem × typing activity
             + anchor stem × constant level
             + subtle per-key tactile transient
```

### Choosing the Foreground Stem

A mode in `gate.js` names only the stems that typing reveals. Everything else the track carries becomes background automatically, so a two-stem UVR pair and a four-stem Demucs split both work without enumerating combinations.

`availableModes(roles)` returns every mode a stem set supports, and drives two things: whether `library.js` treats the set as a typing entry at all, and which buttons the picker shows. A set that supports no mode—a lone stem with nothing to reveal against—falls back to normal audio. The listener's choice is stored in `cadence:stemMode` and reused on any track that can honour it.

`ANCHOR_ROLE` is the stem that holds a constant level regardless of typing, so the track always keeps a foundation. It defaults to `bass` and is exempt from the background duck. It is gated only when it is itself the stem the listener chose to reveal.

All stems share an AudioContext timeline, start time, and offset. Key events update the activity model and tactile layer; stem gains move smoothly. This prevents fast typing from turning vocals into repeated fragments.

The input sensor retains timestamps and four event categories and derives musical features such as rate, interval variation, correction rate, and paragraph boundaries. Space and Enter receive a slightly stronger tactile accent without revealing typed text.

## 8. Build and Release

```powershell
npm ci
npm run build
npm run package:win
```

Primary output:

```text
release/
  Cadence-<version>-Windows.exe
  Music Resources/
    Sample Song/
```

The release build first runs `scripts/build-midi.mjs --no-local`, which removes only generated local-media copies under `public/midi` and never touches the original `local-*` files. `scripts/prepare-release.mjs` then copies documentation and the example music resource.

That copy is restricted to the folders named in `RELEASE_SONG_FOLDERS` — currently just `Sample Song`, mirroring the `.gitignore` allow-list. Copying all of `Music Resources` would put whatever the developer has been testing with into the public package, which is exactly what the README promises does not happen. Every other song folder is reported and skipped:

```text
  [music-resource] excluded 1 local song folder(s): My Test Song
```

The script does not delete anything already sitting in `release/`, because that directory is build output rather than something it owns. It does warn when it finds song folders there that it did not put there:

```text
  [music-resource] WARNING: release\win-unpacked\Music Resources still contains My Test Song.
  [music-resource] Delete release/ and package again before publishing.
```

Treat that warning as blocking. Delete `release/` and package again rather than publishing the artifact.

The executable is currently unsigned. Before a public release:

1. Configure a trusted Windows code-signing certificate.
2. Generate a SHA-256 checksum and publish it with release notes.
3. Push source to GitHub without committing `release/` or user music.
4. Attach the `.exe` as a GitHub Release asset; it may exceed the normal Git blob size limit.
5. Choose and add an explicit `LICENSE` before making the repository public.

## 9. Verification Checklist

### Static and Build Checks

```powershell
npm test
node --check electron/main.cjs
node --check electron/preload.cjs
npm run build
```

`npm test` runs the Node test runner over `tests/`, with no extra dependency to
install. It covers the pure logic where mistakes are quiet rather than loud:
stem-role recognition, playlist grouping, MIDI salience ranking, key detection,
the typing feature window, and the gain gate. Run it before every release and
after any change to `src/shared/stem-roles.js`.

### Desktop Smoke Test

- The final portable build starts with a single app instance.
- Music Resource opens the directory beside the `.exe`.
- The example folder exists and the `?` help is complete.
- Adding a real UVR pair automatically creates one stem playlist entry.
- The entry decodes and supports play, pause, and next.
- With Enable active, typing in another normal-permission app drives the music.
- Disable stops the response, and app exit leaves no Cadence process behind.
- Sequence/shuffle, direct playlist selection, and offline synth fallback work.

### Security Regression

- IPC still carries only an allow-listed `kind`.
- The custom media protocol cannot read outside `Music Resources`.
- External navigation and new windows remain blocked.
- The renderer retains `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.

## 10. Common Development Problems

### `uiohook-napi` fails to load

Check that the Node/Electron architecture matches the locked dependency. The project unpacks the native module through `asarUnpack` and pins its version in `package.json`. Re-test the packaged executable after every Electron or native-module upgrade.

### Browser preview works, desktop audio does not

Browser and Electron paths differ for `file://`, the custom scheme, and audio permissions. Test with `npm run desktop` and keep the relative `base: './'` in `vite.config.js`.

### Local songs unexpectedly appear in a build

`npm run midi` reads `local-midi`, `local-audio`, and `local-stems` for development previews. Always use `npm run package:win` for a public package: it invokes `--no-local` and clears generated copies under `public/midi`. Do not publish the output of an ordinary local `npm run build` as the release artifact.

## 11. Licensing and Third-Party Components

The repository currently has no project-level `LICENSE`; do not assume an open-source grant. The publisher should choose a license and review attribution and license requirements for Electron, Tone.js, smplr, uiohook, UVR models, and bundled assets. Recording, MIDI transcription, and separated-stem rights must be confirmed independently.
