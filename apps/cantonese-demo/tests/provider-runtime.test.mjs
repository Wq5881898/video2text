import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { providerIdentity, retryAfterMs, classifyProviderFailure, providerHealth, recordProviderFailure, assertProviderAvailable } from '../provider-runtime.mjs';
import { recordedRequest, digest } from '../model-client.mjs';
import { recordedChat, chatBody } from '../translation-providers.mjs';
import { preflight, inspectServices } from '../preflight.mjs';
import { readJson, writeJson } from '../pipeline.mjs';

const config = {
  asr: { apiKey: 'fake-asr-key', endpoint: 'https://asr.invalid/speech_to_text', model: 'asr-1.0' },
  translation: { apiKey: 'fake-text-key', baseUrl: 'https://text.invalid/v1', model: 'MiniMax-M3' },
};
const probeResponse = () => Response.json({ content: [{ type: 'tool_use', name: 'submit_service_check', input: { ok: true } }] });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = Date.now();
  return { dir, runtime: { healthDir: path.join(dir, 'health'), now: () => now }, advance: milliseconds => { now += milliseconds; } };
}

test('capacity, rate, balance and authentication are distinct; 200 business errors are rejected', () => {
  assert.equal(classifyProviderFailure(200, { error: { message: 'Selected model is at capacity. Please try a different model.' } }).kind, 'capacity');
  assert.equal(classifyProviderFailure(429, { error: { code: 'insufficient_quota' } }).kind, 'quota');
  assert.equal(classifyProviderFailure(429, { error: { message: 'too many requests' } }).kind, 'rate_limit');
  assert.equal(classifyProviderFailure(401, {}).kind, 'authentication');
  assert.equal(classifyProviderFailure(200, { base_resp: { status_code: 1, status_msg: 'model overloaded' } }).kind, 'capacity');
  assert.equal(classifyProviderFailure(200, { text: 'The model is at capacity.' }), null);
  const now = Date.now();
  assert.equal(retryAfterMs('120', now), 120_000);
  assert.equal(retryAfterMs(new Date(now + 180_000).toUTCString(), now) > 179_000, true);
  assert.equal(retryAfterMs('invalid', now), 0);
});

test('cooldown is shared across jobs, keyed by endpoint/model/credential and survives a new reader', async t => {
  const { dir, runtime, advance } = await fixture(t);
  const spec = { url: 'https://text.invalid/v1/messages', model: 'M3', apiKey: 'secret-local-test' }, id = providerIdentity(spec);
  const failure = await recordProviderFailure(id, 503, { error: 'Selected model is at capacity' }, { ...runtime, retryAfter: '120' });
  assert.equal(Date.parse(failure.retryAt) - runtime.now(), 120_000);
  await assert.rejects(assertProviderAvailable(id, { ...runtime }), error => error.kind === 'capacity');
  await assertProviderAvailable(providerIdentity({ ...spec, model: 'other-model' }), runtime);
  await assertProviderAvailable(providerIdentity({ ...spec, apiKey: 'other-key' }), runtime);
  await assertProviderAvailable(providerIdentity({ ...spec, url: 'https://other.invalid/v1/messages' }), runtime);
  assert.ok(!(await fs.readFile(path.join(dir, 'health', id + '.json'), 'utf8')).includes(spec.apiKey));
  advance(120_001);
  assert.equal((await providerHealth(id, runtime)).blocked, false);
});

test('messages client sends once on capacity, blocks other keys and resumes into a new ledger', async t => {
  const { dir, runtime, advance } = await fixture(t);
  let calls = 0;
  const args = { url: 'https://text.invalid/messages', apiKey: 'fake', body: { model: 'M3' }, runtime,
    fetchImpl: async () => { calls++; return Response.json({ error: { message: 'Selected model is at capacity' } }, { status: 503, headers: { 'retry-after': '90' } }); } };
  await assert.rejects(recordedRequest(dir, 'first', args), error => error.code === 'PROVIDER_CAPACITY');
  await assert.rejects(recordedRequest(dir, 'second', args), /容量/);
  await assert.rejects(recordedRequest(dir, 'first', args), /容量/);
  assert.equal(calls, 1);
  advance(90_001);
  const recovered = { ...args, fetchImpl: async () => { calls++; return Response.json({ text: 'saved' }); } };
  assert.equal((await recordedRequest(dir, 'first', recovered)).text, 'saved');
  await recordProviderFailure(providerIdentity({ url: args.url, model: 'M3', apiKey: 'fake' }), 503, { error: 'busy' }, runtime);
  assert.equal((await recordedRequest(dir, 'first', recovered)).text, 'saved');
  assert.equal(calls, 2);
  assert.equal((JSON.parse(await fs.readFile(path.join(dir, 'requests/first-0-response.json')))).status, 503);
});

test('HTTP 200 capacity errors never pass as completed responses', async t => {
  const { dir, runtime } = await fixture(t);
  const args = { url: 'https://text.invalid/messages', apiKey: 'fake', body: { model: 'M3' }, runtime,
    fetchImpl: async () => Response.json({ error: { message: 'Selected model is at capacity' } }) };
  await assert.rejects(recordedRequest(dir, 'first', args), error => error.kind === 'capacity' && error.httpStatus === 200);
});

test('streaming client recovers after more than three historical failures without replaying successes', async t => {
  const { dir, runtime, advance } = await fixture(t);
  let calls = 0;
  const cfg = { provider: 'qwen', model: 'private-model', baseUrl: 'https://chat.invalid/v1', apiKey: 'fake-key' }, body = chatBody(cfg, 'test', {}, {});
  const busy = { runtime, fetchImpl: async () => { calls++; return Response.json({ error: { message: 'model is at capacity' } }, { status: 503 }); } };
  for (let attempt = 0; attempt < 4; attempt++) {
    await assert.rejects(recordedChat(dir, 'chat', cfg, body, busy), /容量/);
    await assert.rejects(recordedChat(dir, 'chat', cfg, body, busy), /容量/);
    advance(60_001);
  }
  assert.equal(calls, 4);
  const healthy = { runtime, fetchImpl: async () => { calls++; return Response.json({ choices: [{ message: { content: '{"translations":[]}' }, finish_reason: 'stop' }] }); } };
  assert.equal((await recordedChat(dir, 'chat', cfg, body, healthy)).text, '{"translations":[]}');
  await recordedChat(dir, 'chat', cfg, body, healthy);
  assert.equal(calls, 5);
});

test('streaming business capacity errors get a cooldown while truncated responses stay unknown', async t => {
  const { dir, runtime, advance } = await fixture(t);
  const cfg = { provider: 'qwen', model: 'private-model', baseUrl: 'https://chat.invalid/v1', apiKey: 'fake-key' };
  const body = chatBody(cfg, 'test', {}, {});
  await assert.rejects(recordedChat(dir, 'busy', cfg, body, {
    runtime, fetchImpl: async () => new Response('data: {"error":{"message":"model at capacity"}}\n\n'),
  }), error => error.kind === 'capacity');
  advance(60_001);
  let calls = 0;
  const args = { runtime, fetchImpl: async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n'); } };
  await assert.rejects(recordedChat(dir, 'partial', cfg, body, args), /not automatically/);
  await assert.rejects(recordedChat(dir, 'partial', cfg, body, args), /unknown/);
  assert.equal(calls, 1);
});

test('preflight deduplicates concurrent probes, caches success and invalidates on credential/model change', async t => {
  const { dir, runtime, advance } = await fixture(t); let calls = 0;
  const options = { ...runtime, fetchImpl: async (_url, args) => {
    calls++;
    const request = JSON.parse(args.body);
    assert.equal(request.max_tokens, 256);
    assert.equal(request.messages[0].content.length, 1);
    assert.ok(!args.body.includes('sourceRows'));
    return probeResponse();
  } };
  const both = await Promise.all([preflight(config, options), preflight(config, options)]);
  assert.equal(both[0].ok, true); assert.equal(calls, 1);
  assert.equal(both[0].asr, 'configuration-only'); assert.equal(both[0].visualVerified, false);
  assert.equal((await preflight(config, options)).cached, true); assert.equal(calls, 1);
  advance(300_001); await preflight(config, options); assert.equal(calls, 2);
  await preflight({ ...config, translation: { ...config.translation, apiKey: 'changed-key' } }, options); assert.equal(calls, 3);
  await preflight({ ...config, translation: { ...config.translation, model: 'changed-model' } }, options); assert.equal(calls, 4);
  const service = await inspectServices(config, runtime);
  assert.equal(service.asr.kind, 'unchecked');
  assert.ok(!JSON.stringify(service).includes('fake-text-key'));
});

test('preflight blocks uploads on a known failure and checks config before sending', async t => {
  const { runtime } = await fixture(t); let calls = 0;
  const options = { ...runtime, fetchImpl: async () => { calls++; return Response.json({ error: 'model at capacity' }, { status: 503 }); } };
  await assert.rejects(preflight(config, options), /容量/);
  await assert.rejects(preflight(config, options), /容量/);
  assert.equal(calls, 1);
  await assert.rejects(preflight({ ...config, asr: { ...config.asr, apiKey: '' } }, options), /ASR Key/);
  await assert.rejects(preflight(config, { ...options, mediaTools: false }), /FFmpeg/);
  assert.equal(calls, 1);
  const service = await inspectServices(config, runtime);
  assert.equal(service.translation.blocked, true);
  assert.equal(service.asr.blocked, false);
});

test('legacy request caches retain endpoint identity and never leak across endpoints', async t => {
  const { dir, runtime } = await fixture(t);
  const body = { model: 'M3' }, apiKey = 'fake-key', url = 'https://first.invalid/messages';
  const fingerprint = digest({ request: body, credentialHash: digest(apiKey) });
  await writeJson(path.join(dir, 'requests/legacy-0-intent.json'), { url, fingerprint });
  await writeJson(path.join(dir, 'requests/legacy-0-response.json'), { status: 200, payload: { text: 'cached' } });
  const fetchImpl = () => { assert.fail('Successful cache must not be resent'); };
  assert.equal((await recordedRequest(dir, 'legacy', { body, apiKey, url, runtime, fetchImpl })).text, 'cached');
  await assert.rejects(recordedRequest(dir, 'legacy', { body, apiKey, url: 'https://other.invalid/messages', runtime, fetchImpl }), /缓存版本/);
});

test('a malformed preflight response fails after one probe without certifying tool access', async t => {
  const { runtime } = await fixture(t); let calls = 0;
  await assert.rejects(preflight(config, { ...runtime, fetchImpl: async () => {
    calls++; return Response.json({ content: [{ type: 'tool_use', name: 'submit_service_check', input: { ok: false } }] });
  } }), /结构化/);
  assert.equal(calls, 1);
  const id = providerIdentity({ url: 'https://text.invalid/anthropic/v1/messages', model: 'MiniMax-M3', apiKey: 'fake-text-key' });
  assert.equal((await providerHealth(id, runtime)).preflightUntil, null);
});

test('atomic checkpoint writers use separate temporary files and preserve valid JSON under contention', async t => {
  const { dir } = await fixture(t), file = path.join(dir, 'checkpoint.json');
  await writeJson(file, { index: -1 });
  await Promise.all(Array.from({ length: 12 }, (_, index) => writeJson(file, { index, text: '完整记录'.repeat(100) })));
  const value = await readJson(file);
  assert.ok(Number.isInteger(value.index) && value.index >= 0 && value.index < 12);
  assert.equal(value.text, '完整记录'.repeat(100));
  assert.ok(!(await fs.readdir(dir)).some(name => name.endsWith('.tmp')));
});

test('Windows transient checkpoint locks retry without truncating the previous record', { skip: process.platform !== 'win32' }, async t => {
  const { dir } = await fixture(t), file = path.join(dir, 'checkpoint.json');
  await writeJson(file, { revision: 1 });
  const rename = fs.rename.bind(fs); let attempts = 0;
  const locked = t.mock.method(fs, 'rename', async (source, destination) => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('Transient reader lock'), { code: 'EPERM' });
    return rename(source, destination);
  });
  await writeJson(file, { revision: 2 });
  locked.mock.restore();
  assert.equal(attempts, 3);
  assert.equal((await readJson(file)).revision, 2);
});
