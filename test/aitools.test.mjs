import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs, calc, parseSchedule, normTag, suggest } from '../src/renderer/js/aitools.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('validates and coerces tool arguments', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, type: { type: 'string', enum: ['linear', 'area'] }, cost: { type: 'number' }, regions: { type: 'array', items: { type: 'string' } }, deduct: { type: 'boolean' } },
    required: ['name', 'type'],
  };
  let r = validateArgs(schema, { name: 'Brick', type: 'area', cost: '$1,250.50', regions: 'R1.3', deduct: 'false' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.args.cost, 1250.5);
  assert.deepEqual(r.args.regions, ['R1.3']);
  assert.equal(r.args.deduct, false);
  r = validateArgs(schema, '{"name":"X","type":"volume"}');
  assert.ok(r.errors.some((e) => e.includes('one of linear, area')));
  r = validateArgs(schema, { type: 'area' });
  assert.ok(r.errors.some((e) => e.includes('Missing required "name"')));
  r = validateArgs(schema, { name: 'X', type: 'area', cost: 'lots' });
  assert.ok(r.errors[0].startsWith('"cost" should be a number'));
});

test('exact arithmetic with feet-inches, percents and separators', () => {
  close(calc('1,410 + 904'), 2314);
  close(calc('(1500 - 3*6*5) * 1.05'), 1480.5);
  close(calc("12'-6\" * 10"), 125);
  close(calc("8' 4 1/2\""), 8 + 4.5 / 12);
  close(calc('2^3 + -1'), 7);
  close(calc('1000 * 5%'), 50);
  assert.throws(() => calc('1/0'), /Division by zero/);
  assert.throws(() => calc('alert(1)'), /Unexpected/);
  assert.throws(() => calc('2 +'), /end of expression/);
});

test('reads a finish schedule into rows and columns', () => {
  const T = (str, x, y, h = 8) => ({ str, x, y, w: str.length * h * 0.55, h });
  const items = [
    T('EXTERIOR FINISH SCHEDULE', 100, 100, 12),
    T('TAG', 100, 130), T('MATERIAL', 160, 130), T('MANUFACTURER', 360, 130), T('COLOR', 520, 130),
    T('BR-1', 100, 145), T('BRICK VENEER - MODULAR', 160, 145), T('GLEN-GERY', 360, 145), T('RED BLEND', 520, 145),
    T('FC-1', 100, 160), T('FIBER CEMENT LAP SIDING', 160, 160), T('JAMES HARDIE', 360, 160), T('ARCTIC WHITE', 520, 160),
    T('MP-2', 100, 175), T('METAL PANEL', 160, 175), T('', 360, 175), T('CHARCOAL', 520, 175),
    T('NOTES: SEE SPECS', 100, 400), // far below: not part of the table
  ].filter((i) => i.str);
  const s = parseSchedule(items, { title: 'FINISH SCHEDULE' });
  assert.deepEqual(s.columns, ['TAG', 'MATERIAL', 'MANUFACTURER', 'COLOR']);
  assert.equal(s.rows.length, 3);
  assert.deepEqual(s.rows[0], ['BR-1', 'BRICK VENEER - MODULAR', 'GLEN-GERY', 'RED BLEND']);
  assert.deepEqual(s.rows[2], ['MP-2', 'METAL PANEL', '', 'CHARCOAL']);
  assert.equal(parseSchedule(items, { title: 'DOOR SCHEDULE' }), null);
});

test('tags and suggestions', () => {
  assert.equal(normTag('br1'), 'BR-1');
  assert.equal(normTag('see EIFS-2A typ.'), 'EIFS-2A');
  assert.equal(normTag('nothing here'), null);
  assert.deepEqual(suggest('Brick vener', ['Brick veneer', 'Fiber cement siding', 'Carpet tile']), ['Brick veneer']);
  assert.deepEqual(suggest('siding', ['Brick veneer', 'Fiber cement siding']), ['Fiber cement siding']);
});
