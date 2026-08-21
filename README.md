# Cadence

Cadence turns keyboard activity into music. It is a local Windows 11 desktop app that responds to typing across applications and uses input timing to reveal synchronized music stems.

[User Guide](docs/user-guide.en.md) | [Development Guide](docs/development.en.md) | [Release Notes](docs/release-notes-v0.1.0.md)

## Highlights

- System-wide keyboard response on Windows 11.
- Monitoring starts only after **Enable** and stops on **Disable** or app exit.
- Raw key codes are classified in the Electron main process; the renderer receives only `char`, `back`, `enter`, or `space`.
- Vocal and instrumental stems remain synchronized while typing controls vocal presence.
- A fixed `Music Resources/song/files` directory is scanned and watched automatically.
- Play, pause, next, sequence, shuffle, and direct playlist selection.
- Portable Windows build with no installer required.

## Quick Start

Keep the executable and resource folder side by side:

```text
Cadence-0.1.0-Windows.exe
Music Resources/
└─ Sample Song/
   ├─ Sample Song_(Vocals).wav
   └─ Sample Song_(Instrumental).wav
```

Run Cadence, select a track, choose **Enable**, and start typing in any application. See the [User Guide](docs/user-guide.en.md) for complete UVR separation and import instructions.

## Privacy Summary

The global keyboard hook must receive operating-system keyboard events to detect activity, but Cadence does not persist typed characters, reconstructed text, clipboard content, or key history. Pausing playback does **not** disable monitoring. Choose **Disable** or exit Cadence when monitoring should stop.

Imported music is read locally and is not uploaded. The sampled piano may make a one-time CDN request through `smplr`; Cadence falls back to a local synthesizer when offline.

## Music Resources

The desktop build scans only direct song folders inside `Music Resources`. Audio files placed directly in the resource root are ignored.

Recommended UVR pair:

```text
Music Resources/Sample Song/Sample Song_(Vocals).wav
Music Resources/Sample Song/Sample Song_(Instrumental).wav
```

Recognized formats:

```text
.mp3 .wav .m4a .aac .ogg .opus .flac .webm .mid .midi
```

Cadence recognizes common English stem labels such as `Vocals`, `Instrumental`, `No Vocals`, `Drums`, `Bass`, and `Other`. Legacy non-English labels remain compatible internally through escaped matching rules, without exposing non-English interface text.

## Development

```powershell
npm install
npm run dev          # Browser preview with page-local input
npm run desktop      # Build and launch the desktop app
npm run package:win  # Create the sanitized portable Windows package
```

`npm run package:win` excludes developer-local songs from the public package. See the [Development Guide](docs/development.en.md) for architecture, testing, and release details.

## Copyright and License

Only process, play, or redistribute music you own or are authorized to use. Stem separation does not change the copyright status of a recording.

This repository currently has no project-level open-source `LICENSE`. Choose one before making the repository public or accepting external contributions.
