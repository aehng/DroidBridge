# Posters

`poster.html` is the single design (1280x640). `tools/render-poster.ps1` renders it headless with
Edge or Chrome into `.github/assets/`:

| File | Size | Used by |
|---|---|---|
| `poster-zh.png`, `poster-en.png` | 1600x800 | the README banner |
| `social-preview-zh.png`, `social-preview-en.png` | 1280x640 | the repository social preview (Settings, Social preview) |

```powershell
pwsh tools/render-poster.ps1
```

## After a UI change

1. Capture the app's pages from a release build on an emulator or phone (no "(Debug)" title):
   ```powershell
   pwsh tools/capture-screenshots.ps1 -Serial emulator-5554
   ```
   It sets the dark theme, a clean status bar and each language, taps through Home, Settings,
   Execution & access and Agent connection, and writes `../screenshots/{zh,en}/*.png` (540 px wide).
   The taps are at fractions of the screen, so check the pages after a layout change.
2. Run `pwsh tools/render-poster.ps1` and commit the screenshots and the four posters.

Wording, colors and layout live in `poster.html` (the strings are one JSON block at the bottom).
