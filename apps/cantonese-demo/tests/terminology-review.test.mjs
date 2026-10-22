import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applyConfirmedTerminology, scanTerminology, planScreenshotChecks, verifyProtectedTerms } from '../terminology-review.mjs';
const lexicon = JSON.parse(fs.readFileSync(new URL('../financial-error-lexicon.json', import.meta.url), 'utf8'));
const row = (id, yue, start = 10) => ({ id, yue, start, end: start + 3 });
const proof = (ruleId, rowId, observedText) => ({ id: 'p', sourceVideoSha256: 'video-a', trust: 'user-confirmed', ruleIds: [ruleId], rowIds: [rowId], observedText, time: 10, frameIds: ['f1'] });

test('index identity normalization covers newly observed spacing without changing market quantities',()=>{
 const rows=[row('a','S P五八指数同Nasdaq嘅一八支持位，跌咗58点。'),row('b','S&P 500同Nasdaq 100指数跌18点。'),row('c','SMP芯片型号58')];
 const fixed=applyConfirmedTerminology(rows,lexicon);
 assert.equal(fixed.rows[0].yue,'S&P 500指数同Nas100支持位，跌咗58点。');
 assert.equal(fixed.rows[1].yue,rows[1].yue);assert.equal(fixed.rows[2].yue,rows[2].yue);
 assert.deepEqual(rows.map(r=>[r.id,r.start,r.end]),fixed.rows.map(r=>[r.id,r.start,r.end]));
});

test('all repeated fixed-term errors are corrected, including two errors in one sentence', () => {
  const source = [row('a', 'Nas一八嘅指数比道指同S M P五八差。'), row('b', 'SMP58指数同S M P五百再创新高。')];
  const result = applyConfirmedTerminology(source, lexicon);
  assert.equal(result.applied.length, 4); assert.equal(result.residual.length, 0);
  assert.ok(result.rows[0].yue.includes('Nas100') && result.rows[0].yue.includes('S&P 500'));
});
test('UST/VST trigger mandatory checks and require matching local evidence', () => {
  const source = [row('a', '派息板块U S T同consumer defensive')];
  assert.equal(applyConfirmedTerminology(source, lexicon).knownTermGate.passed, false);
  const evidence = [proof('real-estate', 'a', 'Real Estate Consumer Defensive Utilities')];
  const fixed = applyConfirmedTerminology(source, lexicon, { evidence, sourceVideoSha256: 'video-a' });
  assert.ok(fixed.rows[0].yue.includes('Real Estate'));
  assert.equal(applyConfirmedTerminology(source, lexicon, { evidence, sourceVideoSha256: 'different-video' }).rows[0].yue, source[0].yue);
  assert.equal(applyConfirmedTerminology(source, lexicon, { evidence: [{ ...evidence[0], trust: 'model-unverified' }], sourceVideoSha256: 'video-a' }).rows[0].yue, source[0].yue);
  assert.ok(planScreenshotChecks(source, lexicon).some(check => check.ruleId === 'real-estate' && check.action === 'required-frame-check'));
});
test('context and period evidence protect genuine numbers and unrelated abbreviations', () => {
  const source = [row('a', '指数目标28,750点，二八天平均线。'), row('b', '这个SMP芯片与UST接口。')];
  const fixed = applyConfirmedTerminology(source, lexicon, { evidence: [proof('ma200', 'a', 'MA(200) 27719.35')], sourceVideoSha256: 'video-a' });
  assert.ok(fixed.rows[0].yue.includes('28,750') && fixed.rows[0].yue.includes('二百天平均线'));
  assert.equal(fixed.rows[1].yue, source[1].yue);
});
test('unconfirmed guesses remain pending; existing correct terms are protected', () => {
  const source = [row('a', '公司credit嘅信態。Bollinger Band同composite正確。')];
  assert.equal(applyConfirmedTerminology(source, lexicon).rows[0].yue, source[0].yue);
  assert.equal(verifyProtectedTerms(source, [row('a', '公司信貸。Bollin Band同compost。')], lexicon).length, 2);
  assert.equal(scanTerminology([row('b', 'S&P 500同Nas100指數')], lexicon).length, 0);
});

test('document year and coupon precision need the exact video, row and local evidence', () => {
  const video = lexicon.documentCorrections[0].sourceVideoSha256;
  const source = [row('s0032', '二零二八年嘅midterm'), row('s0069', '發行九點六利息'), row('other', '二零二八年九點六利息')];
  const evidence = lexicon.documentCorrections.map(rule => ({ ...proof(rule.id, rule.rowIds[0], rule.evidenceText), sourceVideoSha256: video }));
  assert.equal(applyConfirmedTerminology(source, lexicon, { sourceVideoSha256: video }).rows[0].yue, source[0].yue);
  const result = applyConfirmedTerminology(source, lexicon, { sourceVideoSha256: video, evidence });
  assert.equal(result.rows[0].yue, '二零一八年嘅midterm');
  assert.equal(result.rows[1].yue, '發行9.625%');
  assert.equal(result.rows[2].yue, source[2].yue);
  assert.deepEqual(applyConfirmedTerminology(source, lexicon, { sourceVideoSha256: 'other', evidence }).rows.map(r => r.yue), source.map(r => r.yue));
  const noPrecision = { ...lexicon, precisionPolicy: { allowEvidenceBackedPrecision: false } };
  assert.equal(applyConfirmedTerminology(source, noPrecision, { sourceVideoSha256: video, evidence }).rows[1].yue, source[1].yue);
});

test('learned Cantonese expressions require local audio support rather than grammar guessing', () => {
  const source=[row('a','今日嘅video千祈冇錯過。'),row('b','相當於'),row('c','bullish啦'),row('d','如果你係冇彩嘅')];
  const evidence=[['dont-miss-expression','a','千祈唔好错过'],['bullish-degree-expression','b','相当之bullish'],['unlucky-expression','d','唔好彩']].map(([ruleId,rowId,text])=>({
    id:ruleId,time:10,sourceVideoSha256:'audio-video',trust:'machine-audio-reviewed',ruleIds:[ruleId],rowIds:[rowId],
    supportingRecognitions:[{responseId:'normal',variant:'normal',audioSha256:'one',text},{responseId:'slow',variant:'slow',audioSha256:'two',text}]
  }));
  assert.equal(applyConfirmedTerminology(source,lexicon).rows[0].yue,source[0].yue);
  const fixed=applyConfirmedTerminology(source,lexicon,{evidence,sourceVideoSha256:'audio-video'});
  assert.equal(fixed.rows[0].yue,'今日嘅video千祈唔好錯過。');assert.equal(fixed.rows[1].yue,'相當之');assert.equal(fixed.rows[3].yue,'如果你係唔好彩嘅');
  const conflict=structuredClone(evidence);conflict[0].supportingRecognitions[1].text='千祈冇錯過';
  assert.equal(applyConfirmedTerminology(source,lexicon,{evidence:conflict,sourceVideoSha256:'audio-video'}).rows[0].yue,source[0].yue);
  const duplicate=structuredClone(evidence);duplicate[0].supportingRecognitions[1].audioSha256='one';
  assert.equal(applyConfirmedTerminology(source,lexicon,{evidence:duplicate,sourceVideoSha256:'audio-video'}).rows[0].yue,source[0].yue);
});

test('bar spelling needs chart evidence and leaves Chinese names, numbers and valid expressions alone', () => {
  const source=[row('a','呢一个咁大嘅巴跌破二千'),row('b','巴西八天，巴士。相當於两倍。冇彩色。千其唔好气馁。')];
  const evidence=[proof('chart-bar','a','NYSE Up Volume - Down Volume 柱状图')];
  const fixed=applyConfirmedTerminology(source,lexicon,{evidence,sourceVideoSha256:'video-a'});
  assert.equal(fixed.rows[0].yue,'呢一个咁大嘅bar跌破二千');
  assert.equal(fixed.rows[1].yue,'巴西八天，巴士。相當於两倍。冇彩色。千祈唔好气馁。');
});

test('new fixed-expression candidates trigger review while preserving ambiguous words',()=>{
 const source=[row('a','个up trend接近exhaustion，即系冇乜气静。'),row('b','所以我哋仍然系mid-term year，但系个周期唔同。'),row('c','MOVE系兩國債券市場嘅波動指數。'),row('d','今日嘅p v就講到呢度。'),row('e','财务PV代表现值，两国贸易。')];
 const result=applyConfirmedTerminology(source,lexicon);
 assert.deepEqual(result.rows.map(r=>r.yue),source.map(r=>r.yue));assert.equal(result.applied.length,0);
 const matching=result.pending.filter(f=>f.contextMatches).map(f=>f.ruleId);
 for(const id of ['remaining-momentum-expression','concessive-connector-review','measure-verb-review','closing-preview-review'])assert.ok(matching.includes(id),id);
 assert.ok(!result.pending.some(f=>f.rowId==='e'&&f.contextMatches));
});
