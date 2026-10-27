import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { modelTool } from '../model-client.mjs';
import { applyLocalChanges, validateVisualReview, canonicalizeVisualPatches, quarantineVisualEvidence, partitionReviewedRows } from '../visual-review.mjs';

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
test('bad frame claims are quarantined, numbers stay unchanged, and cached responses cost no second call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-evidence-'));
  try {
    const source = [{ id: 'a', start: 1, end: 4, yue: 'SMP升5%。' }];
    const known = { from: 'SMP', to: 'S&P', category: 'term', basis: 'visual', frameIds: ['f1'], reason: '同图指数名称', confidence: 'high' };
    const unverified = { from: '5%', to: '7%', category: 'number', basis: 'visual', frameIds: ['other-slide'], reason: '未附的画面', confidence: 'high' };
    const payload = { rows: [{ id: 'a', yue: 'S&P升7%。', changes: [known, unverified], issues: [{ text: '5%', suggestion: '', reason: '待核对', frameIds: ['f0000'], action: 'requires-review' }] }], visualTerms: [{ text: 'S&P', frameIds: ['f1'] }, { text: '7%', frameIds: ['other-slide'] }] };
    let calls = 0;
    const options = { prompt: 'unchanged request', input: { targetRows: source }, tool: { name: 'submit_review', input_schema: {} }, maxRepairs: 0,
      fetchImpl: async () => { calls++; return Response.json({ content: [{ type: 'tool_use', name: 'submit_review', input: payload }] }); } };
    const config = { apiKey: 'synthetic', baseUrl: 'https://unit.invalid', model: 'MiniMax-M3' };
    await assert.rejects(modelTool(dir, 'batch', config, { ...options, validate: p => validateVisualReview(canonicalizeVisualPatches(p, source).payload, source, ['f1']) }), /Unknown visual/);
    const result = await modelTool(dir, 'batch', config, { ...options, validate: p => {
      const q = quarantineVisualEvidence(canonicalizeVisualPatches(p, source).payload, source, ['f1']);
      assert.equal(q.quarantinedEvidence.length, 3);
      return validateVisualReview(q.payload, source, ['f1']);
    } });
    assert.equal(calls, 1);
    assert.equal(result.rows[0].yue, 'S&P升5%。');
    assert.equal(result.rows[0].start, 1); assert.equal(result.rows[0].end, 4);
    assert.deepEqual(result.rows[0].changes, [known]);
    assert.ok(result.rows[0].issues.some(i => i.rejectedChange?.to === '7%' && i.action === 'requires-review'));
    assert.deepEqual(result.visualTerms, [{ text: 'S&P', frameIds: ['f1'] }]);
  } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw Error('Refusing cleanup outside temporary directory');
    await fs.rm(dir, { recursive: true, force: true });
  }
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
