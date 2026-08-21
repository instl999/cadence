# Cadence v0.1.0 Release Notes

## Included

- Windows 11 system-wide keyboard response with explicit Enable and Disable controls.
- A typing-follow mode based on synchronized vocal and instrumental stems.
- Play, pause, next, sequence, and shuffle controls.
- A fixed `Music Resources/song/files` directory with automatic scanning and refresh.
- Automatic pairing of Ultimate Vocal Remover outputs.
- English-only interface, documentation, sample names, and resource paths.
- Sanitized public packaging with no developer-local songs or test stems.

## Download and Use

Keep `Cadence-0.1.0-Windows.exe` beside the `Music Resources` folder. Cadence creates the example structure on first run if the folder is missing. See the [User Guide](user-guide.en.md) for complete instructions.

## Privacy Boundary

The global hook runs only after the user chooses Enable. Raw key codes are classified briefly in the Electron main process, and the renderer receives only `char`, `back`, `enter`, or `space`. Typed content is not persisted or uploaded. Pause is not the same as Disable; choose Disable or exit Cadence to stop monitoring.

## Known Limitations

- The primary tested target is 64-bit Windows 11.
- Windows code signing is not configured, so SmartScreen may display a warning.
- No commercial music is bundled; users must add music they own or are authorized to use.
- No open-source license has been selected.

## Checksum

The final checksum is regenerated after every package build and is distributed in `SHA256SUMS.txt` beside the release assets.
