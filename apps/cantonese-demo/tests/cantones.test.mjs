import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryTimes, validateInventory } from '../visual-inventory.mjs';
import { CANTONES_PROFILE, sourceQuestions, confirmCantonesSource, projectRevision, assertCantonesSource, validateEnglishReview, applyEnglishReview, cantonesDelivery, saveCantonesEnglish } from '../cantones-workflow.mjs';
import { sourceHash } from '../workflow-checks.mjs';
import { COPY, message } from '../public/cantones-i18n.mjs';

const fixture = () => ({ profile: CANTONES_PROFILE, version: 2, filename: '原影片.mp4', duration: 5, kind: 'source-review', residualTerms: [], rows: [
  { id: 's0001', start: .1, end: 4.5, yue: '如果跌破均線，就可能回落。', en: '', zh: '', sourceReviewed: false, reviewed: false, stale: false, sourceIssues: [{ text: '均線', reason: 'Confirm the chart term', frameIds: ['f000000'] }] },
] });

test('frame sampling is bounded, preserves a periodic inventory, and validates OCR identities', () => {
  const times = inventoryTimes(100, [6, 6.5, 40]);
  assert.ok(times.includes(6.3)); assert.ok(times.includes(15)); assert.ok(times.every((t, i) => !i || t - times[i - 1] >= 1.99));
  assert.ok(inventoryTimes(1800, Array.from({ length: 1000 }, (_, i) => i * 1.8)).length <= 240);
  const frames = [{ id: 'f1', time: 0 }, { id: 'f2', time: 10 }];
  const valid = { frames: frames.map(f => ({ frameId: f.id, title: 'S&P 500', terms: ['2018'], unclear: [] })) };
  assert.equal(validateInventory(valid, frames)[1].time, 10);
  valid.frames[1].frameId = 'f1'; assert.throws(() => validateInventory(valid, frames), /duplicate/);
});

test('targeted confirmation checks current revision and every question without claiming full human review', () => {
  const p = fixture(); assert.equal(sourceQuestions(p).length, 1); assert.throws(() => assertCantonesSource(p));
  assert.throws(() => confirmCantonesSource(p, { revision: 'old', rows: [] }), /changed/);
  const confirmed = confirmCantonesSource(p, { revision: projectRevision(p), rows: [{ id: 's0001', yue: p.rows[0].yue, note: 'Checked the frame' }] });
  assertCantonesSource(confirmed);
  assert.equal(confirmed.sourceDecision.wholeFilmHumanReviewed, false);
  assert.equal(confirmed.wholeFilmAccepted, false);
  assert.deepEqual(confirmed.rows.map(r => [r.start, r.end]), p.rows.map(r => [r.start, r.end]));
  confirmed.rows[0].yue += '新增'; assert.throws(() => assertCantonesSource(confirmed));
});

test('known error retention requires evidence notes and missing source words cannot be confirmed', () => {
  const p = fixture(); p.rows[0].yue = 'SMP五八指數。'; p.residualTerms = [{ rowId: 's0001', from: 'SMP五八', to: 'S&P 500' }];
  assert.throws(() => confirmCantonesSource(p, { revision: projectRevision(p), rows: [{ id: 's0001', yue: p.rows[0].yue }] }), /Explain/);
  assert.throws(() => confirmCantonesSource(p, { revision: projectRevision(p), rows: [{ id: 's0001', yue: '[unclear]' }] }), /missing/);
});

test('lack of a chart is informational, while fixed expressions requiring listening stay in the source gate', () => {
  const p = fixture(); p.rows[0].sourceIssues[0].action = 'informational';
  assert.equal(sourceQuestions(p).length, 0);
  p.rows[0].triggers = [{ action: 'required-audio-check', text: 'bar' }];
  assert.equal(sourceQuestions(p).length, 1);
  assert.equal(p.rows[0].sourceIssues.length, 1);
});

test('English patches are local, source-grounded and cannot silently alter numerical facts', () => {
  const rows = [{ id: 's1', yue: '交投量跌咗20%。', en: 'The turnover rate fell 20%.' }];
  const review = { checkedIds: ['s1'], patches: [{ id: 's1', from: 'turnover rate', to: 'trading volume', sourceQuote: '交投量', reason: 'Volume is an amount' }], issues: [] };
  assert.match(applyEnglishReview(rows, review)[0].en, /trading volume/);
  review.patches[0].sourceQuote = '不存在'; assert.throws(() => validateEnglishReview(review, rows), /Ungrounded/);
  review.patches = [{ id: 's1', from: '20%', to: '30%', sourceQuote: '20%', reason: 'Guess' }];
  const output = applyEnglishReview(rows, review)[0]; assert.equal(output.en, rows[0].en); assert.equal(output.englishQuestions.length, 1);
  review.checkedIds = []; assert.throws(() => validateEnglishReview(review, rows), /every/);
});

test('the only English download gate rejects stale source and returns the original filename and draft status', () => {
  const p = fixture(); p.sourceDecision = { mode: 'automatic', sourceHash: sourceHash(p.rows), humanReviewedIds: [], wholeFilmHumanReviewed: false };
  p.kind = 'english-draft'; p.rows[0].sourceIssues = []; p.rows[0].en = 'If it breaks below the moving average, it could fall back.'; p.translationSourceHash = sourceHash(p.rows);
  const delivery = cantonesDelivery(p); assert.equal(delivery.filename, '原影片.srt'); assert.match(delivery.content, /00:00:00,100 --> 00:00:04,500/);
  assert.equal(delivery.manifest.humanFinalApproval, false);
  assert.equal(delivery.manifest.youtubePlaybackVerified, false);
  const edited = saveCantonesEnglish(p, { revision: projectRevision(p), rows: [{ id: 's0001', en: 'A user edit.' }] });
  assert.equal(edited.rows[0].englishAuditStale, true); assert.equal(edited.rows[0].reviewed, false);
  assert.throws(() => saveCantonesEnglish(edited, { revision: projectRevision(p), rows: [{ id: 's0001', en: 'Overwrite' }] }), /changed/);
  p.translationSourceHash = 'old'; assert.throws(() => cantonesDelivery(p), /older/);
});

test('Traditional Chinese and English have complete, matching UI dictionaries', () => {
  assert.deepEqual(Object.keys(COPY['zh-Hant']).sort(), Object.keys(COPY.en).sort());
  assert.match(message('zh-Hant', 'download'), /下載/);
  assert.match(message('en', 'download'), /Download/);
});
