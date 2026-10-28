// Copies PDF.js (library, worker, fonts, cmaps, wasm decoders) into src/renderer/vendor
// so the renderer can load it as plain ES modules, fully offline.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'pdfjs-dist');
const dest = path.join(root, 'src', 'renderer', 'vendor', 'pdfjs');

if (!fs.existsSync(pkg)) {
  console.warn('[vendor] pdfjs-dist not installed yet, skipping');
  process.exit(0);
}

fs.rmSync(path.join(root, 'src', 'renderer', 'vendor'), { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });

for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
  fs.copyFileSync(path.join(pkg, 'build', f), path.join(dest, f));
}
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = path.join(pkg, dir);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, dir), { recursive: true });
}
console.log('[vendor] PDF.js copied to src/renderer/vendor/pdfjs');
