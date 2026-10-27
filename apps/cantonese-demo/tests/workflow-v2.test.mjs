import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chunkPlan, asrUploadEncoding, validateTracks, validateAudit, prepareSource, translateApproved } from '../workflow-v2.mjs';
import { WORKFLOW_VERSION, generalLexicon, reviewTriggers, mergeReview, assertSourceApproved, sourceHash } from '../workflow-checks.mjs';
import { wrapCaption, publicationIssues, renderDelivery, referenceOwnership } from '../public/subtitle-layout.mjs';
import { recordedRequest, modelTool, digest } from '../model-client.mjs';
import { subtitleBundle } from '../subtitle-bundle.mjs';
import { ensureWrittenChinese, hasCantoneseRegister } from '../written-chinese.mjs';
import { readJson, writeJson } from '../pipeline.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = () => ({ version: 2, filename: '新视频.mp4', duration: 8, rows: [
  { id: 's0001', start: 0, end: 3, yue: '如果跌破均線，就會有機會。', en: 'If it breaks the MA, there will be a chance.', zh: '如果跌破均线，就会出现机会。', sourceReviewed: true, reviewed: true, stale: false },
  { id: 's0002', start: 3.5, end: 7, yue: '唔係確定。', en: 'It is not certain.', zh: '这不是确定的。', sourceReviewed: true, reviewed: true, stale: false },
] });

test('arbitrary-length audio uses contiguous bounded chunks near its own pauses', () => {
  for (const duration of [1, 449, 500, 883.227, 1799.99]) {
    const chunks = chunkPlan(duration, [430, 870, 1300]);
    assert.equal(chunks[0].offset, 0);
    assert.ok(Math.abs(chunks.at(-1).offset + chunks.at(-1).duration - duration) < .001);
    chunks.forEach((c, i) => { assert.ok(c.duration > 0 && c.duration <= 450); if (i) assert.equal(c.offset, chunks[i-1].offset + chunks[i-1].duration); });
  }
  assert.equal(chunkPlan(883.227, [430])[0].duration, 430);
});

test('small uploads cover the whole film once, freeze encoding and preserve legacy caches', () => {
  const duration = 945.818438;
  const chunks = chunkPlan(duration, [448.5, 111, 109, 899, NaN], { maxSeconds: 120, pauseWindow: 30 });
  assert.equal(chunks[0].duration, 111);
  assert.equal(chunks[0].offset, 0);
  assert.equal(chunks.at(-1).offset + chunks.at(-1).duration, duration);
  for (const [i, c] of chunks.entries()) {
    assert.ok(c.duration > 0 && c.duration <= 120);
    if (i) assert.equal(c.offset, chunks[i - 1].offset + chunks[i - 1].duration);
  }
  assert.equal(asrUploadEncoding({}).format, 'flac');
  assert.equal(asrUploadEncoding({ asrUpload: 'mp3-64k-mono16k-v1' }).mimeType, 'audio/mpeg');
  assert.throws(() => asrUploadEncoding({ asrUpload: 'unknown' }));
  for (const maxSeconds of [0, -1, Infinity, 451]) assert.throws(() => chunkPlan(duration, [], { maxSeconds }));
});

test('new-video checks remove sample-specific answers and discover unseen names and amounts', async () => {
  const lexicon = JSON.parse(await fs.readFile(path.join(root, 'financial-error-lexicon.json'), 'utf8'));
  const general = generalLexicon(lexicon);
  assert.equal(general.documentCorrections.length, 0);
  assert.ok(general.rules.every(r => !r.rowIds));
  const triggers = reviewTriggers([{ id: 's1', start: 2, end: 4, yue: 'AcmeCloud 喺2031年報125.75。' }], lexicon);
  for (const word of ['AcmeCloud', '2031', '125.75']) assert.ok(triggers.some(t => t.text === word));
});

test('source edits invalidate both tracks and all final approvals; rechecking cannot clear stale translations', () => {
  const original = fixture(), incoming = structuredClone(original.rows); incoming[0].yue += '請留意。';
  const result = mergeReview(original, original, incoming);
  assert.ok(result.rows.every(r => r.stale && !r.reviewed));
  const forged = structuredClone(result.rows); forged.forEach(r => { r.stale = false; r.reviewed = true; });
  assert.ok(mergeReview(original, result, forged).rows.every(r => r.stale));
  assert.notEqual(sourceHash(result.rows), sourceHash(original.rows));
  result.rows[0].sourceReviewed = false; assert.throws(() => assertSourceApproved(result), /逐段核对/);
});

test('subtitle delivery preserves all text and rejects unclear, fast or oversized final captions', () => {
  const project = fixture();
  const wrapped = wrapCaption('A readable subtitle that should wrap into two short lines without changing any words.', 'en');
  assert.equal(wrapped.replace(/\s/g, ''), 'A readable subtitle that should wrap into two short lines without changing any words.'.replace(/\s/g, ''));
  assert.match(renderDelivery(project, 'en', { final: true }), /00:00:00,000 --> 00:00:03,000/);
  project.rows[0].en = 'This is [unclear].'; assert.ok(publicationIssues(project, 'en').some(i => i.code === 'unclear'));
  assert.throws(() => renderDelivery(project, 'en', { final: true }), /缺词/);
  for (const marker of ['[market qualifier unclear]', '[unclear; trailing filler]', '[unintelligible name]', '[聽不清名稱]']) {
    project.rows[0].en = marker;
    assert.ok(publicationIssues(project, 'en').some(i => i.code === 'unclear'), marker);
    assert.throws(() => renderDelivery(project, 'en', { final: true }), /缺词/);
  }
  project.rows[0].en = 'word '.repeat(40); assert.ok(publicationIssues(project, 'en').some(i => i.code === 'layout-en'));
  const finalProject = fixture(); finalProject.translationSourceHash = sourceHash(finalProject.rows);
  const bundle = subtitleBundle(finalProject, { final: true });
  assert.deepEqual(bundle.files.slice(0, 3).map(f => f.name), ['yue/新视频.srt', 'en/新视频.srt', 'zh/新视频.srt']);
  assert.equal(bundle.bytes.readUInt32LE(), 0x04034b50);
  assert.equal(bundle.manifest.youtubePlaybackVerified, false);
});

test('reference display keeps every complete record once, including gap and tail timestamps', () => {
  const rows = [{ id: 's1', start: 6, end: 17 }, { id: 's2', start: 18, end: 26 }, { id: 's3', start: 26, end: 40 }];
  const refs = [0, 16, 17.5, 25, 39, 49].map((start, i) => ({ id: `r${i}`, start, end: null, text: `Original complete text ${i}` }));
  const displayed = [...referenceOwnership(rows, refs).values()].flat();
  assert.deepEqual(displayed, refs); assert.equal(new Set(displayed.map(r => r.id)).size, refs.length);
  assert.ok(displayed.every(r => r.end === null));
});

test('explicit provider failures pause until cooldown expiry and can resume after recovery', async () => {
  const dir = await fs.mkdtemp(path.join(root, '.data/test-recovery-')), previousFetch = globalThis.fetch; let count = 0;
  try {
    globalThis.fetch = async () => { count++; return Response.json({ error: 'busy' }, { status: 503 }); };
    let now = Date.now();
    const args = { url: 'https://unit.invalid/test', apiKey: 'fake', body: { model: 'test' }, runtime: { healthDir: path.join(dir, 'health'), now: () => now } };
    await assert.rejects(recordedRequest(dir, 'outage', args), /503/); assert.equal(count, 1);
    await assert.rejects(recordedRequest(dir, 'outage', args), /503/); assert.equal(count, 1);
    now += 60_001;
    globalThis.fetch = async () => { count++; return Response.json({ text: 'recovered' }); };
    assert.equal((await recordedRequest(dir, 'outage', args)).text, 'recovered'); assert.equal(count, 2);
    assert.equal((await recordedRequest(dir, 'outage', args)).text, 'recovered'); assert.equal(count, 2);
  } finally { globalThis.fetch = previousFetch; await fs.rm(dir, { recursive: true, force: true }); }
});

test('JSON text responses use the same strict tool validator as native tool calls', async () => {
  const dir = await fs.mkdtemp(path.join(root, '.data/test-json-tool-')), previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"value":"verified"}' }] });
    const value = await modelTool(dir, 'json-tool', { apiKey: 'fake', baseUrl: 'https://unit.invalid/v1', model: 'MiniMax-M3' }, { prompt: 'test', input: {}, tool: { name: 'test_tool', input_schema: {} }, validate: value => { assert.equal(value.value, 'verified'); return value; } });
    assert.equal(value.value, 'verified');
    assert.equal((await readJson(path.join(dir, 'requests/json-tool-accepted.json'))).mode, 'json_text');
  } finally { globalThis.fetch = previousFetch; await fs.rm(dir, { recursive: true, force: true }); }
});

test('translation and semantic audit reject missing source IDs, source edits and invented quotes', () => {
  const rows = fixture().rows, payload = { translations: rows.map(r => ({ id: r.id, en: r.en, zh: r.zh, note: '' })) };
  assert.equal(validateTracks(payload, rows).length, 2);
  assert.throws(() => validateTracks({ translations: [payload.translations[0], payload.translations[0]] }, rows));
  assert.throws(() => validateTracks({ translations: payload.translations.map(r => ({ ...r, start: 3 })) }, rows));
  assert.throws(() => validateAudit({ checkedIds: ['s0001'], issues: [] }, rows));
  assert.throws(() => validateAudit({ checkedIds: rows.map(r => r.id), issues: [{ id: 's0001', lang: 'en', severity: 'major', quote: 'invented', reason: 'bad' }] }, rows));
});

test('semantic quotes may be located only in actual text and fabricated quotes stay quarantined', () => {
  const rows=fixture().rows;
  const p={checkedIds:rows.map(r=>r.id),issues:[{id:'s0001',lang:'en',severity:'major',quote:'It is not certain.',reason:'Quoted a different cue'},{id:'s0001',lang:'en',severity:'major',quote:'a made-up phrase',reason:'Unsupported'}]};
  const audit=validateAudit(p,rows,{quarantineUnverified:true});
  assert.equal(audit.issues[0].id,'s0002');assert.equal(audit.issues[0].providerId,'s0001');
  assert.equal(audit.unverifiedIssues.length,1);assert.equal(audit.issues.length,1);
});

test('written Chinese review removes Cantonese residue while preserving English and source timing',async()=>{
  const dir=await fs.mkdtemp(path.join(root,'.data/test-written-')),previousFetch=globalThis.fetch;
  try{
    const rows=fixture().rows.map(r=>({...r}));rows[0].zh='如果佢跌破均线，咁就会有机会。';
    assert.ok(hasCantoneseRegister(rows[0].zh));
    globalThis.fetch=async()=>Response.json({content:[{type:'tool_use',name:'submit_written_chinese',input:{translations:[{id:'s0001',zh:'如果跌破均线，就会出现机会。'}]}}]});
    const fixed=await ensureWrittenChinese(dir,'zh',{apiKey:'fake',baseUrl:'https://unit.invalid/v1',model:'MiniMax-M3'},rows,{targetRows:rows.map(r=>({id:r.id,yue:r.yue})),glossary:'',context:{}});
    assert.ok(fixed.corrected);assert.ok(!hasCantoneseRegister(fixed.rows[0].zh));
    for(let i=0;i<rows.length;i++){assert.equal(fixed.rows[i].en,rows[i].en);assert.equal(fixed.rows[i].yue,rows[i].yue);assert.equal(fixed.rows[i].start,rows[i].start);assert.equal(fixed.rows[i].end,rows[i].end);}
  }finally{globalThis.fetch=previousFetch;await fs.rm(dir,{recursive:true,force:true});}
});

test('unknown request outcomes stop automatic duplicate spending; successful raw results are reused', async () => {
  const dir = await fs.mkdtemp(path.join(root, '.data/test-request-')), previousFetch = globalThis.fetch; let count = 0;
  try {
    globalThis.fetch = async () => { count++; throw new TypeError('disconnected'); };
    const args = { url: 'https://unit.invalid/test', apiKey: 'secret-test', body: { model: 'test' } };
    await assert.rejects(recordedRequest(dir, 'first', args), /未知/);
    await assert.rejects(recordedRequest(dir, 'first', args), /未知/); assert.equal(count, 1);
    globalThis.fetch = async () => { count++; return Response.json({ text: 'ok' }); };
    assert.equal((await recordedRequest(dir, 'first', { ...args, retryUnknown: true })).text, 'ok');
    assert.equal((await recordedRequest(dir, 'first', args)).text, 'ok'); assert.equal(count, 2);
    const contents = await fs.readFile(path.join(dir, 'requests/first-0-intent.json'), 'utf8'); assert.ok(!contents.includes('secret-test'));
  } finally { globalThis.fetch = previousFetch; await fs.rm(dir, { recursive: true, force: true }); }
});

test('real extraction and frames plus simulated MiniMax pass source approval, both translations and cached resume', async () => {
  const dir = await fs.mkdtemp(path.join(root, '.data/test-v2-')), previousFetch = globalThis.fetch; const calls = [];
  try {
    const { runProcess } = await import('../pipeline.mjs');
    await runProcess('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', path.join(dir, 'source.mp4')]);
    await writeJson(path.join(dir, 'job.json'), { id: 'test', filename: 'Synthetic.mp4', sourceFile: 'source.mp4', sourceHash: digest(await fs.readFile(path.join(dir, 'source.mp4'))), createdAt: '2026-10-20', glossary: '均線=moving average' });
    globalThis.fetch = async (url, options) => {
      calls.push(url);
      if (url.endsWith('speech_to_text')) {
        assert.equal(options.headers.language, 'yue'); assert.equal(options.body.get('timestamp_level'), 'word'); assert.equal(options.body.get('model'), 'asr-1.0'); assert.ok(options.body.get('file').size > 0);
        return Response.json({ text: '唔係。', segments: [{ start: .1, end: 1, text: '唔係。' }] });
      }
      const body = JSON.parse(options.body), tool = body.tools[0].name, input = JSON.parse(body.messages[0].content[0].text);
      assert.ok(!JSON.stringify(input).includes('referenceRecords'));
      if (tool === 'submit_review') {
        assert.ok(body.messages[0].content.some(c => c.type === 'image'));
        return Response.json({ content: [{ type: 'tool_use', name: tool, input: { rows: input.targetRows.map(r => ({ id: r.id, changes: [], issues: [] })), visualTerms: [] } }] });
      }
      if (tool === 'submit_tracks') return Response.json({ content: [{ type: 'tool_use', name: tool, input: { translations: input.targetRows.map(r => ({ id: r.id, en: 'No.', zh: '不是。', note: '' })) } }] });
      if (tool === 'submit_track_audit') return Response.json({ content: [{ type: 'tool_use', name: tool, input: { checkedIds: input.targetRows.map(r => r.id), issues: [] } }] });
      assert.fail('unexpected request');
    };
    const config = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', asr: { apiKey: 'fake', model: 'asr-1.0', endpoint: 'https://unit.invalid/speech_to_text' }, translation: { apiKey: 'fake', model: 'MiniMax-M3', baseUrl: 'https://unit.invalid/v1' } };
    const statuses = [], update = async stage => statuses.push(stage);
    const source = await prepareSource(dir, config, update, { asrFetchImpl: globalThis.fetch });
    assert.equal(source.rows[0].yue, '唔係。'); assert.equal(source.rows[0].en, ''); assert.equal(statuses.at(-1), 'source-review'); assert.equal(calls.length, 2);
    await assert.rejects(translateApproved(dir, config, update), /逐段核对/);
    const review = { ...source, rows: source.rows.map(r => ({ ...r, sourceReviewed: true })) }; await writeJson(path.join(dir, 'review.json'), review);
    const translated = await translateApproved(dir, config, update);
    assert.equal(translated.rows[0].en, 'No.'); assert.equal(translated.rows[0].zh, '不是。'); assert.equal(translated.rows[0].start, .1); assert.equal(translated.rows[0].end, 1); assert.equal(statuses.at(-1), 'done'); assert.equal(calls.length, 4);
    const bytes = await fs.readFile(path.join(dir, 'source-original.json')); await translateApproved(dir, config, update); assert.equal(calls.length, 4); assert.equal(digest(await fs.readFile(path.join(dir, 'source-original.json'))), digest(bytes));
    await fs.appendFile(path.join(dir, 'source.mp4'), 'changed-media');
    await assert.rejects(prepareSource(dir, config, update), /源媒体指纹/); assert.equal(calls.length, 4);
  } finally { globalThis.fetch = previousFetch; await fs.rm(dir, { recursive: true, force: true }); }
});

test('a confident text model cannot bypass a known correction requiring fresh audio evidence', async () => {
  const dir = await fs.mkdtemp(path.join(root, '.data/test-evidence-gate-')), previousFetch = globalThis.fetch;
  try {
    const lexicon = generalLexicon(JSON.parse(await fs.readFile(path.join(root, 'financial-error-lexicon.json'), 'utf8')));
    const row = { id: 's0001', start: 0, end: 4, yue: '今日video千祈冇錯過。', en: '', zh: '' };
    const config = { asr: { apiKey: 'fake', endpoint: 'https://unit.invalid/speech_to_text', model: 'asr-1.0' }, translation: { apiKey: 'fake', model: 'MiniMax-M3', baseUrl: 'https://unit.invalid/v1' } };
    await writeJson(path.join(dir, 'job.json'), { id: 'synthetic', filename: 'synthetic.wav', glossary: '' });
    await writeJson(path.join(dir, 'lexicon-snapshot.json'), lexicon);
    await writeJson(path.join(dir, 'workflow-checkpoint.json'), { settings: { version: WORKFLOW_VERSION, asrModel: config.asr.model, asrEndpoint: config.asr.endpoint, asrKeyHash: digest('fake'), translationModel: config.translation.model, translationEndpoint: config.translation.baseUrl, keyHash: digest('fake') }, media: { duration: 4, video: false, chunks: [] }, sourceRows: [row] });
    globalThis.fetch = async () => Response.json({ content: [{ type: 'tool_use', name: 'submit_review', input: { rows: [{ id: row.id, changes: [{ from: '千祈冇錯過', to: '千祈唔好錯過', category: 'term', basis: 'language_context', frameIds: [], reason: 'A confident language guess', confidence: 'high' }], issues: [] }], visualTerms: [] } }] });
    const project = await prepareSource(dir, config, async () => {});
    assert.equal(project.rows[0].yue, row.yue);
    assert.ok(project.rows[0].sourceIssues.some(i => i.reason.includes('不能代替音频证据')));
    project.rows[0].sourceReviewed = true;
    assert.throws(() => assertSourceApproved(project), /已知关键误写/);
  } finally { globalThis.fetch = previousFetch; await fs.rm(dir, { recursive: true, force: true }); }
});
