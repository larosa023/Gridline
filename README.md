<p align="center"><img src="build/icon.png" width="96" alt="Gridline" /></p>

<h1 align="center">Gridline</h1>
<p align="center">Modern, lightweight construction takeoff &amp; estimating for Windows.</p>

<p align="center">
  <a href="https://github.com/larosa023/Gridline/releases/latest/download/Gridline-Setup.exe"><b>⬇ Download Gridline for Windows (.exe)</b></a>
  ·
  <a href="https://github.com/larosa023/Gridline/releases">All releases</a>
</p>

---

## What it does

- **Plans** — drop in PDF drawing sets (multi-page). Sheets are auto-named from the title block (e.g. `A-101`) and shown with thumbnails. The sheet list switches between **All** pages and **Current** page only (each PDF also collapses with its arrow), and **×** closes a PDF. *File → Close Project* (`Ctrl+W`) closes everything.
- **Collapsible side panels** — slim tabs on the left and right edges of the drawing tuck each sidebar away and bring it back with one click (`[` left, `]` right, `\` both). The drawing stays put while they slide, and the layout is remembered.
- **Settings** (gear icon, `Ctrl+,`) — theme (dark / light / match Windows), snap on/off and strength, sheet list mode, automatic updates, and per-project units, length display (ft-in or decimal), on-plan labels and estimate markups. Project settings can be saved as defaults for new projects.
- **Scale** — architectural, engineering and metric presets, or **calibrate** from any known dimension. Apply one scale to a whole set.
- **Quick LF / SF toggles** — one click on **LF** or **SF** (or `Tab` to flip between them) and you're measuring; no condition setup required. Each toggle remembers the last condition you used with it, and its ▾ menu switches conditions.
- **Snap to plan lines** — Gridline reads the vector linework in the PDF and snaps to wall corners (□), line crossings (×) and anywhere along a line (◇), plus your existing markup points. `S` toggles it; hold `Ctrl` to place a free point.
- **Takeoff tools**
  - **Linear** — walls, curbs, pipe, trim. Optional height gives wall SF. Set a roof line type (rake or hip/valley) plus pitch to get true sloped length.
  - **Roof** — trace roof planes in plan view and enter the pitch (`6/12`, `6`, or `26.6°`). You get true roof area, **squares**, plan area and perimeter. Override the pitch per roof plane; hold **Alt** to deduct skylights and chimneys. Roofing defaults to 10% waste and pricing per square.
  - **Area** — slabs, flooring, roofing. Optional depth gives CY; hold **Alt** when finishing to make a **deduction** (openings, shafts).
  - **Count** — fixtures, devices, doors, with on-plan numbering.
  - **Quick measure** — one-off dimensions without saving a markup.
  - Shift snaps to 45°/90°. Edit by dragging vertices or whole shapes. Full undo/redo.
- **Conditions** — named takeoff items with color, group/CSI division, waste %, and material + labor unit costs.
- **Estimate** — quantities roll up live into a priced estimate grouped by division, with sales tax, overhead and profit. Choose what each item is priced by (LF, SF, CY, wall SF, EA). **Export to CSV** for Excel.
- **Projects** — a single portable `.gridline` file with the drawings embedded. Double-click to open.
- **Built-in updater** — checks GitHub Releases on launch and every few hours, downloads in the background, then shows **Restart to update**. Also under *Help → Check for Updates*.
- Dark and light themes.

## Install

Download **[Gridline-Setup.exe](https://github.com/larosa023/Gridline/releases/latest/download/Gridline-Setup.exe)** and run it. It installs per-user (no admin needed) and adds Start-menu and desktop shortcuts.

> The installer isn't code-signed yet, so Windows SmartScreen may show *"Windows protected your PC"* the first time. Click **More info → Run anyway**.

## Keyboard shortcuts

| Action | Key | Action | Key |
| --- | --- | --- | --- |
| Select | `V` | Finish shape | `Enter` / double-click / right-click |
| Pan | `H` or hold `Space` | Remove last point | `Backspace` |
| Linear | `L` | Cancel | `Esc` |
| Area | `A` | Fit page | `F` |
| Roof | `R` | Flip Linear ⇄ Area | `Tab` |
| Count | `C` | Prev / next sheet | `PgUp` / `PgDn` |
| Snap on/off | `S` | Free point (no snap) | hold `Ctrl` |
| Measure | `M` | Undo / redo | `Ctrl+Z` / `Ctrl+Y` |
| Calibrate | `K` | Takeoff / Estimate | `Ctrl+1` / `Ctrl+2` |

## Development

```bash
npm install      # also copies PDF.js into src/renderer/vendor
npm start        # run the app
npm test         # measurement + pricing unit tests
npm run dist     # build dist/Gridline-Setup-x.y.z.exe locally (on Windows)
```

Stack: Electron, PDF.js, plain ES modules (no framework, no bundler), electron-builder (NSIS) and electron-updater.

## Shipping an update

```bash
npm run release:patch   # 1.0.0 -> 1.0.1, commits, tags and pushes
```

Any push to `main` that carries a new `version` in `package.json` (or a pushed `v*` tag) runs the **Release** workflow on GitHub Actions: it tests, builds the NSIS installer, and publishes `Gridline-Setup-x.y.z.exe`, `Gridline-Setup.exe` and `latest.yml` to a GitHub Release tagged `vX.Y.Z`. Pushes that don't change the version are skipped. Every installed copy then finds the update on its next check.

## License

MIT
