import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, readJson, writeJson } from '../pipeline.mjs';

test('real media extraction plus simulated providers creates three aligned tracks and retains raw results', async () => {
  const runtime = fileURLToPath(new URL('../.data/', import.meta.url));
  await fs.mkdir(runtime, { recursive: true });
  const dir = await fs.mkdtemp(path.join(runtime, 'test-media-'));
  const originalFetch = globalThis.fetch;
  try {
    const wav = Buffer.alloc(44 + 16000 * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(32000, 40);
    await fs.writeFile(path.join(dir, 'source.wav'), wav);
    await writeJson(path.join(dir, 'job.json'), { id: 'test', filename: 'source.wav', sourceFile: 'source.wav', glossary: 'CPI', mode: 'zh-en', createdAt: new Date().toISOString() });
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push(url);
      if (url.endsWith('/upload')) {
        assert.ok(options.body.get('audio').size > 0);
        return Response.json({ audio_url: 'https://files.invalid/audio' });
      }
      if (url.endsWith('/pre-recorded')) {
        const body = JSON.parse(options.body);
        assert.equal(body.translation, false);
        assert.deepEqual(body.language_config, { languages: ['zh', 'en'], code_switching: true });
        return Response.json({ id: 'test-recording' });
      }
      if (url.endsWith('/pre-recorded/test-recording')) return Response.json({ status: 'done', result: { transcription: { utterances: [{ start: 0.1, end: 0.9, text: '唔係', language: 'zh' }] } } });
      if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"translations":[{"id":"s0001","en":"No.","zh":"不是。"}]}' } }] });
      assert.fail(`Unexpected network request: ${url}`);
    };
    const result = await runPipeline(dir, { gladiaKey: 'test', ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', translation: { apiKey: 'test', baseUrl: 'https://test.invalid', model: 'test' } }, async () => {});
    assert.equal(requests.length, 4);
    assert.equal(result.rows[0].yue, '唔係'); assert.equal(result.rows[0].en, 'No.'); assert.equal(result.rows[0].zh, '不是。');
    assert.equal(result.rows[0].start, 0.1); assert.equal(result.rows[0].end, 0.9);
    assert.equal((await readJson(path.join(dir, 'gladia-raw.json'))).status, 'done');
    assert.equal((await readJson(path.join(dir, 'source-original.json')))[0].en, '');
  } finally { globalThis.fetch = originalFetch; await fs.rm(dir, { recursive: true, force: true }); }
});

test('failed translation resumes completed batches without uploading or transcribing again', async () => {
  const runtime = fileURLToPath(new URL('../.data/', import.meta.url));
  await fs.mkdir(runtime, { recursive: true });
  const dir = await fs.mkdtemp(path.join(runtime, 'test-'));
  const originalFetch = globalThis.fetch;
  try {
    const rows = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, start: i * 3, end: i * 3 + 2, yue: `原文 ${i}`, en: '', zh: '' }));
    await writeJson(path.join(dir, 'job.json'), { id: 'test', filename: 'test.mp4', glossary: '', mode: 'auto', createdAt: new Date().toISOString() });
    await writeJson(path.join(dir, 'checkpoint.json'), { duration: 50, audioUrl: 'https://unused.invalid/audio', gladiaJobId: 'already-submitted', sourceRows: rows, translated: [] });
    const calls = []; let fail = true;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://translation.invalid/chat/completions');
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages[1].content).segments;
      calls.push(input.map(r => r.id));
      if (calls.length === 2 && fail) return new Response('', { status: 503 });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ translations: input.map(r => ({ id: r.id, en: `English ${r.id}`, zh: `中文 ${r.id}` })) }) } }], usage: { total_tokens: 100 } });
    };
    const config = { gladiaKey: 'test-key', translation: { apiKey: 'test', model: 'test', baseUrl: 'https://translation.invalid' } };
    const stages = [];
    await assert.rejects(runPipeline(dir, config, async stage => stages.push(stage)), /503/);
    assert.equal((await readJson(path.join(dir, 'checkpoint.json'))).translated.length, 12);
    fail = false;
    const result = await runPipeline(dir, config, async stage => stages.push(stage));
    assert.equal(result.rows.length, 14);
    assert.deepEqual(calls[1], calls[2]);
    assert.equal(stages.at(-1), 'done');
    assert.equal(result.usage.cost, null);
    assert.equal(result.kind, 'generated-draft');
    assert.equal((await readJson(path.join(dir, 'result.json'))).rows[0].yue, '原文 0');
    await assert.rejects(runPipeline(dir, { ...config, gladiaKey: 'different-key' }, async () => {}), /另一 Gladia Key/);
  } finally { globalThis.fetch = originalFetch; await fs.rm(dir, { recursive: true, force: true }); }
});
