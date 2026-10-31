import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx, colName, ST } from '../src/renderer/js/xlsx.js';
import { unzipSync, strFromU8 } from '../src/renderer/vendor/fflate.mjs';
import { writeFileSync } from 'node:fs';

test('column names', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(27), 'AB');
});

test('builds a valid workbook with formulas and escaped text', () => {
  const bytes = buildXlsx([
    { name: 'Estimate', rows: [[{ v: 'Item', s: ST.header }, { v: 'Qty', s: ST.header }], ['Brick <veneer> & "trim"', { v: 1410, s: ST.num }], ['x', { f: 'B2*2', v: 2820, s: ST.money }]], widths: [30, 12], freezeRow: 1 },
    { name: 'Detail/Sheet?', rows: [['a']] },
  ]);
  const files = unzipSync(bytes);
  assert.ok(files['xl/workbook.xml'] && files['xl/worksheets/sheet2.xml'] && files['xl/styles.xml']);
  const s1 = strFromU8(files['xl/worksheets/sheet1.xml']);
  assert.match(s1, /<f>B2\*2<\/f><v>2820<\/v>/);
  assert.match(s1, /Brick &lt;veneer&gt; &amp; &quot;trim&quot;/);
  assert.match(strFromU8(files['xl/workbook.xml']), /name="Detail Sheet "/);
  if (process.env.XLSX_OUT) writeFileSync(process.env.XLSX_OUT, bytes);
});
