import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {sourceAudioRisks} from '../workflow-checks.mjs';
import {applyConfirmedTerminology} from '../terminology-review.mjs';
const lexicon=JSON.parse(fs.readFileSync(new URL('../financial-error-lexicon.json',import.meta.url),'utf8'));
test('unreported suspect financial sounds trigger bounded audio review without automatic correction',()=>{
 const rows=[{id:'a',start:10,end:13,yue:'housing股票空标会反弹'},{id:'b',start:40,end:43,yue:'harami，烟塞吧同doji'},{id:'c',start:60,end:63,yue:'真系有空标芯片型号'},{id:'d',start:70,end:73,yue:'半腰呢个futures market'}];
 const risks=sourceAudioRisks(rows,[],lexicon,80);
 assert.ok(risks.some(r=>r.id==='a'));assert.ok(risks.some(r=>r.id==='b'));assert.ok(risks.some(r=>r.id==='d'));
 assert.ok(risks.every(r=>r.end-r.start<=15&&r.start>=0&&r.end<=80));
 const before=rows.map(r=>r.yue);assert.deepEqual(applyConfirmedTerminology(rows,lexicon).rows.map(r=>r.yue),before);
});
