import test from 'node:test';
import assert from 'node:assert/strict';
import {semanticParagraphs,validateParagraphs,validateSemanticAudit} from '../english-iteration.mjs';
const target={id:'p01',sourceRows:[{id:'s1',start:1,end:2,yue:'三'},{id:'s2',start:2,end:4,yue:'分之二'}]};
test('English blocks preserve exact source ownership and derive time without editing the source',()=>{
  const [p]=validateParagraphs({paragraphs:[{id:'p01',blocks:[{sourceIds:['s1','s2'],en:'two-thirds'}],notes:[]}]},[target]);
  assert.deepEqual([p.blocks[0].start,p.blocks[0].end],[1,4]);
  for(const ids of [['s1'],['s1','s1'],['s2','s1']])assert.throws(()=>validateParagraphs({paragraphs:[{id:'p01',blocks:[{sourceIds:ids,en:'two-thirds'}],notes:[]}]},[target]));
  assert.equal(target.sourceRows[0].yue,'三');
});
test('Semantic review requires every paragraph and actual quoted evidence',()=>{
  const targets=[{...target,english:'two-thirds'}];
  assert.throws(()=>validateSemanticAudit({checkedParagraphs:[],issues:[]},targets));
  assert.throws(()=>validateSemanticAudit({checkedParagraphs:['p01'],issues:[{paragraphId:'p01',severity:'major',quote:'invented quote'}]},targets));
  assert.deepEqual(validateSemanticAudit({checkedParagraphs:['p01'],issues:[]},targets).issues,[]);
});
test('Semantic boundaries cover the full source once',()=>{
  const rows=Array.from({length:212},(_,i)=>({id:`s${i+1}`,start:i,end:i+1,yue:String(i)}));
  assert.deepEqual(semanticParagraphs(rows).flatMap(p=>p.sourceRows.map(r=>r.id)),rows.map(r=>r.id));
});
