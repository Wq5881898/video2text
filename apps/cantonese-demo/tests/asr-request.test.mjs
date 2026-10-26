import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { DEFAULT_ASR_TIMEOUT_MS, resolveAsrTimeout, recordedAsrRequest } from '../asr-request.mjs';
import { recordedRequest } from '../model-client.mjs';
import { loadConfig } from '../config.mjs';
import { errorKey, message } from '../public/cantones-i18n.mjs';
import { asrTransport } from '../asr-transport.mjs';

const asr = { apiKey: 'synthetic-secret-only', endpoint: 'https://unit.invalid/speech_to_text', model: 'asr-1.0' };
const identity = { model: asr.model, language: 'yue', offset: 0, duration: 448.5, audioSha256: 'synthetic-audio' };
async function temporary(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cantones-asr-test-'));
  try { await run(dir); } finally {
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir())) throw Error('Refusing cleanup outside the temporary directory');
    await fs.rm(dir, { recursive: true, force: true });
  }
}
function delayedBody(signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('unused'), 2000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('synthetic', 'AbortError')); }, { once: true });
  });
}

test('ASR uses the evaluated eight-minute default and rejects invalid configurable budgets', async () => {
  assert.equal(DEFAULT_ASR_TIMEOUT_MS, 480000); assert.equal(resolveAsrTimeout(''), 480000);
  for (const value of ['NaN', 0, -1, 1.5, 1800001]) assert.throws(() => resolveAsrTimeout(value), /MINIMAX_ASR_TIMEOUT_MS/);
  await temporary(async dir => {
    assert.equal(loadConfig(dir, { VIDEO2TEXT_CONFIG_DIR: dir }).asr.timeoutMs, 480000);
    assert.equal(loadConfig(dir, { VIDEO2TEXT_CONFIG_DIR: dir, MINIMAX_ASR_TIMEOUT_MS: '600000' }).asr.timeoutMs, 600000);
  });
});

test('changing the ASR wait budget reuses completed legacy requests without another provider call', async () => {
  await temporary(async dir => {
    let calls = 0;
    const request = { url: asr.endpoint, apiKey: asr.apiKey, body: { model: asr.model }, identity,
      runtime: { healthDir: path.join(dir, 'health') }, fetchImpl: async () => { calls++; return Response.json({ text: 'cached' }); } };
    await recordedRequest(dir, 'asr-0', request);
    const result = await recordedAsrRequest(dir, 'asr-0', { ...asr, timeoutMs: 480000 }, request);
    assert.equal(result.text, 'cached'); assert.equal(calls, 1);
  });
});

test('ASR timeout preserves an unknown intent, blocks silent resends, and archives diagnostics on explicit recovery', async () => {
  await temporary(async dir => {
    let calls = 0;
    const options = { body: { model: asr.model }, identity, runtime: { healthDir: path.join(dir, 'health') },
      fetchImpl: async (_url, request) => { calls++; assert.equal(request.headers.language, 'yue'); await delayedBody(request.signal); } };
    await assert.rejects(recordedAsrRequest(dir, 'asr-0', { ...asr, timeoutMs: 25 }, options), /未知.*TimeoutError/);
    const file = path.join(dir, 'requests/asr-0-0-interrupted.json');
    const details = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(details.kind, 'timeout'); assert.equal(details.phase, 'awaiting-response-headers');
    assert.equal(details.httpStatus, null); assert.equal(details.timeoutMs, 25);
    await assert.rejects(recordedAsrRequest(dir, 'asr-0', asr, options), /未知/); assert.equal(calls, 1);
    const result = await recordedAsrRequest(dir, 'asr-0', asr, { ...options, retryUnknown: true,
      fetchImpl: async () => { calls++; return Response.json({ text: 'recovered' }); } });
    assert.equal(result.text, 'recovered'); assert.equal(calls, 2);
    const files = await fs.readdir(path.join(dir, 'requests'));
    assert.ok(files.some(f => /unknown-\d+-interrupted\.json/u.test(f)));
    assert.ok(!JSON.stringify(details).includes(asr.apiKey));
  });
});

test('receiving HTTP headers without a complete body still pauses as an unknown outcome', async () => {
  await temporary(async dir => {
    let calls = 0;
    const options = { body: { model: asr.model }, identity, runtime: { healthDir: path.join(dir, 'health') },
      fetchImpl: async (_url, request) => { calls++; return { status: 200, headers: new Headers(), text: () => delayedBody(request.signal) }; } };
    await assert.rejects(recordedAsrRequest(dir, 'asr-0', { ...asr, timeoutMs: 25 }, options), /未知.*TimeoutError/);
    const details = JSON.parse(await fs.readFile(path.join(dir, 'requests/asr-0-0-interrupted.json'), 'utf8'));
    assert.equal(details.phase, 'reading-response-body'); assert.equal(details.httpStatus, 200); assert.equal(details.kind, 'timeout');
    await assert.rejects(recordedAsrRequest(dir, 'asr-0', asr, options), /未知/); assert.equal(calls, 1);
  });
});

test('timeout guidance identifies the failure without telling the user the provider did not charge', () => {
  const key = errorKey({ message: '模型请求结果未知，已保留提交记录；未自动重发。TimeoutError' });
  assert.equal(key, 'requestTimeout'); assert.match(message('zh-Hant', key), /核對服務商記錄/);
  assert.match(message('en', key), /Check the provider records/);
});

test('native ASR transport preserves multipart encoding and length without a separate fetch deadline', async () => {
  let received;
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received = { headers: req.headers, bytes: Buffer.concat(parts) };
    res.setHeader('content-type', 'application/json'); res.end('{"text":"ok"}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const form = new FormData(); form.append('model', 'asr-1.0'); form.append('file', new Blob(['synthetic-audio']), 'chunk.flac');
    const response = await asrTransport(`http://127.0.0.1:${server.address().port}/speech_to_text`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic', language: 'yue' }, body: form, signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 200); assert.deepEqual(JSON.parse(await response.text()), { text: 'ok' });
    assert.equal(Number(received.headers['content-length']), received.bytes.length);
    assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/u);
    assert.equal(received.headers.language, 'yue'); assert.match(received.bytes.toString(), /synthetic-audio/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('native ASR transport obeys the total deadline after headers and preserves the uncertain request', async () => {
  const server = http.createServer(async (req, res) => {
    for await (const _part of req) {}
    res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders();
    const timer = setTimeout(() => res.end('{"text":"late"}'), 5000);
    res.once('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    await temporary(async dir => {
      await assert.rejects(recordedAsrRequest(dir, 'native-timeout', { ...asr, endpoint: `http://127.0.0.1:${server.address().port}/speech_to_text`, timeoutMs: 500 }, {
        body: 'synthetic', identity, runtime: { healthDir: path.join(dir, 'health') },
      }), /未知.*TimeoutError/);
      const details = JSON.parse(await fs.readFile(path.join(dir, 'requests/native-timeout-0-interrupted.json'), 'utf8'));
      assert.equal(details.phase, 'reading-response-body'); assert.equal(details.httpStatus, 200);
      assert.equal(details.kind, 'timeout');
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
