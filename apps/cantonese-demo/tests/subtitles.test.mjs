import test from 'node:test';
import assert from 'node:assert/strict';
import { timestamp, renderSrt, parseReference, matchReference, normalizeUtterances, validateTranslation, validateRows, filenameStem } from '../public/subtitles.mjs';
import { recognitionConfig, translationPayload, translateValidatedBatch } from '../pipeline.mjs';

const row = { id: 's0001', start: 0.1, end: 4.5, yue: '我哋睇下 3.7%。', en: 'Let’s look at 3.7%.', zh: '我们看看 3.7%。' };
test('SRT millisecond rounding carries to the next minute and hour', () => {
  assert.equal(timestamp(59.9996), '00:01:00,000');
  assert.equal(timestamp(3599.9996), '01:00:00,000');
  assert.match(renderSrt([row], 'yue'), /我哋/);
  assert.equal(filenameStem('我的视频.mp4'), '我的视频');
});
test('invalid timing and stale translations cannot be exported', () => {
  assert.throws(() => renderSrt([{ ...row, end: 0.1 }], 'en'), /时间无效/);
  assert.throws(() => renderSrt([{ ...row, end: 0.1001 }], 'en'), /时间无效/);
  assert.throws(() => renderSrt([{ ...row, stale: true }], 'en'), /原文已修改/);
  assert.throws(() => renderSrt([row], 'en', 2), /超出/);
  assert.throws(() => renderSrt([{ ...row, en: '' }], 'en'), /为空/);
});
test('start-only references keep their missing ends and allow many-to-one matches', () => {
  const refs = parseReference('[{"start":"0:01","text":"甲"},{"start":"0:03","text":"乙"}]', 'ref.json');
  assert.equal(refs[0].end, null);
  assert.equal(matchReference({ start: 1, end: 5 }, refs).length, 2);
  assert.equal(matchReference({ start: 1, end: 2 }, refs)[0].id, matchReference({ start: 2, end: 3 }, refs)[0].id);
  assert.equal(refs[1].end, null);
});
test('SRT, VTT and timestamp TXT retain text and precise timing', () => {
  const srt = parseReference('1\n00:00:01,250 --> 00:00:03,000\n第一行\n第二行\n', 'ref.srt');
  assert.deepEqual([srt[0].start, srt[0].end, srt[0].text], [1.25, 3, '第一行\n第二行']);
  const vtt = parseReference('WEBVTT\n\n00:01.000 --> 00:03.500 align:start\nHello\n', 'ref.vtt');
  assert.equal(vtt[0].end, 3.5);
  assert.equal(parseReference('[0:06] 第一段\n0:10\n第二段', 'ref.txt')[1].text, '第二段');
  assert.throws(() => parseReference('[{"start":"oops","text":"x"}]', 'ref.json'), /时间无效/);
});
test('recognition preserves short and empty utterances without English cleanup', () => {
  const result = normalizeUtterances({ result: { transcription: { utterances: [{ start: 0, end: 0.5, text: '唔係' }, { start: 0.6, end: 1, text: '' }] } } }, 2);
  assert.equal(result.length, 2); assert.equal(result[0].yue, '唔係'); assert.equal(result[1].id, 's0002');
});
test('translation validates IDs, reorders safely and never accepts missing or duplicate rows', () => {
  const batch = [row, { ...row, id: 's0002' }];
  const content = JSON.stringify({ translations: [{ id: 's0002', en: 'second', zh: '第二' }, { id: 's0001', en: 'first', zh: '第一' }] });
  assert.equal(validateTranslation(content, batch)[0].en, 'first');
  assert.throws(() => validateTranslation('{"translations":[{"id":"s0001","en":"x","zh":"中"}]}', batch));
  assert.throws(() => validateTranslation(JSON.stringify({ translations: [{ id: 's0001', en: 'x', zh: '中' }, { id: 's0001', en: 'x', zh: '中' }] }), batch));
});
test('numeric differences are review hints, not automated factual corrections', () => {
  const issues = validateRows([{ ...row, en: 'The figure is 3.6%.' }]);
  assert.equal(issues.find(i => i.code === 'numbers-en').blocking, false);
});
test('Cantonese candidate requests allow code switching and never invent yue support', () => {
  assert.deepEqual(recognitionConfig('auto'), { languages: [], code_switching: true });
  assert.deepEqual(recognitionConfig('zh-en'), { languages: ['zh', 'en'], code_switching: true });
  assert.throws(() => recognitionConfig('yue'));
});
test('translation payload contains only source IDs/text and the explicit glossary', () => {
  const payload = translationPayload({ model: 'test' }, [{ ...row, reference: 'SECRET_REFERENCE', en: 'OLD_ANSWER' }], 'CPI');
  const source = JSON.stringify(payload);
  assert.ok(!source.includes('SECRET_REFERENCE')); assert.ok(!source.includes('OLD_ANSWER'));
  assert.match(source, /Simplified Chinese/);
});

test('malformed translation retries and splits without accepting extra model rows', async () => {
  const savedFetch = globalThis.fetch; const calls = []; let records = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      const batch = JSON.parse(JSON.parse(options.body).messages[1].content).segments;
      calls.push(batch.length);
      const translations = batch.length > 1 ? [{ note: 'invalid orphan' }] : batch.map(r => ({ id: r.id, en: 'English', zh: '中文' }));
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations }) } }] });
    };
    const result = await translateValidatedBatch([row, { ...row, id: 's0002' }], { apiKey: 'test', baseUrl: 'https://test.invalid', model: 'test' }, '', async () => { records++; });
    assert.deepEqual(calls, [2, 2, 1, 1]); assert.equal(records, 4); assert.equal(result.length, 2);
    assert.equal(result[0].id, 's0001'); assert.equal(result[1].id, 's0002');
  } finally { globalThis.fetch = savedFetch; }
});
