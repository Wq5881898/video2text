import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyConfirmedTerminology, planScreenshotChecks } from '../terminology-review.mjs';
import { generalLexicon, sourceHash } from '../workflow-checks.mjs';
import { criticalTranslationIssues } from '../translation-critical-checks.mjs';
import { runCantones, CANTONES_PROFILE } from '../cantones-workflow.mjs';
import { digest } from '../model-client.mjs';

const lexicon=JSON.parse(fs.readFileSync(new URL('../financial-error-lexicon.json',import.meta.url),'utf8'));
const rules=JSON.parse(fs.readFileSync(new URL('../translation-context-rules.json',import.meta.url),'utf8'));
const row=(id,yue,en='')=>({id,start:10,end:14,yue,en,zh:'',sourceUnits:[[0,Number(id.replace(/\D/gu,''))||0]]});

test('learned source spellings repair the actual contexts while preserving IDs, times, units and source history',()=>{
  const original=[row('s1','紐約交易所嘅bread相當之低。'),row('s2','所以我的睇翻所有嘅板塊。'),
    row('s3','仍然創咗一個:new高，指數亦都創造新高。'),row('s4','油價會唔喺呢啲地方就開始逆轉呢？')];
  const before=structuredClone(original),fixed=applyConfirmedTerminology(original,lexicon);
  assert.deepEqual(fixed.rows.map(r=>r.yue),['紐約交易所嘅breadth相當之低。','所以我哋睇翻所有嘅板塊。',
    '仍然創咗一個新高，指數亦都創造新高。','油價會唔會喺呢啲地方就開始逆轉呢？']);
  assert.deepEqual(original,before); assert.equal(fixed.applied.length,4);
  assert.notEqual(sourceHash(original),sourceHash(fixed.rows));
  assert.deepEqual(fixed.rows.map(({id,start,end,sourceUnits})=>({id,start,end,sourceUnits})),original.map(({id,start,end,sourceUnits})=>({id,start,end,sourceUnits})));
  assert.deepEqual(applyConfirmedTerminology(fixed.rows,lexicon).rows.map(r=>r.yue),fixed.rows.map(r=>r.yue));
});

test('learning is contextual: food, possessives, future markets and quantities are never blanket replacements',()=>{
  const rows=[row('s1','今日買bread食。'),row('s2','我的圖表更新咗。'),row('s3','佢會唔喺屋企食飯。'),
    row('s4','我哋睇下嚟緊嘅市場。'),row('s5','距離七萬三千五至七萬五公里。'),row('s6','The new high school opened.')];
  const fixed=applyConfirmedTerminology(rows,lexicon);
  assert.deepEqual(fixed.rows.map(r=>r.yue),rows.map(r=>r.yue)); assert.equal(fixed.applied.length,0);
});

test('sector-leading and chart-scale candidates stay unresolved rather than becoming learned answers',()=>{
  const rows=[row('s1','healthcare同financial原本呢啲係呢緊嘅市場。'),row('s2','支持區price係七萬三千五至七萬五。')];
  const fixed=applyConfirmedTerminology(rows,generalLexicon(lexicon));
  assert.deepEqual(fixed.rows.map(r=>r.yue),rows.map(r=>r.yue)); assert.equal(fixed.applied.length,0);
  for(const id of ['sector-leading-sound-review','index-quantity-scale-review']){
    assert.ok(fixed.pending.some(p=>p.ruleId===id&&p.contextMatches));
    assert.ok(planScreenshotChecks(rows,lexicon).some(p=>p.ruleId===id&&p.action==='listen-or-review'));
  }
  assert.equal(generalLexicon(lexicon).documentCorrections.length,0);
  assert.ok(generalLexicon(lexicon).reviewGuidance.some(g=>g.id==='chart-quantity-scale'));
});

test('deterministic English checks catch learned financial relations even when a model reports no issues',()=>{
  const rows=[row('s1','Bollinger Band嘅medium','the Bollinger Band medium'),row('s2','line。','line.'),
    row('s3','佢喺Bollinger Band下方。','It is below the Bollinger Band.'),
    row('s4','佢落返嚟再探一次都係正常。','It came back down and tested the level.'),
    row('s5','有機會即係去到D point。','It could go straight to point D.'),
    row('s6','喺技術上。','. Technically, this is a double top.')];
  const before=JSON.stringify(rows),issues=criticalTranslationIssues(rows);
  for(const code of ['bollinger-middle-band','bollinger-lower-position','retest-actuality','unspoken-direct-path','orphan-leading-period'])assert.ok(issues.some(i=>i.code===code),code);
  assert.equal(JSON.stringify(rows),before);
});

test('correct technical positions, genuine actual retests and explicit direct paths are not rewritten',()=>{
  const rows=[row('s1','Bollinger Band嘅中線。','The middle band.'),
    row('s2','佢喺Bollinger Band下方。','It is near the lower band.'),
    row('s3','佢已經再測試完。','It came back down and tested the level.'),
    row('s4','直接去到D point。','It went directly to point D.'),
    row('s5','medium term嘅市場。','The medium-term market.')];
  const learned=new Set(['bollinger-middle-band','bollinger-lower-position','retest-actuality','unspoken-direct-path','orphan-leading-period']);
  assert.ok(!criticalTranslationIssues(rows).some(i=>learned.has(i.code)));
});

test('lower-band position check reads an indicator name split over neighboring English cues once',()=>{
  const rows=[row('s1','佢嘅Bollinger','the support below its Bollinger'),row('s2','Band下面嘅支持位。','Band.')];
  const findings=criticalTranslationIssues(rows).filter(i=>i.code==='bollinger-lower-position');
  assert.equal(findings.length,1); assert.equal(findings[0].id,'s1');
});

test('an adjacent band warning neither falsely attaches to a trend-line break nor misses a later middle-band mention',()=>{
  const rows=[row('s1','雖然今日跌破trend line。','Although it broke below this trend line today,'),
    row('s2','但係喺Bollinger Band下方。','it is below the Bollinger Band.'),
    row('s3','line。','line.'),row('s4','繼續。','Continue.'),row('s5','繼續。','Continue.'),
    row('s6','medium line會有支持。','The medium line offers support.')];
  const issues=criticalTranslationIssues(rows);
  assert.deepEqual(issues.filter(i=>i.code==='bollinger-lower-position').map(i=>i.id),['s2']);
  assert.ok(issues.some(i=>i.code==='bollinger-middle-band'&&i.id==='s6'));
});

test('unresolved sector source is distinguished from a proposed English correction',()=>{
  const rows=[row('s1','healthcare同financial原本呢啲係呢緊嘅市場。','These were the tight-market ones.')];
  const before=structuredClone(rows),issues=criticalTranslationIssues(rows);
  assert.ok(issues.some(i=>i.code==='sector-leading-source-unclear'&&i.lang==='source'&&i.severity==='source'));
  assert.deepEqual(rows,before);
  assert.ok(!criticalTranslationIssues([row('s2','嚟緊嘅市場會點？','What will the upcoming market look like?')]).some(i=>i.code==='sector-leading-source-unclear'));
});

test('reusable rules are versioned and contain guidance rather than this film reference answers',()=>{
  assert.equal(lexicon.version,'2026-10-28.1'); assert.equal(rules.version,'2026-10-28.general.2');
  assert.equal(new Set(lexicon.rules.map(r=>r.id)).size,lexicon.rules.length);
  assert.equal(new Set(rules.rules.map(r=>r.id)).size,rules.rules.length);
  for(const id of ['bollinger-position','retest-conditionality','source-chart-scale-conflict','atomic-numbers-and-units'])assert.ok(rules.rules.some(r=>r.id===id));
  assert.ok(!JSON.stringify(rules).includes('73,500'));
  for(const rule of lexicon.rules){new RegExp(rule.pattern,'giu');new RegExp(rule.context,'iu');}
});

test('a legacy English snapshot keeps the original audit request shape and reuses all paid-step caches',async()=>{
  const dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'cantones-learning-'));
  const write=(name,value)=>fs.promises.writeFile(path.join(dir,name),JSON.stringify(value));
  const config={translation:{model:'MiniMax-M3',baseUrl:'https://mock.invalid/v1',apiKey:'synthetic-legacy-key'}};
  const rows=[row('s1','今日市場上升。')],video=Buffer.from('synthetic source; never sent');
  const p={profile:CANTONES_PROFILE,version:2,kind:'source-review',filename:'legacy.mp4',duration:20,rows,
    sourceDecision:{mode:'automatic',sourceHash:sourceHash(rows),humanReviewedIds:[],wholeFilmHumanReviewed:false}};
  const legacy={model:config.translation.model,endpoint:config.translation.baseUrl,keyHash:digest(config.translation.apiKey),
    rules:{version:'legacy-frozen',rules:[]},policy:{version:'legacy-policy'}};
  const calls=[];
  try{
    await fs.promises.writeFile(path.join(dir,'source.mp4'),video);
    await write('job.json',{id:'synthetic',profile:CANTONES_PROFILE,filename:p.filename,sourceFile:'source.mp4',sourceHash:digest(video)});
    await write('result.json',p); await write('cantones-rules-snapshot.json',legacy);
    const fetchImpl=async(_url,options)=>{
      const body=JSON.parse(options.body),name=body.tools[0].name,input=JSON.parse(body.messages[0].content[0].text);
      calls.push(name); let result;
      if(name==='submit_english'){
        assert.equal(input.generalTranslationRules.version,'legacy-frozen');
        result={translations:[{id:'s1',en:'The market rose today.'}],protectedFacts:[],notes:[]};
      }else if(name==='submit_english_review')result={checkedIds:['s1'],patches:[],issues:[]};
      else if(name==='submit_track_audit'){
        assert.ok(!Object.hasOwn(input,'generalTranslationRules'));
        assert.ok(!Object.hasOwn(input,'semanticPreservationPolicy'));
        result={checkedIds:['s1'],issues:[]};
      }else assert.fail('Unexpected request: '+name);
      return new Response(JSON.stringify({content:[{type:'tool_use',name,input:result}]}),{status:200});
    };
    await runCantones(dir,config,async()=>{},{fetchImpl});
    assert.equal(calls.length,3);
    await fs.promises.unlink(path.join(dir,'review.json'));
    await runCantones(dir,config,async()=>{},{fetchImpl});
    assert.equal(calls.length,3,'Successful cached steps must not be resent');
    assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(dir,'cantones-rules-snapshot.json'),'utf8')),legacy);
  }finally{
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir()))throw Error('Refusing cleanup outside task temp');
    await fs.promises.rm(dir,{recursive:true,force:true});
  }
});
