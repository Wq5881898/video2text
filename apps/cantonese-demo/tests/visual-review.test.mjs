import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLocalChanges, validateVisualReview, canonicalizeVisualPatches, partitionReviewedRows } from '../visual-review.mjs';

test('review applies explicit non-overlapping edits and rejects silent rewriting', () => {
  const source = [{ id: 'a', start: 1, end: 5, yue: '呢個X指數用二八天平均線。' }];
  const change = { from: '二八天', to: '二百天', category: 'number', basis: 'visual', frameIds: ['f1'], reason: '同图明确均线周期', confidence: 'high' };
  const payload = { rows: [{ id: 'a', yue: '呢個X指數用二百天平均線。', changes: [change], issues: [] }], visualTerms: [{ text: 'MA(200)', frameIds: ['f1'] }] };
  const result = validateVisualReview(payload, source, ['f1']);
  assert.equal(result.rows[0].start, 1); assert.equal(result.rows[0].end, 5);
  assert.throws(() => validateVisualReview({ ...payload, rows: [{ ...payload.rows[0], yue: '這個指數使用二百天平均線。' }] }, source, ['f1']), /Untracked rewrite/);
  assert.throws(() => applyLocalChanges('甲乙丙', [{ from: '甲乙', to: 'A' }, { from: '乙丙', to: 'B' }]), /Overlapping/);
});
test('invented frames, missing rows and unsupported numeric corrections fail validation', () => {
  const source = [{ id: 'a', yue: '5.069' }];
  const change = { from: '5.069', to: '5.089', category: 'number', basis: 'language_context', frameIds: [], reason: '猜测', confidence: 'high' };
  const payload = { rows: [{ id: 'a', yue: '5.089', changes: [change], issues: [] }], visualTerms: [] };
  assert.throws(() => validateVisualReview(payload, source, ['f1']), /Numeric correction needs visual evidence/);
  assert.throws(() => validateVisualReview({ ...payload, rows: [] }, source, ['f1']), /row count/);
  assert.throws(() => validateVisualReview({ ...payload, rows: [{ ...payload.rows[0], changes: [{ ...change, basis: 'visual', frameIds: ['invented'] }] }] }, source, ['f1']), /Unknown visual/);
});
test('patch reconstruction discards contradictory free-form text and logs it', () => {
  const source = [{ id: 'a', yue: '甲指數升。' }];
  const change = { from: '甲', to: '乙' };
  const result = canonicalizeVisualPatches({ rows: [{ id: 'a', yue: '丙指數跌。', changes: [change, { from: '升', to: '升' }], issues: [] }], visualTerms: [] }, source);
  assert.equal(result.payload.rows[0].yue, '乙指數升。');
  assert.equal(result.payload.rows[0].changes.length, 1);
  assert.equal(result.warnings.length, 2);
  assert.equal(result.payload.rows[0].issues.length, 1);
});
test('paragraph layout splits only display ownership and never repeats a cue body', () => {
  const units = ['甲。', '乙', '指數。'].map((text, i) => ({ chunkIndex: 0, unitIndex: i, text }));
  const source = [{ id: 'a', start: 1, end: 3, yue: '甲。乙指數。', sourceUnits: [[0, 0], [0, 1], [0, 2]] }];
  const reviewed = [{ ...source[0], yue: '甲。丙指數。', changes: [{ from: '乙', to: '丙' }] }];
  const result = partitionReviewedRows(source, units, reviewed, new Map([['0:0', 0], ['0:1', 1], ['0:2', 1]]), 2);
  assert.deepEqual(result.map(row => row.reviewedText), ['甲。', '丙指數。']);
  assert.equal(result.map(row => row.rawText).join(''), source[0].yue);
});
test('paragraph reconstruction respects the original caption outer whitespace trim', () => {
  const units = [{ chunkIndex: 0, unitIndex: 0, text: 'consumer ' }];
  const source = [{ id: 'a', start: 1, end: 2, yue: 'consumer', sourceUnits: [[0, 0]] }];
  const reviewed = [{ ...source[0], changes: [] }];
  assert.equal(partitionReviewedRows(source, units, reviewed, new Map([['0:0', 0]]), 1)[0].reviewedText, 'consumer');
});
test('low-confidence numeric suggestions remain review issues and never overwrite source', () => {
  const source = [{ id: 's1', start: 0, end: 2, yue: '二零零七年' }];
  const model = { rows: [{ id: 's1', yue: '二零零六年', changes: [{ from: '二零零七年', to: '二零零六年', category: 'number', basis: 'visual', frameIds: ['f0'], reason: '猜测年份', confidence: 'low' }], issues: [] }], visualTerms: [] };
  const canonical = canonicalizeVisualPatches(model, source);
  const result = validateVisualReview(canonical.payload, source, ['f0']);
  assert.equal(result.rows[0].yue, source[0].yue);
  assert.equal(result.rows[0].changes.length, 0);
  assert.ok(result.rows[0].issues.some(issue => issue.reason.includes('低置信')));
});
