import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMiniMaxUnits, captionMiniMaxUnits } from '../minimax-asr.mjs';

test('MiniMax offsets use actual word times and reject mismatched source text', () => {
  const raw = { text: '跌7 percent。', segments: [{ start: 1, end: 1.2, text: '跌' }, { start: 1.2, end: 1.3, text: '7' }, { start: 1.3, end: 2, text: 'percent。' }] };
  const units = normalizeMiniMaxUnits(raw, 443.61, 440, 1);
  const rows = captionMiniMaxUnits(units);
  assert.equal(rows[0].start, 444.61); assert.equal(rows[0].end, 445.61);
  assert.equal(rows[0].yue, '跌7 percent。');
  assert.throws(() => normalizeMiniMaxUnits({ ...raw, text: '跌70 percent。' }, 0, 440, 0), /differ/);
});

test('caption grouping preserves every unit, including short phrases and punctuation', () => {
  const units = [
    { start: 0, end: 0, text: '啊', chunkIndex: 0, unitIndex: 0 },
    { start: 0.1, end: 0.5, text: '唔係。', chunkIndex: 0, unitIndex: 1 },
    { start: 2, end: 2.3, text: '係。', chunkIndex: 0, unitIndex: 2 },
    { start: 3, end: 3.5, text: '我哋', chunkIndex: 1, unitIndex: 0 },
    { start: 3.5, end: 3.5, text: '。', chunkIndex: 1, unitIndex: 1 },
  ];
  const rows = captionMiniMaxUnits(units);
  assert.equal(rows.map(r => r.yue).join(''), '啊唔係。係。我哋。');
  assert.equal(rows.flatMap(r => r.sourceUnits).length, units.length);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].end - rows[1].start < 0.8, true);
});

test('soft caption limits do not separate a spoken number from percent', () => {
  const texts = ['跌咗', '七', '個', 'percent', '啊。'];
  const units = texts.map((text, i) => ({ text, start: i, end: i + 1, chunkIndex: 0, unitIndex: i }));
  const rows = captionMiniMaxUnits(units, { maxSeconds: 2, maxCharacters: 4 });
  assert.ok(rows.some(row => row.yue.includes('七個percent')));
  assert.equal(rows.map(r => r.yue).join(''), '跌咗七個percent啊。');
});
