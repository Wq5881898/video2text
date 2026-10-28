import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sourceQualityFacts, validateQualityDraft, repairSourceGroundedEnglish, qualitySourceIssues, ENGLISH_QUALITY_POLICY } from '../english-quality.mjs';
import { applyEnglishReview, quarantineEnglishReview, runCantones, CANTONES_PROFILE } from '../cantones-workflow.mjs';
import { applyConfirmedTerminology } from '../terminology-review.mjs';
import { sourceHash } from '../workflow-checks.mjs';
import { digest } from '../model-client.mjs';
import { criticalTranslationIssues } from '../translation-critical-checks.mjs';
const row=(id,yue,en='',i=0)=>({id,yue,en,start:i*4,end:i*4+3.5,zh:'',reviewed:false,stale:false});
const patch=(id,from,to,sourceQuote)=>({id,from,to,sourceQuote,reason:'Restore source-aligned clause'});

test('annual yields are derived from source numerals, not a reference or plot, and monthly amounts are excluded',()=>{
  const rows=[row('a','十年債券息口由四厘去到四厘七三二。'),row('b','回到三點九厘八二，跌破三點八厘息口。')];
  assert.deepEqual(sourceQualityFacts(rows).map(f=>f.value),[4,4.732,3.982,3.8]);
  assert.equal(sourceQualityFacts([row('m','貸款每月月息五厘，另有十年債券圖。')]).length,0);
  assert.equal(sourceQualityFacts([row('x','五厘錢買紙，沒有利率語境。')]).length,0);
  assert.equal(sourceQualityFacts([row('x','十年債券息口二厘幾。')]).length,0);
  assert.deepEqual(sourceQualityFacts([row('x','十年債券息口一厘半。')]).map(f=>f.value),[1.5]);
  const payload={translations:[{id:'a',en:'The ten-year yield went from 4 percent to 4.732 percent.'},{id:'b',en:'It returned to 3.982%, below the 3.8% yield level.'}]};
  validateQualityDraft(payload,rows,rows);
  const bad=structuredClone(payload);bad.translations[0].en='The ten-year yield rose from 0.4% to 0.4732%.';
  assert.throws(()=>validateQualityDraft(bad,rows,rows),/requires 4%/);
  validateQualityDraft({translations:[{id:'x',en:'The ten-year yield is four point seven three two percent.'}]},[row('x','十年債券息口四厘七三二。')],[row('x','十年債券息口四厘七三二。')]);
});

test('nonempty IDs cannot conceal loss of a source election event or its approaching condition',()=>{
  const rows=[row('a','二零二八年midterm', '',0),row('b','election臨近時，息口會見頂。','',1)];
  const valid={translations:[{id:'a',en:'As the 2028 midterm election'},{id:'b',en:'approaches, interest rates will peak.'}]};
  validateQualityDraft(valid,rows,rows);
  assert.throws(()=>validateQualityDraft({translations:[{id:'a',en:'In 2028,'},{id:'b',en:'interest rates will peak.'}]},rows,rows),/event/);
  assert.throws(()=>validateQualityDraft({translations:[{id:'a',en:'The 2028 midterm election:'},{id:'b',en:'interest rates will peak.'}]},rows,rows),/temporal condition/);
});

test('spoken decimal quantities remain whole and percent continuations cross cues without false batch rejection',()=>{
  const rows=[row('a','指数升咗二十二点四一个点。'),row('b','另一指数升三十三點六個percent。','',1)];
  validateQualityDraft({translations:[{id:'a',en:'The index rose twenty-two point four one points.'},{id:'b',en:'The other rose 33.6%.'}]},rows,rows);
  assert.throws(()=>validateQualityDraft({translations:[{id:'a',en:'It rose twenty-two point four, or one point one percent.'},{id:'b',en:'The other rose 33.6%.'}]},rows,rows),/22.41/);
  const cross=[row('a','升零點零七嘅'),row('b','percent。','',1)];
  validateQualityDraft({translations:[{id:'a',en:'It rose'},{id:'b',en:'0.07 percent.'}]},cross,cross);
  validateQualityDraft({translations:[{id:'a',en:'It rose'}]},[cross[0]],cross);
  assert.throws(()=>validateQualityDraft({translations:[{id:'a',en:'It rose'},{id:'b',en:'0.7 percent.'}]},cross,cross),/0.07%/);
  assert.ok(qualitySourceIssues([{...rows[0],en:'It rose 22.4 or 1.1 percent.'}]).some(i=>i.code==='source-quantity-split-or-loss'));
  assert.deepEqual(sourceQualityFacts([row('a','跌八百六十三点。')]).map(f=>f.value),[863]);
  assert.equal(sourceQualityFacts([row('a','跌九廿三点。')]).length,0,'An unresolved numeral must not be truncated to the final three');
});

test('rebound to neckline does not gain a crossing and falling rates do not become a falling sector',()=>{
  const neckline=[row('a','如果反弹翻上翻去呢条颈线。','If it rebounds back up above that neckline,')];
  assert.equal(repairSourceGroundedEnglish(neckline)[0].en,'If it rebounds back up to that neckline,');
  const crossing=[row('a','如果反弹升穿呢条颈线。','If it rebounds back up above that neckline,')];
  assert.equal(repairSourceGroundedEnglish(crossing)[0].en,crossing[0].en);
  const rows=[row('a','表現最差嘅之前嘅地产版块亦都因为息','The previously worst-performing real estate sector has also been falling because interest rates are moving down,'),row('b','口向下跌啦，咁佢哋係開始係表現好嘅。','so they are starting to perform well.',1)];
  const fixed=repairSourceGroundedEnglish(rows);assert.equal(fixed[0].en,'The previously worst-performing real estate sector,');
  assert.equal(fixed[1].en,'is starting to perform well because interest rates are moving down.');
  assert.ok(fixed.every(r=>r.sourceGroundedEnglishRepairs.length===1));
  assert.throws(()=>validateQualityDraft({translations:rows},rows,rows),/Causal source/);
  validateQualityDraft({translations:fixed},rows,rows);
  const comeDown=structuredClone(rows);comeDown[0].en='The real estate sector, which was weak before, has also come down because of';comeDown[1].en='interest rates falling, so it is performing better.';
  assert.throws(()=>validateQualityDraft({translations:comeDown},rows,rows),/Causal source/);
  assert.ok(qualitySourceIssues(comeDown).some(i=>i.code==='rates-sector-cause-reversed'));
  const repeated=structuredClone(rows);repeated[0].en='The real estate sector has been improving because of';repeated[1].en='falling rates, so it is starting to perform well.';
  assert.throws(()=>validateQualityDraft({translations:repeated},rows,rows),/recovery is one claim/);
  assert.ok(qualitySourceIssues(repeated).some(i=>i.code==='sector-recovery-duplicated'));
  const actuallyFalling=[{...rows[0],yue:'地产版块正在因为息口上升而跌。'},rows[1]];
  assert.deepEqual(repairSourceGroundedEnglish(actuallyFalling).map(r=>r.en),actuallyFalling.map(r=>r.en));
});

test('linked repairs relocate a source-supported year atomically without deleting the election or changing any number',()=>{
  const rows=[row('a','二零二八年，我同大家講','I told everyone that'),row('b','midterm election臨近時','in 2028,',1),
    row('c','息口會見頂。','as the midterm election approaches,',2),row('d','然後息口開始下跌。','interest rates will peak.',3),
    row('e','而且跌得快。','Then interest rates started falling.',4)];
  const patches=[patch('a','I told everyone that','I told everyone that in 2028,','二零二八年'),
    patch('b','in 2028,','as the midterm election approaches,','midterm election臨近時'),
    patch('c','as the midterm election approaches,','interest rates will peak.','息口會見頂'),
    patch('d','interest rates will peak.','Then interest rates started falling.','然後息口開始下跌'),
    patch('e','Then interest rates started falling.','And they fell quickly.','而且跌得快')];
  const review=quarantineEnglishReview({checkedIds:rows.map(r=>r.id),patches,issues:[]},rows);
  const out=applyEnglishReview(rows,review);
  assert.deepEqual(out.map(r=>r.en),['I told everyone that in 2028,','as the midterm election approaches,','interest rates will peak.','Then interest rates started falling.','And they fell quickly.']);
  assert.equal(out.map(r=>r.en).join(' ').match(/2028/gu).length,1);
  assert.deepEqual(out.map(r=>[r.id,r.start,r.end,r.yue]),rows.map(r=>[r.id,r.start,r.end,r.yue]));
  // If the proposed numerical value changes, NONE of its dependent clauses move.
  const unsupported=structuredClone(review);unsupported.patches[0].to='I told everyone that in 2030,';
  const held=applyEnglishReview(rows,unsupported);
  assert.deepEqual(held.map(r=>r.en),rows.map(r=>r.en));
  assert.ok(held.every(r=>r.englishQuestions.length===1));
});

test('an invalid linked source quote holds its dependent move but preserves unrelated valid repairs',()=>{
  const rows=[row('a','二零二八年midterm election臨近。','in 2028,'),row('b','息口見頂。','as the midterm election approaches,',1),row('v','成交量跌20%。','The turnover rate fell 20%.',2)];
  const payload={checkedIds:rows.map(r=>r.id),issues:[],patches:[
    patch('a','in 2028,','as the midterm election approaches,','不存在的引文'),
    patch('b','as the midterm election approaches,','interest rates peak.','息口見頂'),
    patch('v','turnover rate','trading volume','成交量')]};
  const out=applyEnglishReview(rows,quarantineEnglishReview(payload,rows));
  assert.equal(out[0].en,rows[0].en);assert.equal(out[1].en,rows[1].en);assert.equal(out[2].en,'The trading volume fell 20%.');
});

test('numeric protection includes unit changes while independent source-supported word repairs remain usable',()=>{
  const rows=[row('a','成交量跌20%。','The turnover rate fell 20%.')];
  const review={checkedIds:['a'],issues:[],patches:[patch('a','turnover rate','trading volume','成交量'),patch('a','20%','20 percentage points','20%')]};
  const out=applyEnglishReview(rows,review);
  assert.equal(out[0].en,'The trading volume fell 20%.');assert.equal(out[0].englishQuestions.length,1);
});

test('position inside is repaired without suppressing a genuine source inflow',()=>{
  const rows=[row('a','資金仍然喺入邊。','Capital is still coming in.'),row('b','輪轉，並非離開市場。',"It's rotating, not leaving.",1)];
  const before=structuredClone(rows),out=repairSourceGroundedEnglish(rows);
  assert.equal(out[0].en,'Capital is still in the market.');assert.equal(out[0].sourceGroundedEnglishRepairs.length,1);assert.deepEqual(rows,before);
  const inflow=[row('a','資金流入市場，然後喺入邊輪轉。','Capital is still coming in.')];
  assert.equal(repairSourceGroundedEnglish(inflow)[0].en,inflow[0].en);
});

test('gap correction preserves fill, refuses an unspoken direction and does not edit an explicit gap-up',()=>{
  const rows=[row('a','呢個gap都唔能夠fill到。',"It hasn't managed to reach back to that gap from the overnight jump.")];
  assert.equal(repairSourceGroundedEnglish(rows)[0].en,"It hasn't managed to fill that gap.");
  const explicit=[row('a','向上跳空嘅gap都唔能夠fill到。',"It hasn't filled the gap from the gap-up.")];
  assert.equal(repairSourceGroundedEnglish(explicit)[0].en,explicit[0].en);
});

test('sector spelling requires approved source authority; unresolved source terms and MA periods remain questions',()=>{
  assert.equal(repairSourceGroundedEnglish([row('a','Consumer Staples股票。','Consumer stable stocks rose.')])[0].en,'consumer staples stocks rose.');
  const unresolved=[row('a','consumer stable股票。','Consumer stable stocks rose.'),row('b','用28天平均線。','Use the 28-day moving average.',1)];
  assert.equal(repairSourceGroundedEnglish(unresolved)[0].en,unresolved[0].en);
  const issues=qualitySourceIssues(unresolved);assert.ok(issues.some(i=>i.code==='unresolved-sector-spelling'));assert.ok(issues.some(i=>i.code==='moving-average-source-question'));
});

test('week qualifiers are not false unsupported durations and genuinely invented weeks still warn',()=>{
  assert.ok(!criticalTranslationIssues([row('a','一個星期嘅表現。',"For one week's performance.")]).some(i=>i.code==='unsupported-duration'));
  assert.ok(!criticalTranslationIssues([row('a','一個星期嘅表現。','For one week performance.')]).some(i=>i.code==='unsupported-duration'));
  assert.ok(criticalTranslationIssues([row('a','呢個含糊嘅時間。','Over two weeks it fell.')]).some(i=>i.code==='unsupported-duration'));
});

test('source-grounded syntax repair reads adjacent clauses without changing figures or deleting another subject',()=>{
  const rows=[row('a','我預料咗資金。','I expected money to'),row('b','會rotate入去。','would rotate into them.',1),
    row('c','呢條支持trend line。','That is, the one the support trend line drawn from 2028.',2)];
  const fixed=repairSourceGroundedEnglish(rows);
  assert.equal(fixed[1].en,'rotate into them.');assert.equal(fixed[2].en,'That is, the support trend line drawn from 2028.');
  assert.equal(fixed[2].yue,rows[2].yue);assert.equal(fixed[2].start,rows[2].start);
  const actual=[row('a','我預料咗資金。','I expected money'),row('b','會rotate入去。','would rotate into them.',1)];
  assert.equal(repairSourceGroundedEnglish(actual)[1].en,actual[1].en);
});

test('learned gap sound and same-object XLP evidence are narrow rather than blanket feel/stable replacements',async()=>{
  const lexicon=JSON.parse(await fs.readFile(new URL('../financial-error-lexicon.json',import.meta.url),'utf8'));
  const rows=[row('a','跳空嘅gap位都唔能夠feel到。'),row('b','I feel the gap is wide.','',1),row('c','consumer stable股票。','',2)];
  const initial=applyConfirmedTerminology(rows,lexicon);
  assert.match(initial.rows[0].yue,/fill到/);assert.equal(initial.rows[1].yue,rows[1].yue);assert.equal(initial.rows[2].yue,rows[2].yue);
  const confirmed=applyConfirmedTerminology(rows,lexicon,{sourceVideoSha256:'synthetic-video',evidence:[{id:'same-frame',sourceVideoSha256:'synthetic-video',trust:'user-confirmed',ruleIds:['consumer-staples'],rowIds:['c'],time:8,observedText:'Price Performance XLP:SPY',frameIds:['f000080']}]});
  assert.equal(confirmed.rows[2].yue,'Consumer Staples股票。');
  const wrong=applyConfirmedTerminology(rows,lexicon,{sourceVideoSha256:'other-video',evidence:[{id:'wrong-video',sourceVideoSha256:'synthetic-video',trust:'user-confirmed',ruleIds:['consumer-staples'],rowIds:['c'],time:8,observedText:'XLP',frameIds:['f000080']}]});
  assert.equal(wrong.rows[2].yue,rows[2].yue);
});

test('a cross-cue financial-index SMP alias is repaired, while an unrelated company name is retained',()=>{
  const rows=[row('a','financial仍然係表現好過S M','Financials can outperform SMP.'),row('b','P嘅。而地產開始改善。','Real estate is improving.',1)];
  const out=repairSourceGroundedEnglish(rows);assert.equal(out[0].en,'Financials can outperform S&P.');
  assert.equal(out[0].sourceGroundedEnglishRepairs[0].rule,'financial-index-smp-alias');
  assert.ok(qualitySourceIssues(rows).some(i=>i.code==='unresolved-financial-index-alias'));
  const company=[row('a','SMP公司有新產品。','SMP has a new product.')];assert.equal(repairSourceGroundedEnglish(company)[0].en,company[0].en);
});

test('new serial jobs freeze guards, preserve every source cue and never overlap paid stages',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cantones-quality-serial-'));
  const rows=Array.from({length:9},(_,i)=>row('s'+i,'今日市場上升。','',i));
  const bytes=Buffer.from('synthetic media - no network upload');
  const project={profile:CANTONES_PROFILE,version:2,kind:'source-review',filename:'serial.mp4',duration:40,rows,
    sourceDecision:{mode:'automatic',sourceHash:sourceHash(rows),humanReviewedIds:[],wholeFilmHumanReviewed:false}};
  const config={translation:{model:'MiniMax-M3',baseUrl:'https://mock.invalid/v1',apiKey:'synthetic-key'}};
  let active=0,peak=0,calls=0;const phases=[];
  try {
    await fs.writeFile(path.join(dir,'source.mp4'),bytes);
    await fs.writeFile(path.join(dir,'job.json'),JSON.stringify({id:'synthetic',profile:CANTONES_PROFILE,sourceFile:'source.mp4',sourceHash:digest(bytes)}));
    await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(project));
    const fetchImpl=async(_url,options)=>{
      const body=JSON.parse(options.body),tool=body.tools[0].name,input=JSON.parse(body.messages[0].content[0].text);
      active++;calls++;peak=Math.max(peak,active);phases.push(tool);
      assert.equal(input.targetRows.length,3);assert.equal((input.completeSource??input.context).length,9);
      if(tool==='submit_english')assert.ok(Array.isArray(input.sourceQualityFacts));
      await new Promise(r=>setTimeout(r,2));active--;
      const payload=tool==='submit_english'?{translations:input.targetRows.map(r=>({id:r.id,en:'The market rose today.'})),protectedFacts:[],notes:[]}
        :tool==='submit_english_review'?{checkedIds:input.targetRows.map(r=>r.id),patches:[],issues:[]}
        :{checkedIds:input.targetRows.map(r=>r.id),issues:[]};
      return Response.json({content:[{type:'tool_use',name:tool,input:payload}]});
    };
    const output=await runCantones(dir,config,async()=>{},{fetchImpl});
    assert.equal(peak,1);assert.equal(calls,9);assert.deepEqual(phases,Array(3).fill(['submit_english','submit_english_review','submit_track_audit']).flat());
    assert.deepEqual(output.rows.map(r=>[r.id,r.start,r.end,r.yue]),rows.map(r=>[r.id,r.start,r.end,r.yue]));
    const frozen=JSON.parse(await fs.readFile(path.join(dir,'cantones-rules-snapshot.json'),'utf8'));assert.equal(frozen.qualityPolicy,ENGLISH_QUALITY_POLICY);
    await fs.unlink(path.join(dir,'review.json'));await runCantones(dir,config,async()=>{},{fetchImpl});assert.equal(calls,9);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'cantones-rules-snapshot.json'),'utf8')),frozen);
  }finally {
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()))throw Error('Refusing cleanup outside task temp');
    await fs.rm(dir,{recursive:true,force:true});
  }
});
