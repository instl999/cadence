# Cadence User Guide (English)

[Home](../README.md) · [简体中文](user-guide.zh-CN.md) · [Development Guide](development.en.md)

## 1. What Cadence Does

Cadence turns typing rhythm into part of a song. It does not restart a sample for every key. Instead, separated tracks share one synchronized timeline: the instrumental keeps playing while typing activity controls the foreground stem. When you stop, the mix settles back toward the instrumental; when you resume, the vocal returns naturally.

The desktop build targets Windows 11. Once enabled, typing in a browser, chat app, document editor, or IDE can drive the music even while Cadence is in the background.

## 2. Before You Start

- **System:** The current build targets and is tested on 64-bit Windows 11.
- **Distribution:** Cadence is a portable `.exe`; no installer is required. Do not place it in a system directory that requires administrator permission for normal file writes.
- **Audio output:** Make sure Windows is not muted and the correct speakers or headphones are selected.
- **Unsigned build:** Code signing is not configured yet, so Windows SmartScreen may warn about the executable. Run only a build from a source you trust and compare its hash with the value published by the project owner.
- **Global monitoring:** The global keyboard hook starts only after you select **Enable**. Pausing music is not the same as disabling monitoring; use **Disable** or exit Cadence when you want monitoring to stop.

## 3. Launch and Everyday Use

1. Keep `Cadence-version-Windows.exe` and the `音乐资源` folder in the same directory.
2. Run Cadence. If `音乐资源` is missing, the app creates it beside the executable with an example folder and instructions.
3. Select a song in the playlist, or import your own music first.
4. Select **Enable**. Large WAV files may take a few seconds to decode on first playback.
5. Switch to any application and start typing. The input rhythm display indicates activity.
6. Use the player controls to pause/resume, move to the next track, or switch between sequence and shuffle.
7. Select **Disable** when finished. Exiting Cadence also stops the global hook.

### Controls

| Control | Purpose | Important detail |
|---|---|---|
| Enable / Disable | Starts or stops Windows-wide keyboard monitoring | Disable does not remove music files |
| Play / Pause | Controls the current song | Monitoring may remain enabled while paused |
| Next | Selects the next song | Shuffle chooses another random song |
| Sequence / Shuffle | Controls automatic track order | The choice is saved locally |
| Playlist item | Selects a song immediately | If playback is active, the new song starts automatically |
| Music Resource | Opens the fixed resource directory | The desktop app watches it for changes |
| `?` | Shows the folder and UVR quick guide | Available by hover, keyboard focus, or click |

<a id="importing-music"></a>
## 4. Importing Music

### 4.1 Required Folder Layout

The desktop app scans only the `音乐资源` folder beside the executable. Each song must have its own direct child folder. Do not place audio files directly in the resource root.

```text
Cadence-0.1.0-Windows.exe
音乐资源/
├─ Sample Song/
│  ├─ Sample Song_(Vocals).wav
│  └─ Sample Song_(Instrumental).wav
└─ Another Song/
   ├─ Another Song_(Vocals).mp3
   └─ Another Song_(Instrumental).mp3
```

Recommended workflow:

1. Select **Music Resource** beside the playlist.
2. Copy the `歌曲名示例` example folder.
3. Rename the copy to the song title.
4. Put the audio or separated stems inside that folder.
5. Return to Cadence. The playlist normally refreshes within about a second; there is no need to select the folder again.

### 4.2 Supported Files

Recognized extensions:

```text
.mp3 .wav .m4a .aac .ogg .opus .flac .webm .mid .midi
```

WAV or a high-quality MP3 is recommended. Actual codec decoding depends on the media support included with Electron/Chromium. Lossless WAV and FLAC files are much larger and require more memory while loading.

### 4.3 Stem Pairing

The full typing-follow effect needs at least one vocal stem and one instrumental stem. The most reliable names are:

```text
Song Name_(Vocals).wav
Song Name_(Instrumental).wav
```

Matching is case-insensitive and recognizes common labels:

| Role | Example labels |
|---|---|
| Vocal | `Vocals`, `Vocal`, `Vox`, `人声` |
| Instrumental | `Instrumental`, `No Vocals`, `Accompaniment`, `Backing`, `伴奏` |
| Extra stems | `Drums`, `Bass`, `Other`, `Piano`, `Guitar`, and Chinese equivalents |

Demucs-style folders containing `vocals.wav`, `drums.wav`, `bass.wav`, and `other.wav` are also recognized. A single normal audio file can still be played, but it cannot provide the complete vocal/instrumental reveal effect. A folder with only one recognized stem also falls back to normal audio playback.

### 4.4 Separating an MP3 with Ultimate Vocal Remover

Ultimate Vocal Remover (UVR) is an independent third-party open-source application and is not bundled with Cadence. Obtain it from the [official UVR website](https://ultimatevocalremover.com/) or the [official GitHub repository](https://github.com/Anjok07/ultimatevocalremovergui). Labels can vary between UVR versions; the following is a practical baseline for Cadence:

1. Open UVR and choose the source MP3 under `Select Input`.
2. Under `Select Output`, choose a temporary directory or the matching Cadence song folder.
3. Choose `MDX-Net` as the `Process Method`.
4. `UVR-MDX-NET Inst HQ 3` is a useful starting model. Different songs may work better with another model; this choice is not mandatory.
5. Prefer `WAV` as the output format.
6. Export both sides. Do not select a configuration that produces only `Vocals Only` or only `Instrumental Only`.
7. Select `Start Processing` and wait for completion.
8. Put both outputs in the same song folder and use the recommended names.

Example:

```text
音乐资源/Sample Song/Sample Song_(Vocals).wav
音乐资源/Sample Song/Sample Song_(Instrumental).wav
```

If UVR produces `Vocals` and `No Vocals`, those names may be kept; Cadence recognizes `No Vocals` as the instrumental. Do not trim only one stem. Both files must start at the same point and retain the same speed and duration to remain synchronized.

## 5. How the Typing-Follow Effect Works

- Every stem uses the same playback start and offset.
- Keyboard activity changes a foreground gain gate; it does not restart vocal samples.
- Continuous typing keeps the vocal present. Stopping produces a short natural fade instead of an abrupt cut.
- Space and Enter are treated as structural boundaries and receive a slightly stronger tactile response.
- A vocal stem may already be silent during an intro or instrumental break; typing cannot create vocals that are not present in that part of the source.

These rules need only timing and event category, not the text you type.

## 6. Privacy, Permissions, and Network Access

### What Is Processed

- After Enable, the Electron main process receives Windows keyboard events through `uiohook-napi`.
- It classifies an event as a regular key, Backspace/Delete, Enter, or Space.
- Modifier keys themselves are ignored.
- The music renderer receives only the category—not the raw key code, character, clipboard content, or reconstructed text.
- Keyboard history is not written to a file, database, or log and is not uploaded.

### What Cadence Does Not Do

- It does not reconstruct or save typed sentences.
- It does not read password fields, the clipboard, or document contents.
- It does not scan arbitrary disk locations outside `音乐资源`.
- It does not upload imported music.

### Network Behavior

Imported music is read locally. When the sampled piano is initialized, `smplr` may download samples from its CDN. If that request fails or the device is offline, Cadence falls back to a local synthesizer. Normal imported-track playback does not require an upload service.

### Recommendation

A system-wide keyboard hook is a sensitive capability. Run only trusted builds and enable Cadence only on devices you own or are authorized to use. To explicitly stop monitoring, select **Disable** or exit the app—not merely Pause.

## 7. Troubleshooting

### Enable was selected, but there is no music

1. Confirm that the playlist contains a selected song.
2. Select Play. Browser audio engines require an intentional user interaction before sound can start.
3. Check the Windows volume mixer, Cadence mute state, and output device.
4. Allow large files—especially multi-hundred-megabyte WAV files—to finish decoding.
5. Try Next to distinguish a single-file problem from a general audio problem.

### Typing in another application has no effect

1. Confirm that the top status says global input is enabled.
2. Ctrl, Alt, Shift, and Windows keys alone are intentionally ignored.
3. Some elevated applications isolate input from a normal-permission process. Prefer running both applications at the same privilege level; running Cadence as administrator for everyday use is not recommended.
4. Disable and enable again, or exit and restart Cadence.

### Files exist under Music Resource but do not appear

- Confirm the layout is `音乐资源/song-name/file`, not files directly in the root.
- Confirm the extension is supported.
- Make sure the file is no longer a partial download and copying has completed.
- If two stems do not pair, use the recommended `(Vocals)` and `(Instrumental)` labels.
- Wait for the automatic refresh. Restart Cadence if the watcher did not update.

### Instrumental plays, but vocals do not follow typing

- Check that the vocal file plays independently in a normal media player.
- Confirm both files resolve to the same song title.
- Make sure UVR did not create an almost-silent vocal output.
- Move to a section that actually contains vocals; an intro or instrumental break may be silent by design.

### Stems drift or start out of sync

- Use two files from the same UVR processing run.
- Do not trim, time-stretch, or prepend silence to just one file.
- Both stems must share the same start point and sample length. Re-run separation from the original source when necessary.

### Automatic refresh fails or a file is locked

- Wait until copying is finished.
- Close UVR if it is still writing the output.
- Avoid read-only, protected, or incompletely synchronized cloud locations.
- Select **Music Resource** and verify that Cadence opens the directory you are editing.

## 8. Updating, Moving, and Removing Cadence

### Update

1. Exit the old version.
2. Back up `音乐资源`.
3. Replace the old `.exe` while keeping the resource folder beside it.
4. Launch the new version and verify the playlist.

### Move to Another Computer or Directory

Copy both the `.exe` and the complete `音乐资源` folder. Keep paired stems together and preserve their relative layout.

### Remove

Cadence is portable. Exit it and delete the `.exe`; delete `音乐资源` separately only if you no longer need the music. A few interface preferences, such as playback order, are stored by Electron/Chromium in the current Windows user's application-data directory and are not removed automatically with the portable file.

## 9. Music Rights

Cadence, UVR, and other separation tools do not grant rights to a recording. Confirm that you have permission to play, modify, and distribute the original recording, MIDI, and separated stems. Do not commit copyrighted songs or stems to the source repository. The project's `.gitignore` excludes common local-music and build directories, but always inspect the staged file list before publishing.
