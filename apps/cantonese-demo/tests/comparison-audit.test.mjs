import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReferenceRecords, makeCandidateRecords, buildCompleteTimeline, auditTimeline } from '../comparison-audit.mjs';

const refs = makeReferenceRecords([
  { start: 6, text: '开场' }, { start: 17, text: 'CPI公布' },
  { start: 25, text: '息口突然大升，跟住逆转' }, { start: 33, text: '图表' },
  { start: 40, text: '南韩市场及中国市场' }, { start: 49, text: '反弹？' },
], 'yue', Number);
const english = makeReferenceRecords([{ start: 6, text: 'Opening' }, { start: 24, text: 'CPI caused a spike then reversal' }, { start: 46, text: 'China also broke support' }], 'en', Number);
const candidate = makeCandidateRecords([
  { id: 's1', start: 1, end: 8, yue: '额外开场', en: 'Extra opening', zh: '额外开场' },
  { id: 's4', start: 22.42, end: 28.02, yue: 'CPI令息口突然大升', en: 'CPI caused rates to spike', zh: 'CPI令利率大升' },
  { id: 's5', start: 28.2, end: 30.92, yue: '跟住逆转', en: 'then reversed', zh: '随后逆转' },
  { id: 's10', start: 46.46, end: 48.9, yue: '中国跌破支持', en: 'China broke support', zh: '中国跌破支撑' },
  { id: 'tail', start: 58, end: 59, yue: '额外结尾', en: 'Extra tail', zh: '额外结尾' },
]);

test('full timeline retains the previously missing 00:25 baseline and both source boundaries', () => {
  const { groups, originals } = buildCompleteTimeline(refs, english, candidate, 60);
  const audit = auditTimeline(originals, groups, 60);
  assert.equal(audit.passed, true);
  const at25 = groups.find(group => group.anchor === 25);
  assert.equal(at25.referenceYue[0].record.texts.yue, '息口突然大升，跟住逆转');
  assert.deepEqual(at25.candidate.map(item => item.record.originalId), ['s4', 's5']);
  assert.equal(at25.candidate[0].primary, false);
  assert.equal(refs[2].end, null);
  assert.equal(audit.sourceCounts.minimax.primaryRecords, 5);
});

test('coverage audit fails when a whole comparison group is omitted', () => {
  const { groups, originals } = buildCompleteTimeline(refs, english, candidate, 60);
  const audit = auditTimeline(originals, groups.filter(group => group.anchor !== 25), 60);
  assert.equal(audit.passed, false);
  assert.ok(audit.missing.includes('reference-yue-0003'));
  assert.ok(audit.gaps.length);
});

test('coverage audit detects duplicate primary records, changed text and reordered source data', () => {
  const { groups, originals } = buildCompleteTimeline(refs, english, candidate, 60);
  const corrupted = structuredClone(groups);
  corrupted[0].candidate.push(structuredClone(corrupted[0].candidate[0]));
  corrupted[0].referenceYue[0].record.texts.yue = '被改过的开场';
  const audit = auditTimeline(originals, corrupted, 60);
  assert.equal(audit.passed, false);
  assert.ok(audit.invalidPrimary.includes('minimax-s1'));
  assert.ok(audit.changed.includes('reference-yue-0001'));
  assert.throws(() => buildCompleteTimeline([...refs].reverse(), english, candidate, 60), /order changed/);
});
