import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

// Temporary, isolated diagnostics using the deployed application's real ASR
// adapter and durable request ledger. Preparation is offline; sending is opt-in.
// Node's finish/bytesWritten indicate a local socket flush, NOT server receipt.
const args = new Map();
for (const arg of process.argv.slice(2)) {
  const match = /^--(app-root|job|run|seconds|offset)=(.+)$/u.exec(arg);
  if (match && !args.has(match[1])) args.set(match[1], match[2]);
  else if (arg === '--send' && !args.has('send')) args.set('send', true);
  else throw Error('Use --job=UUID --run=ID [--seconds=60 --offset=0 --app-root=PATH --send]');
}
process.umask(0o077);
const appRoot = path.resolve(args.get('app-root') || fileURLToPath(new URL('../../../apps/cantonese-demo/', import.meta.url)));
const moduleAt = name => import(pathToFileURL(path.join(appRoot, name)));
const [{ loadConfig }, { readJson, writeJson, runProcess }, { digestFile }, { recordedAsrRequest }] = await Promise.all([
  moduleAt('config.mjs'), moduleAt('pipeline.mjs'), moduleAt('model-client.mjs'), moduleAt('asr-request.mjs'),
]);
const job = args.get('job'), run = args.get('run');
const seconds = Number(args.get('seconds') || 60), offset = Number(args.get('offset') || 0);
if (!/^[a-f0-9-]{36}$/u.test(job || '') || !/^[A-Za-z0-9_-]{1,64}$/u.test(run || '')) throw Error('Invalid job/run identity');
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120 || !Number.isFinite(offset) || offset < 0) throw Error('Diagnostic clips must be 1–120 seconds with a nonnegative offset');
const data = path.resolve(process.env.CANTONES_DATA_DIR || path.join(appRoot, '.data'));
const original = path.join(data, job, 'audio.flac');
const dir = path.join(data, 'asr-diagnostics', job, run);
await fs.mkdir(dir, { recursive: true });
// A second invocation cannot race the same paid request, including a stale lock
// after a crash. No automatic lock recovery and no retryUnknown option.
const lockFile = path.join(dir, 'running.lock');
const lock = await fs.open(lockFile, 'wx');
let undoTrace = () => {};
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const config = loadConfig(appRoot);
  const sourceHash = await digestFile(original), manifestFile = path.join(dir, 'manifest.json');
  const clip = path.join(dir, 'clip.flac'), manifest = await readJson(manifestFile);
  const plan = { sourceHash, offset, seconds };
  const probe = async file => JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  let prepared;
  if (manifest) {
    if (JSON.stringify(manifest.plan) !== JSON.stringify(plan) || manifest.audioSha256 !== await digestFile(clip)) throw Error('Diagnostic input changed; use a fresh run ID');
    prepared = manifest;
  } else {
    if (await fs.stat(clip).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw Error('Unregistered clip exists; use a fresh run ID');
    const input = await probe(original);
    if (offset + seconds > Number(input.format.duration) + 0.1) throw Error('Clip extends beyond the original audio');
    await runProcess(config.ffmpeg, ['-v', 'error', '-nostdin', '-n', '-ss', String(offset), '-i', original, '-t', String(seconds), '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', clip]);
    const info = await probe(clip), audio = info.streams.find(s => s.codec_type === 'audio'), duration = Number(info.format.duration);
    if (audio?.codec_name !== 'flac' || audio.channels !== 1 || Number(audio.sample_rate) !== 16000 || Math.abs(duration - seconds) > 0.1) throw Error('Diagnostic audio failed validation');
    prepared = { plan, duration, bytes: (await fs.stat(clip)).size, audioSha256: await digestFile(clip), at: new Date().toISOString() };
    await writeJson(manifestFile, prepared);
  }
  await writeJson(path.join(dir, 'status.json'), { status: 'prepared', ...prepared, at: new Date().toISOString() });
  if (!args.has('send')) {
    console.log(JSON.stringify({ status: 'prepared', run, seconds: prepared.duration, bytes: prepared.bytes, externalRequestsMade: 0 }));
  } else {
    if (!config.asr.apiKey) throw Error('ASR credential is not configured');
    const traceFile = path.join(dir, 'transport.jsonl'), started = performance.now();
    let requests = 0, traceFailed = false;
    const emit = (event, details = {}) => {
      try { appendFileSync(traceFile, JSON.stringify({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), event, ...details }) + '\n', { mode: 0o600 }); }
      catch { traceFailed = true; }
    };
    emit('invocation', { timeoutMs: config.asr.timeoutMs, clipBytes: prepared.bytes });
    if (traceFailed) throw Error('Cannot create a durable diagnostic trace');
    const originals = [[http, http.request], [https, https.request]], timers = new Set();
    for (const [client, request] of originals) {
      client.request = function (...requestArgs) {
        const req = request.apply(this, requestArgs); requests++;
        let socket;
        const snapshot = () => ({ requestFinished: req.writableFinished, requestWritableBytes: req.writableLength,
          socketBytesWritten: socket?.bytesWritten ?? null, socketBytesRead: socket?.bytesRead ?? null, socketWritableBytes: socket?.writableLength ?? null });
        emit('request_created');
        req.once('socket', value => {
          socket = value; emit('socket_assigned', { connecting: socket.connecting });
          socket.once('lookup', (error, address, family) => emit('dns', { code: error?.code ?? null, address, family }));
          socket.once('connect', () => emit('tcp_connected', { remoteAddress: socket.remoteAddress }));
          socket.once('secureConnect', () => emit('tls_connected', { authorized: socket.authorized, protocol: socket.getProtocol() }));
        });
        req.once('finish', () => emit('socket_flush_finished', snapshot()));
        req.once('response', res => {
          emit('response_headers', { httpStatus: res.statusCode, ...snapshot() });
          // No data listener: it could consume the ASR adapter's response stream.
          res.once('end', () => emit('response_ended', snapshot()));
        });
        req.once('error', error => emit('request_error', { code: /^[A-Z0-9_]{1,80}$/u.test(String(error.code)) ? error.code : null, ...snapshot() }));
        const timer = setInterval(() => emit('socket_snapshot', snapshot()), 10000); timer.unref(); timers.add(timer);
        req.once('close', () => { clearInterval(timer); timers.delete(timer); emit('request_closed', snapshot()); });
        return req;
      };
    }
    undoTrace = () => { for (const [client, request] of originals) client.request = request; for (const timer of timers) clearInterval(timer); };
    await writeJson(path.join(dir, 'status.json'), { status: 'running', run, seconds: prepared.duration, at: new Date().toISOString() });
    const bytes = await fs.readFile(clip), form = new FormData();
    form.append('file', new Blob([bytes], { type: 'audio/flac' }), 'clip.flac');
    form.append('model', config.asr.model); form.append('response_format', 'verbose_json'); form.append('timestamp_level', 'word');
    const raw = await recordedAsrRequest(dir, 'asr-diagnostic', config.asr, {
      body: form, identity: { model: config.asr.model, language: 'yue', response_format: 'verbose_json', timestamp_level: 'word', offset, duration: prepared.duration, audioSha256: prepared.audioSha256 },
      runtime: { healthDir: path.join(dir, 'provider-health') },
    });
    if (!raw.text?.trim() || !Array.isArray(raw.segments) || !raw.segments.length) throw Error('ASR returned no usable timed transcript; inspect the stored response');
    const summary = { status: 'done', run, seconds: prepared.duration, elapsedMs: Math.round(performance.now() - started), requestsObserved: requests,
      characters: raw.text.length, segments: raw.segments.length, traceFailed, at: new Date().toISOString() };
    await writeJson(path.join(dir, 'status.json'), summary); console.log(JSON.stringify(summary));
  }
} catch (error) {
  const safe = { status: 'error', error: error.message, at: new Date().toISOString() };
  await writeJson(path.join(dir, 'status.json'), safe); console.error(JSON.stringify(safe)); process.exitCode = 1;
} finally {
  undoTrace(); await lock.close(); await fs.unlink(lockFile);
}
