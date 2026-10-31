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
- **Appearance** — themes (Dark, Midnight, Slate, Light, Paper, High contrast), accent colours, and **dark drawings**: show sheets as Dark (charcoal paper, light linework — coloured lines keep their hue), Blueprint, or Low glare. A faint-line boost keeps light hatching and small text readable. Measurements, markups and the assistant always use the real drawing. `Ctrl+Shift+D` toggles dark drawings.
- **Command palette** (`Ctrl+K`) — type to run any action, jump to a sheet or condition, switch themes, or open a recent project.
- **Autosave & recovery** — unsaved work is saved in the background every 90 seconds; if Gridline closes unexpectedly it offers to recover it next time.
- **Recent projects** on the start screen, **sheet search** in the Sheets panel, and a **condition library** that saves conditions (with tags, costs and waste) for reuse across projects.
- **Settings** (gear icon, `Ctrl+,`) — theme (dark / light / match Windows), snap on/off and strength, sheet list mode, automatic updates, and per-project units, length display (ft-in or decimal), on-plan labels and estimate markups. Project settings can be saved as defaults for new projects.
- **Scale** — architectural, engineering and metric presets, or **calibrate** from any known dimension. Apply one scale to a whole set.
- **Quick LF / SF toggles** — one click on **LF** or **SF** (or `Tab` to flip between them) and you're measuring; no condition setup required. Each toggle remembers the last condition you used with it, and its ▾ menu switches conditions.
- **Smart tools (free, offline)**
  - **Auto-scale** — when you add drawings, each sheet's scale is read from its title block (`SCALE: 1/4" = 1'-0"`, `1" = 20'`, `1:100`). Auto scales are tagged *auto* so you can spot-check them; also available from the scale menu and a sheet's right-click menu.
  - **Fill (`B`)** — click inside a room or facade zone and its area is traced from the linework, corners snapped exactly. Hatching (brick coursing, siding laps, diagonal hatch) is ignored so a whole zone fills at once. Alt+click makes a deduction. If walls have a gap (a door opening with no swing), Gridline tells you instead of guessing. Gap tolerance is in Settings.
  - **Find matching symbols** — with the Count tool, drag a box around one symbol and Gridline finds every match on the sheet, including rotated ones. Review them (click a ring to skip it, slide for fewer/more) and press **Add**.
- **AI assistant (free, runs on your PC)** — click **Ask** (or press `/`) and tell it what to do: *"read the scale on every sheet"*, *"fill every room on A-101 as Carpet tile"*, *"count all the door tags"*, *"make a 6/12 roof condition at $145 a square"*, *"what are my totals?"*. It uses Gridline's own tools (auto-scale, Fill, counts, conditions, pricing) and can look at the sheet. Everything it does in one request is a single **Undo**.
  - Needs [Ollama](https://ollama.com/download) running on the same PC (no account needed). On first use the panel offers a one-click download of the recommended model (Qwen 3.8 27B, ~18 GB — a 24 GB GPU like an RTX 4090 runs it well). Any installed Ollama model with tool support can be picked from the panel.
  - **Measures from the real linework, not by eye.** It finds each view on a sheet (e.g. "1 – Proposed Front Elevation"), finds every closed zone in it, ignoring hatching, reads the finish tags inside each zone, and measures exact areas with openings (windows, doors, storefront) deducted automatically.
  - **Plans its work** as a visible checklist, **searches every sheet** for schedules and notes, **reads schedules as tables**, and does all math with an exact calculator — no mental arithmetic.
  - **Measures by finish tag** — conditions carry tags (BR-1, FC-1…); each zone is measured into the condition whose tag is inside it. Untagged zones are matched by hatch pattern (also against other elevations) and **flagged with a ?** for you to confirm; windows, doors and storefront are recognised as openings. **Check flagged** jumps through anything it wasn't sure about.
  - **Remembers project decisions** (e.g. "BR-1 = brick veneer per A-701") and checks tool inputs, suggesting the right sheet or condition name when one is mistyped.
  - **Detailed and self-checking.** Every markup is labeled by view or area, the estimate can show a **breakdown by sheet & view**, and the CSV export includes a takeoff-detail section. Before it reports back, the assistant reviews an image of its markups on the drawing and fixes anything off.
  - Drawings never leave your computer.
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
| Fill room | `B` | Find matches | Count tool, drag a box |
| Command palette | `Ctrl+K` | Dark drawings | `Ctrl+Shift+D` |
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
