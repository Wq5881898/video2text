import test from 'node:test';
import assert from 'node:assert/strict';
import {englishTranslationInput,validateEnglishTranslation} from '../english-translation.mjs';
test('English requests include source and bounded context but cannot carry old translations or references',()=>{
 const rows=[{id:'a',yue:'三',en:'old answer',baseline:'human answer'},{id:'b',yue:'分之二',reference:'reference'}];
 const input=englishTranslationInput(rows,1,1,{b:'fraction continues previous cue'});
 assert.deepEqual(input.targetRows,[{id:'b',text:'分之二'}]);assert.deepEqual(input.contextBefore,[{id:'a',text:'三'}]);
 assert.ok(!JSON.stringify(input).includes('old answer')&&!JSON.stringify(input).includes('human answer'));assert.equal(input.referenceIncluded,false);
});
test('English validation preserves source and timing and rejects gaps, duplicates and source edits',()=>{
 const source=[{id:'a',start:1,end:2,yue:'三'},{id:'b',start:2,end:3,yue:'分之二'}];
 const translations=[{id:'b',en:'thirds.',note:''},{id:'a',en:'Two',note:''}];
 const rows=validateEnglishTranslation({translations},source);assert.deepEqual(rows.map(({id,start,end,yue})=>({id,start,end,yue})),source);
 assert.deepEqual(rows.map(row=>row.en),['Two','thirds.']);
 assert.throws(()=>validateEnglishTranslation({translations:translations.slice(1)},source),/count/);
 assert.throws(()=>validateEnglishTranslation({translations:[translations[0],translations[0]]},source),/duplicate/);
 assert.throws(()=>validateEnglishTranslation({translations:[{...translations[0],start:9},translations[1]]},source),/source or timing/);
});
