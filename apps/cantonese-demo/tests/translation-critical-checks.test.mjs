import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalTranslationIssues, sourceEntities } from '../translation-critical-checks.mjs';
test('source financial units, rate objects and comparative direction cannot pass a clean model audit', () => {
  const rows = [{id:'a',yue:'息口升咗十一点六个percent',en:'Their margins are rising.',zh:'上升十一点六个百分点'}, {id:'b',yue:'長期升得冇咁快',en:'The long end rose less slowly.',zh:'长期升得没那么快'}];
  const original = JSON.stringify(rows), codes = criticalTranslationIssues(rows).map(i => i.code);
  assert.deepEqual(codes, ['percent-not-point','rate-not-margin','comparative-direction']);
  assert.equal(JSON.stringify(rows), original);
});

test('split week units and degree negation are checked across original cue boundaries',()=>{
 const rows=[{id:'a',yue:'净五十二个礼',en:'net 52 percent highs',zh:''},{id:'b',yue:'拜嘅高低',en:'and lows',zh:''},
 {id:'c',yue:'啲人唔系真系咁panic啊，去到对冲得好犀利嘅',en:'People were not panicking; their hedging was very aggressive.',zh:''}];
 const codes=criticalTranslationIssues(rows).map(i=>i.code);
 assert.ok(codes.includes('week-not-percent'));assert.ok(codes.includes('negated-degree-hedging'));
 const correct=structuredClone(rows);correct[0].en='net 52-week highs';correct[2].en='People were not panicking enough to hedge that aggressively.';
 assert.ok(!criticalTranslationIssues(correct).some(i=>['week-not-percent','negated-degree-hedging'].includes(i.code)));
 assert.ok(!criticalTranslationIssues([{id:'a',yue:'佢好panic去到对冲得好犀利',en:'Their hedging was very aggressive.',zh:''}]).some(i=>i.code==='negated-degree-hedging'));
});

test('separate PMO and SMP, accept canonical S&P, and require local entity coverage',()=>{
 assert.deepEqual(sourceEntities('P M O S M P五百'),['PMO','S&P']);
 const row={id:'a',yue:'P M O S M P五百嘅买入信号',en:'The S&P 500 buy signal.',zh:''};
 const issues=criticalTranslationIssues([row]).filter(i=>i.code==='ticker-not-found');
 assert.equal(issues.length,1);assert.ok(issues[0].reason.includes('PMO'));assert.ok(!issues[0].reason.includes('PMOSMP'));
 assert.deepEqual(criticalTranslationIssues([{...row,en:'The S&P 500 PMO buy signal.'}]),[]);
 const far=[{id:'a',yue:'U G A',en:'It rose.',zh:''},...Array.from({length:5},(_,i)=>({id:'x'+i,yue:'继续',en:'Continue.',zh:''})),{id:'z',yue:'另一段',en:'UGA',zh:''}];
 assert.ok(criticalTranslationIssues(far).some(i=>i.id==='a'&&i.code==='ticker-not-found'));
});

test('only does not license an unspoken greater-than relation',()=>{
 const r={id:'a',yue:'得嗰二十三个percent',en:'Only just over twenty-three percent.',zh:''};
 assert.ok(criticalTranslationIssues([r]).some(i=>i.code==='only-versus-over'));
 assert.ok(!criticalTranslationIssues([{...r,en:'Only 23 percent.'}]).some(i=>i.code==='only-versus-over'));
 assert.ok(!criticalTranslationIssues([{...r,yue:'超过二十三个percent'}]).some(i=>i.code==='only-versus-over'));
});

test('invented durations and indicator qualifiers are checked without rewriting candidates',()=>{
 const rows=[{id:'a',yue:'半腰呢個futures market一路升',en:'Futures had been rising for almost one and a half months.',zh:''},
 {id:'b',yue:'正常嘅环境入边',en:'Within a normal range.',zh:''},
 {id:'c',yue:'net五十二个礼拜嘅high同low',en:'The 52-week highs and lows.',zh:''}];
 const codes=criticalTranslationIssues(rows).map(i=>i.code);
 for(const c of ['unsupported-duration','circumstances-not-range','net-indicator-qualifier'])assert.ok(codes.includes(c));
 const correct=[{...rows[0],yue:'升咗差唔多一个半月'},{...rows[1],en:'Under normal circumstances.'},{...rows[2],en:'Net 52-week highs and lows.'},{id:'d',yue:'OK',en:'All right.',zh:''}];
 assert.deepEqual(criticalTranslationIssues(correct),[]);
});
test('year and ticker checks accept meaning distributed over consecutive captions', () => {
  const rows = [{id:'a',yue:'二零二三年U G A',en:'Back in',zh:'在2023年'}, {id:'b',yue:'之后',en:'2023, UGA rose.',zh:'随后上升'}];
  assert.deepEqual(criticalTranslationIssues(rows), []);
  const wrong = structuredClone(rows); wrong[1].en='That year the Gasoline Administration rose.';
  assert.deepEqual(criticalTranslationIssues(wrong).map(i=>i.code), ['year-not-found','ticker-not-found']);
  assert.deepEqual(criticalTranslationIssues([{id:'x',yue:'增加三个percentage points',en:'Up three percentage points.',zh:'增加三个百分点'}]), []);
});

test('probability change and moving-average stock proportions require object/relation review',()=>{
 const rows=[{id:'a',yue:'加息機會率有七十percent跌落嚟',en:'The probability has fallen by 70%.',zh:''},{id:'b',yue:'五十天以上股票跌到二十percent',en:'The stocks above the moving average fell to 20 percent.',zh:''}];
 const codes=criticalTranslationIssues(rows).map(i=>i.code);
 assert.ok(codes.includes('probability-change-basis')); assert.ok(codes.includes('stock-proportion-object'));
 const clear=[{id:'a',yue:'五十天以上股票比例跌到二十percent',en:'The percentage of stocks above the 50-day moving average fell to 20 percent.',zh:''}];
 assert.ok(!criticalTranslationIssues(clear).some(i=>i.code==='stock-proportion-object'));
});
