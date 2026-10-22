import test from 'node:test';
import assert from 'node:assert/strict';
import { relationCases, validateRelationAudit } from '../relation-audit.mjs';
import { needsNumericReview } from '../visual-review.mjs';
import { planTitleIssues } from '../holdout-protocol.mjs';

test('a generated heading cannot introduce MACD into a CCI/RSI paragraph',()=>{
 const rows=[{id:'a',yue:'C C I已经背离，R S I回到三十一'}];
 assert.equal(planTitleIssues([{id:'g',sourceIds:['a'],title:'MACD背离与RSI'}],rows)[0].term,'MACD');
 assert.deepEqual(planTitleIssues([{id:'g',sourceIds:['a'],title:'CCI背离与RSI'}],rows),[]);
});

test('Chinese numerals inside a proper-name patch cannot bypass numerical review',()=>{
 assert.equal(needsNumericReview({from:'S M P五八',to:'S&P五百八',category:'proper_name'}),true);
 assert.equal(needsNumericReview({from:'納斯達克一八',to:'納斯達克一百',category:'proper_name'}),true);
 assert.equal(needsNumericReview({from:'3',to:'30',category:'term'}),true);
 assert.equal(needsNumericReview({from:'dump money',to:'Dumb Money',category:'term'}),false);
});

test('semantic triggers retain split probability/object relations and request complete clause coverage', () => {
  const rows = [{id:'a',yue:'加息機會率由七十個'}, {id:'b',yue:'percent跌落嚟，債券收益率亦跌'}];
  assert.deepEqual(relationCases(rows).map(r=>r.kind), ['quantity-relation','financial-object','clause-coverage']);
  assert.deepEqual(relationCases([{id:'x',yue:'大家好'}]).map(r=>r.kind), ['clause-coverage']);
});

test('relation reviewer cannot omit cases or pass with invented source/target quotations', () => {
  const rows=[{id:'a',yue:'機會率由七十個percent跌落嚟',en:'The probability fell by 70%.'}];
  const cases=relationCases(rows);
  const make=id=>({id,status:'mismatch',sourceQuote:rows[0].yue,targetQuote:rows[0].en,measuredObject:'probability',startLevel:'70%',endLevel:'unknown',changeAmount:'unknown',reason:'from was translated as by'});
  const payload={checkedIds:['a'],checks:cases.map(c=>make(c.id))};
  assert.equal(validateRelationAudit(payload,rows,cases).checks[0].status,'mismatch');
  assert.throws(()=>validateRelationAudit({...payload,checks:payload.checks.slice(1)},rows,cases));
  const bad=structuredClone(payload);bad.checks[0].sourceQuote='機會率跌咗七十個percent';
  assert.equal(validateRelationAudit(bad,rows,cases).checks[0].status,'unverified');
  const changed=structuredClone(payload);changed.checks[0].targetQuote='The probability fell from 70%.';
  assert.equal(validateRelationAudit(changed,rows,cases).checks[0].status,'unverified');
});

test('a reviewer quoting only an easy first cue cannot certify later quantities or clauses',()=>{
 const rows=[{id:'a',yue:'先睇數據',en:'First look at the data.'},{id:'b',yue:'機會率有七十percent跌落嚟',en:'The probability has fallen by 70%.'}];
 const cases=relationCases(rows),make=c=>({id:c.id,status:'match',sourceQuote:rows[0].yue,targetQuote:rows[0].en,measuredObject:'data',startLevel:'unknown',endLevel:'unknown',changeAmount:'unknown',reason:'first cue matches'});
 const checks=validateRelationAudit({checkedIds:rows.map(r=>r.id),checks:cases.map(make)},rows,cases).checks;
 assert.ok(checks.every(c=>c.status==='unverified'));
 const whole=cases.map(c=>({...make(c),sourceQuote:rows.map(r=>r.yue).join(' '),targetQuote:rows.map(r=>r.en).join(' ')}));
 assert.equal(validateRelationAudit({checkedIds:rows.map(r=>r.id),checks:whole},rows,cases).checks[0].status,'uncertain');
});
