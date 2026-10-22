import test from 'node:test';
import assert from 'node:assert/strict';
import {groupEnglishComparison,mergeCrossingEnglishTopics,editDistance} from '../english-comparison.mjs';
test('English layout retains every reference and generated row once, with links for crossing cues',()=>{
 const refs=[{start:'0:01',text:'One'},{start:'0:03',text:'Two'}],rows=[{id:'a',start:1,end:2,en:'First'},{id:'b',start:2,end:4,en:'Crossing cue'},{id:'c',start:4,end:5,en:'Last'}];
 const topics=[{title:'one',start:1,end:3,rowIds:['a','b'],reviewedText:'甲'},{title:'two',start:3,end:5,rowIds:['b','c'],reviewedText:'乙'}];
 const definitions=[{from:1,to:1},{from:2,to:2}];
 const result=groupEnglishComparison(refs,definitions,rows,topics);assert.equal(result.audit.contextLinks,1);assert.deepEqual(result.groups.flatMap(group=>group.rows.map(row=>row.id)),['a','b','c']);
 assert.throws(()=>groupEnglishComparison(refs,[{from:1,to:1},{from:1,to:2}],rows,topics),/gap or overlap/);
 assert.equal(editDistance(['a','b'],['b','c']),2);
 const merged=mergeCrossingEnglishTopics(topics,definitions);assert.equal(merged.topics.length,1);
 const whole=groupEnglishComparison(refs,merged.definitions,rows,merged.topics);assert.equal(whole.audit.contextLinks,0);assert.equal(whole.groups[0].rows.length,3);
});
