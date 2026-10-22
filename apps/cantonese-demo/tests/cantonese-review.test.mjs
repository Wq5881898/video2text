import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYueParagraphs, auditYueParagraphs, validateReviewChecks } from '../cantonese-review.mjs';

const refs = [{ start: '0:01', text: '市場跌破支持位' }, { start: '0:03', text: '200天平均線' }];
const units = ['市場', '跌破', '支持位。', '二八天', '平均线。'].map((text, i) => ({ chunkIndex: 0, unitIndex: i, text, start: i + 1, end: i + 2 }));
const defs = [{ from: 1, to: 1, title: '市场' }, { from: 2, to: 2, title: '均线', anchor: '二八天平均线' }];

test('whole paragraphs preserve all original records and ASR words exactly once', () => {
  const paragraphs = buildYueParagraphs(refs, units, defs);
  assert.deepEqual(paragraphs.map(p => p.asrText), ['市場跌破支持位。', '二八天平均线。']);
  assert.equal(auditYueParagraphs(refs, units, paragraphs).passed, true);
  assert.throws(() => auditYueParagraphs(refs, units, paragraphs.slice(1)), /reference record/);
  const repeated = structuredClone(paragraphs); repeated[1].units.unshift(units[2]);
  assert.throws(() => auditYueParagraphs(refs, units, repeated), /ASR unit/);
});
test('missing, repeated and inside-word anchors cannot silently pick a range', () => {
  assert.throws(() => buildYueParagraphs(refs, units, [defs[0], { ...defs[1], anchor: '二百天' }]), /exactly once/);
  assert.throws(() => buildYueParagraphs(refs, units, [defs[0], { ...defs[1], anchor: '八天平均线' }]), /splits an ASR word/);
  assert.throws(() => buildYueParagraphs(refs, [...units, { ...units[3], unitIndex: 5 }, { ...units[4], unitIndex: 6 }], defs), /exactly once/);
});
test('critical quantities and names cannot be normalized into a fabricated match', () => {
  const paragraphs = buildYueParagraphs(refs, units, defs);
  const item = { id: 'ma', paragraph: 2, label: '均线', status: 'different', reference: '200天平均線', asr: '二八天平均线', reason: '周期错误' };
  assert.equal(validateReviewChecks(paragraphs, [item]).accepted, false);
  assert.throws(() => validateReviewChecks(paragraphs, [{ ...item, asr: '二百天平均线' }]), /quote not in original/);
  const number = [{ ...paragraphs[0], referenceText: '5.069', asrText: '5.69' }];
  assert.throws(() => validateReviewChecks(number, [{ ...item, paragraph: 1, reference: '5.069', asr: '5.069' }]), /quote not in original/);
});
