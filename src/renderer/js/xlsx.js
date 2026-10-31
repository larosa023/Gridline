// Minimal Excel (.xlsx) writer: inline strings, numbers, formulas with cached values,
// a handful of styles (header, money, number, percent, bold totals), column widths and frozen header.
import { zipSync, strToU8 } from '../vendor/fflate.mjs';

const escXml = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

export function colName(i) {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

// Style ids (cellXfs order below)
export const ST = { text: 0, header: 1, money: 2, num: 3, pct: 4, bold: 5, boldMoney: 6, group: 7, title: 8, int: 9 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2B3340"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF0F3"/></patternFill></fill></fills>
<borders count="2"><border/><border><top style="thin"><color rgb="FF8A94A3"/></top></border></borders>
<cellStyleXfs count="1"><xf/></cellStyleXfs>
<cellXfs count="10">
<xf/>
<xf fontId="1" fillId="2" applyFont="1" applyFill="1"/>
<xf numFmtId="164" applyNumberFormat="1"/>
<xf numFmtId="165" applyNumberFormat="1"/>
<xf numFmtId="10" applyNumberFormat="1"/>
<xf fontId="2" borderId="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="164" fontId="2" borderId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf fontId="2" fillId="3" applyFont="1" applyFill="1"/>
<xf fontId="3" applyFont="1"/>
<xf numFmtId="3" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, c) {
  if (c == null || c === '') return '';
  if (typeof c !== 'object') c = { v: c };
  const s = c.s != null ? ` s="${c.s}"` : '';
  if (c.f != null) {
    const v = typeof c.v === 'number' && isFinite(c.v) ? `<v>${c.v}</v>` : '';
    return `<c r="${ref}"${s}><f>${escXml(c.f)}</f>${v}</c>`;
  }
  if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
  if (c.v == null || c.v === '') return c.s != null ? `<c r="${ref}"${s}/>` : '';
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escXml(c.v)}</t></is></c>`;
}

function sheetXml({ rows, widths = [], freezeRow = 0 }) {
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
  const pane = freezeRow ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${freezeRow}" topLeftCell="A${freezeRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${(row || []).map((c, ci) => cellXml(colName(ci) + (r + 1), c)).join('')}</row>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/** sheets: [{ name, rows: [[cell]], widths?: [chars], freezeRow?: n }] → Uint8Array (.xlsx) */
export function buildXlsx(sheets) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('')}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((sh, i) => `<sheet name="${escXml(sh.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
  };
  sheets.forEach((sh, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sh)));
  const zipped = {};
  for (const [k, v] of Object.entries(files)) zipped[k] = strToU8(v);
  return zipSync(zipped, { level: 6 });
}
