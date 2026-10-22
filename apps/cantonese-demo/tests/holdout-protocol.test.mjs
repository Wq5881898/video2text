import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertExactCoverage, assertSourceIdentity, seal, revealReferenceBodies, validatePlan, ownRecordsOnce, protectSourceFacts } from '../holdout-protocol.mjs';
import { digestFile } from '../model-client.mjs';
import { criticalTranslationIssues } from '../translation-critical-checks.mjs';

test('holdout rejects omitted, repeated, reordered IDs and changed source relations/times', () => {
  const source = [{ id: 'a', start: 0, end: 2, yue: '如果跌到呢度' }, { id: 'b', start: 2, end: 4, yue: '個半月' }];
  assert.throws(() => assertExactCoverage(source, [source[0]]));
  assert.throws(() => assertExactCoverage(source, [source[0], source[0]]));
  assert.throws(() => assertExactCoverage(source, [...source].reverse()));
  assert.throws(() => assertSourceIdentity(source, [{ ...source[0], yue: '已經跌到呢度' }, source[1]]));
  assert.throws(() => assertSourceIdentity(source, [{ ...source[0], end: 3 }, source[1]]));
  assertSourceIdentity(source, source.map(r => ({ ...r, en: 'translated' })));
  assert.throws(() => validatePlan({ paragraphs: [{ title: 'topic', sourceIds: ['a', 'a'] }] }, source));
});

test('reference bodies require both candidate seals and unchanged registered bytes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-gate-'));
  const file = path.join(dir, 'reference.srt');
  await fs.writeFile(file, '1\n00:00:00,000 --> 00:00:02,000\nA reference.\n');
  const manifest = { requireIndependent: true, references: [{ path: file, sha256: await digestFile(file) }] };
  await assert.rejects(() => revealReferenceBodies(dir, manifest));
  await seal(dir, 'source-final', { rows: [{ id: 'a' }] });
  await seal(dir, 'minimax-final', { rows: [{ id: 'a', en: 'Candidate' }] });
  await assert.rejects(() => revealReferenceBodies(dir, manifest));
  await seal(dir, 'independent-final', { rows: [{ id: 'a', en: 'Independent' }] });
  assert.equal((await revealReferenceBodies(dir, manifest))[0].body.includes('A reference.'), true);
  await assert.rejects(() => seal(dir, 'minimax-final', { rows: [{ id: 'a', en: 'Replaced after seeing reference' }] }));
  await fs.appendFile(file, 'changed');
  await assert.rejects(() => revealReferenceBodies(dir, manifest));
});

test('comparison assigns complete crossing/gap/tail records to exactly one owner', () => {
  const groups = [{ start: 0, end: 10 }, { start: 10, end: 20 }];
  const records = [{ id: 'a', start: 8, end: 12, text: 'whole crossing sentence' }, { id: 'b', start: 22, end: 24, text: 'tail' }];
  const owned = ownRecordsOnce(groups, records);
  assert.deepEqual(owned.map(g => g.records.map(r => r.id)), [['a'], ['b']]);
  assert.equal(owned[0].records[0].text, records[0].text);
});

for (const semanticVersion of ['semantic-preservation-v2','semantic-preservation-v3']) test(`${semanticVersion} cannot reveal references before all tracks and relation reviews are present`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'holdout-v2-'));
  const file = path.join(dir, 'ref.srt'); await fs.writeFile(file, '1\n00:00:00,000 --> 00:00:02,000\nReference.');
  const rows = [{id:'a',start:0,end:2,yue:'機會率',en:'The probability.'}];
  const manifest = {requireIndependent:true,semanticPolicy:{version:semanticVersion},references:[{path:file,sha256:await digestFile(file)}]};
  for (const name of ['source-final','minimax-draft','minimax-final','independent-final']) await seal(dir,name,{rows});
  await assert.rejects(()=>revealReferenceBodies(dir,manifest));
  await seal(dir,'chinese-final',{rows});
  await assert.rejects(()=>revealReferenceBodies(dir,manifest));
  for (const variant of ['minimax','independent']) await fs.writeFile(path.join(dir,`relation-audit-${variant}.json`),JSON.stringify({inputSha256:await digestFile(path.join(dir,variant==='minimax'?'minimax-draft.json':'independent-final.json')),checkedIds:['a']}));
  assert.equal((await revealReferenceBodies(dir,manifest)).length,1);
  const auditFile=path.join(dir,'relation-audit-minimax.json');
  const receipt=JSON.parse(await fs.readFile(auditFile,'utf8'));
  const incomplete={...receipt,checkedIds:[],unreviewedIds:['a'],coverageComplete:true,acceptance:false};
  await fs.writeFile(auditFile,JSON.stringify(incomplete));
  await assert.rejects(()=>revealReferenceBodies(dir,manifest));
  await fs.writeFile(auditFile,JSON.stringify({...incomplete,coverageComplete:false}));
  assert.equal((await revealReferenceBodies(dir,manifest)).length,1);
});

test('comparison aligns a cue starting just before the next topic with its actual overlap', () => {
  const groups = [{ start: 172.66, end: 185.46 }, { start: 187.06, end: 214.44 }];
  const records = [
    { id: 'before', start: 171, end: 173, text: 'previous topic' },
    { id: 'next', start: 187.02, end: 189.284, text: 'Now let us look at the 10-year bond yield.' },
    { id: 'tail', start: 216, end: 218, text: 'complete tail' },
  ];
  const owned = ownRecordsOnce(groups, records);
  assert.deepEqual(owned.map(g => g.records.map(r => r.id)), [['before'], ['next', 'tail']]);
  assert.deepEqual(owned.flatMap(g => g.records), records);
  assert.throws(() => ownRecordsOnce([], records));
});

test('fact evidence recovers only whitespace/cue ownership and quarantines invented quantities', () => {
  const rows = [{ id: 'a', yue: '如果息口係peak' }, { id: 'b', yue: '咗啦。' }, { id: 'c', yue: '維持七個percent' }];
  const result = protectSourceFacts([
    { ids: ['a'], sourceQuote: '息口係peak咗啦', requirement: 'peaked' },
    { ids: ['c'], sourceQuote: '維持七十個percent', requirement: '70 percent' },
    { ids: ['c'], sourceQuote: '維持七個percent', requirement: '7 percent' },
  ], rows);
  assert.equal(result.verified.length, 2); assert.equal(result.unverified.length, 1);
  assert.deepEqual(result.verified[0].ids, ['a', 'b']);
  assert.equal(result.verified[0].sourceQuote, '息口係peak 咗啦');
  assert.equal(result.verified[1].sourceQuote, '維持七個percent');
});

test('long duplicated target fragments are review hints and never delete source or target', () => {
  const rows = [{ id: 'a', yue: '呢個指數', en: 'This is the index. You can see it has dropped down.', zh: '' }, { id: 'b', yue: '大家見到佢跌落嚟', en: 'You can see it has dropped down.', zh: '' }];
  const original = JSON.stringify(rows);
  assert.ok(criticalTranslationIssues(rows).some(i => i.code === 'repeated-target-fragment' && i.id === 'b'));
  assert.equal(JSON.stringify(rows), original);
});
