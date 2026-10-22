import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedTranslationInput,semanticContracts,semanticRiskIssues,validateRepairProposal,applyApprovedRepairs} from '../semantic-repair.mjs';
const rows=[{id:'a',start:0,end:2,yue:'呢个代表市场唔系好似散户觉得咁',en:"This doesn't mean the market is",zh:''},{id:'b',start:2,end:4,yue:'bearish，而交投量高',en:'bearish, and its turnover rate is high.',zh:''},{id:'c',start:4,end:6,yue:'六个交易天',en:'On the sixth trading day.',zh:''}];
test('approved translation input excludes rejected ASR, OCR and previous translations',()=>{
 const source=rows.map(r=>({...r,audioRechecks:[{text:'交投率'}],en:'old English',changes:[{from:'旧错词'}]}));
 const input=approvedTranslationInput(source,source,{semanticPreservationPolicy:{version:'test'}});
 assert.deepEqual(input.targetRows,source.map(({id,start,end,yue})=>({id,start,end,yue})));
 assert.ok(!JSON.stringify(input).includes('old English'));assert.ok(!JSON.stringify(input).includes('交投率'));
 assert.throws(()=>approvedTranslationInput(source,[{...source[0],yue:'changed'}]));
});
test('known negation, volume and cardinal errors are caught without flagging faithful controls',()=>{
 const original=JSON.stringify(rows),codes=semanticRiskIssues(rows).map(i=>i.code);
 assert.ok(codes.includes('negation-scope'));assert.ok(codes.includes('volume-not-rate'));assert.ok(codes.includes('cardinal-not-ordinal'));assert.equal(JSON.stringify(rows),original);
 const correct=structuredClone(rows);correct[0].en='This means the market is not as';correct[1].en='bearish as retail traders think, and trading volume is high.';correct[2].en='Six trading days.';
 assert.deepEqual(semanticRiskIssues(correct),[]);
 const controls=[{id:'d',yue:'唔代表市场好似佢想咁差，换手率高，第六个交易天',en:"This doesn't mean the market is as bad as he thinks. Its turnover rate is high on the sixth trading day."}];
 assert.deepEqual(semanticRiskIssues(controls),[]);
});
test('literal silence and an actual ordinal are not changed by fixed expression guards',()=>{
 assert.deepEqual(semanticRiskIssues([{id:'a',yue:'现场变得安静，呢个系第六个交易天',en:'The room went quiet on the sixth trading day.'}]),[]);
 assert.ok(semanticRiskIssues([{id:'a',yue:'接近exhaustion冇乜气静',en:'It has gone quiet.'}]).some(i=>i.code==='momentum-not-silence'));
});
test('a synonym of almost all and a repeated comparison property remain reviewable',()=>{
 const rows=[{id:'a',yue:'同道指差不多回吐去test',en:'It has almost given it all back and is testing.'}];
 assert.ok(semanticRiskIssues(rows).some(i=>i.code==='similarity-not-total-retracement'));
 assert.ok(!semanticRiskIssues([{...rows[0],yue:'同道指差不多回吐全部涨幅去test'}]).some(i=>i.code==='similarity-not-total-retracement'));
 const repeated=[{id:'a',yue:'代表市场唔系好似散户咁',en:'This indicates it is not as bearish as people think it is'},{id:'b',yue:'bearish嘅',en:'bearish.'}];
 assert.ok(semanticRiskIssues(repeated).some(i=>i.code==='repeated-comparison-property'));
});
test('repairs require exact local evidence and explicit approval, preserving source and numbers',()=>{
 const contracts=semanticContracts(rows),proposal={checkedIds:['a','b','c'],patches:[{id:'b',from:'turnover rate',to:'trading volume',reason:'量不是率',contractIds:[contracts.find(c=>c.type==='volume-object').id],sourceIds:['b'],sourceQuote:rows[1].yue}],unresolved:[]};
 validateRepairProposal(proposal,rows,contracts);
 assert.equal(applyApprovedRepairs(rows,proposal,[],contracts).rows[1].en,rows[1].en);
 const result=applyApprovedRepairs(rows,proposal,[{index:0,action:'accept',reason:'源量已确认'}],contracts);
 assert.equal(result.rows[1].en,'bearish, and its trading volume is high.');assert.deepEqual(result.rows.map(r=>r.yue),rows.map(r=>r.yue));
 assert.equal(result.rows[1].reviewed,false);assert.deepEqual(result.rows[1].semanticIssues,[]);assert.match(result.rows[1].auditStatus,/invalidated/u);
 const bad=structuredClone(proposal);bad.patches[0].sourceQuote='invented source';assert.throws(()=>validateRepairProposal(bad,rows,contracts));
 bad.patches[0].sourceQuote=rows[1].yue;bad.patches[0].to='trading volume of 20';assert.throws(()=>applyApprovedRepairs(rows,bad,[{index:0,action:'accept',reason:'test'}],contracts));
});
