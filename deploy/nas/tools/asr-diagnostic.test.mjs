import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = process.env.ASR_DIAGNOSTIC_APP_ROOT || fileURLToPath(new URL('../../../apps/cantonese-demo/', import.meta.url));
const script = fileURLToPath(new URL('./asr-diagnostic.mjs', import.meta.url));
const { runProcess } = await import(pathToFileURL(path.join(app, 'pipeline.mjs')));
const job = '12345678-1234-1234-1234-123456789abc', run = 'controlled-test';
async function fixture(handler, exercise, signal = 'sine=frequency=400:duration=70') {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'asr-diagnostic-test-'));
  const server = http.createServer(handler), sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const jobDir = path.join(folder, job), dir = path.join(folder, 'asr-diagnostics', job, run);
  try {
    await fs.mkdir(jobDir);
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-n', '-f', 'lavfi', '-i', signal, '-ac', '1', '-ar', '16000', '-c:a', 'flac', path.join(jobDir, 'audio.flac')]);
    await fs.writeFile(path.join(jobDir, 'status.json'), '{"stage":"error","original":true}');
    const invoke = (extra = [], env = {}) => new Promise(resolve => {
      const child = spawn(process.execPath, [script, `--app-root=${app}`, `--job=${job}`, `--run=${run}`, ...extra], {
        windowsHide: true, env: { ...process.env, CANTONES_DATA_DIR: folder, VIDEO2TEXT_CONFIG_DIR: path.join(folder, 'no-credentials'),
          MINIMAX_ASR_API_KEY: 'synthetic-key-only', MINIMAX_ASR_ENDPOINT: `http://127.0.0.1:${server.address().port}/speech_to_text`, MINIMAX_ASR_TIMEOUT_MS: '2000', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
      child.on('exit', code => resolve({ code, out, err }));
    });
    await exercise({ invoke, dir, jobDir });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(jobDir, 'status.json'), 'utf8')), { stage: 'error', original: true });
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir())) throw Error('Unsafe test cleanup');
    await fs.rm(folder, { recursive: true, force: true });
  }
}

test('offline 60-second preparation and the real ASR adapter preserve the original job, trace stages and reuse responses', async () => {
  let calls = 0;
  await fixture(async (req, res) => {
    calls++; const parts = []; for await (const b of req) parts.push(b); const bytes = Buffer.concat(parts);
    assert.equal(req.headers.language, 'yue'); assert.equal(Number(req.headers['content-length']), bytes.length);
    assert.match(bytes.toString(), /verbose_json/u); assert.match(bytes.toString(), /timestamp_level/u);
    res.end(JSON.stringify({ text: '今日市場上升。', segments: [{ start: 0.1, end: 1, text: '今日市場上升。' }] }));
  }, async ({ invoke, dir }) => {
    const prepared = await invoke(); assert.equal(prepared.code, 0, prepared.err); assert.equal(calls, 0);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.duration, 60); assert.ok(manifest.bytes > 0);
    const sent = await invoke(['--send']); assert.equal(sent.code, 0, sent.err); assert.equal(calls, 1);
    const trace = await fs.readFile(path.join(dir, 'transport.jsonl'), 'utf8');
    for (const event of ['request_created', 'tcp_connected', 'socket_flush_finished', 'response_headers', 'response_ended']) assert.ok(trace.includes(event), event);
    assert.ok(!trace.includes('synthetic-key-only'));
    const cached = await invoke(['--send']); assert.equal(cached.code, 0, cached.err); assert.equal(calls, 1);
    assert.equal(JSON.parse(cached.out).requestsObserved, 0);
  });
});

test('a timed-out diagnostic never silently resends the same unknown request', async () => {
  let calls = 0;
  await fixture(async req => { calls++; for await (const _b of req) {} }, async ({ invoke, dir }) => {
    const result = await invoke(['--seconds=2', '--send'], { MINIMAX_ASR_TIMEOUT_MS: '500' });
    assert.equal(result.code, 1); assert.match(result.err, /TimeoutError/u); assert.equal(calls, 1);
    const interrupted = JSON.parse(await fs.readFile(path.join(dir, 'requests/asr-diagnostic-0-interrupted.json'), 'utf8'));
    assert.equal(interrupted.kind, 'timeout'); assert.equal(interrupted.httpStatus, null);
    const again = await invoke(['--seconds=2', '--send']); assert.equal(again.code, 1); assert.match(again.err, /未知/u); assert.equal(calls, 1);
  });
});

test('a concurrent diagnostic or changed clip cannot start a paid request', async () => {
  let calls = 0;
  await fixture(async (_req, res) => { calls++; res.end('{}'); }, async ({ invoke, dir }) => {
    assert.equal((await invoke()).code, 0);
    await fs.writeFile(path.join(dir, 'running.lock'), 'another invocation');
    const locked = await invoke(['--send']); assert.equal(locked.code, 1); assert.equal(calls, 0);
    assert.equal(await fs.readFile(path.join(dir, 'running.lock'), 'utf8'), 'another invocation');
    await fs.unlink(path.join(dir, 'running.lock'));
    const changed = await invoke(['--seconds=30', '--send']); assert.equal(changed.code, 1); assert.match(changed.err, /input changed/u); assert.equal(calls, 0);
  });
});

test('the MP3 comparison preserves the excerpt, reduces noisy audio size and sends the correct MIME through the same adapter', async () => {
  let calls = 0;
  await fixture(async (req, res) => {
    calls++; const parts = []; for await (const b of req) parts.push(b); const body = Buffer.concat(parts).toString();
    assert.match(body, /filename="clip\.mp3"/u); assert.match(body, /Content-Type: audio\/mpeg/iu);
    assert.equal(req.headers.language, 'yue');
    res.end(JSON.stringify({ text: '同一段。', segments: [{ start: 0.1, end: 1, text: '同一段。' }] }));
  }, async ({ invoke, dir, jobDir }) => {
    const prepared = await invoke(['--format=mp3']); assert.equal(prepared.code, 0, prepared.err); assert.equal(calls, 0);
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.plan.seconds, 60); assert.equal(manifest.plan.offset, 0); assert.equal(manifest.plan.bitrateKbps, 64);
    assert.ok(Math.abs(manifest.duration - 60) < 0.2); assert.ok(manifest.bytes < 600000);
    assert.ok(manifest.bytes < (await fs.stat(path.join(jobDir, 'audio.flac'))).size / 2);
    const sent = await invoke(['--format=mp3', '--send']); assert.equal(sent.code, 0, sent.err); assert.equal(calls, 1);
    const wrongFormat = await invoke(['--send']); assert.equal(wrongFormat.code, 1); assert.equal(calls, 1);
  }, 'anoisesrc=color=white:duration=70:sample_rate=16000:seed=1');
});
