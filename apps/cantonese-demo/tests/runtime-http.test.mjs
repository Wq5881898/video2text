import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runProcess } from '../pipeline.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function stop(child) {
  if (child && child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
}

test('HTTP upload reaches English SRT with real media tools, only a loopback model, and cached resume', { timeout: 45000 }, async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cantones-http-'));
  const calls = [], failures = [];
  let child, broken;
  const mock = http.createServer(async (req, res) => {
    try {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/speech_to_text') {
        assert.equal(req.headers.language, 'yue'); calls.push('asr');
        const multipart = await new Response(Buffer.concat(parts), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const audio = multipart.get('file');
        assert.equal(audio.type, 'audio/mpeg'); assert.equal(audio.name, 'chunk-0.mp3');
        const received = path.join(folder, 'received.mp3');
        await fs.writeFile(received, Buffer.from(await audio.arrayBuffer()));
        const probe = JSON.parse(await runProcess(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', received]));
        assert.equal(probe.streams[0].codec_name, 'mp3');
        assert.equal(probe.streams[0].channels, 1); assert.equal(Number(probe.streams[0].sample_rate), 16000);
        assert.ok(Math.abs(Number(probe.format.duration) - 2) < .25);
        res.end(JSON.stringify({ text: '今日市場上升。', segments: [{ start: .1, end: 1.5, text: '今日市場上升。' }] })); return;
      }
      assert.equal(req.url, '/anthropic/v1/messages');
      const body = JSON.parse(Buffer.concat(parts).toString()), tool = body.tools[0].name;
      const input = JSON.parse(body.messages[0].content[0].text); calls.push(tool);
      let payload;
      if (tool === 'submit_service_check') payload = { ok: true };
      else if (tool === 'submit_inventory') payload = { frames: input.frames.map(f => ({ frameId: f.frameId, title: '', terms: [], unclear: [] })) };
      else if (tool === 'submit_review') {
        assert.ok(input.sourceReviewGuidance.some(g=>g.id==='chart-quantity-scale'));
        payload = { rows: input.targetRows.map(r => ({ id: r.id, changes: [], issues: [] })), visualTerms: [] };
      }
      else if (tool === 'submit_english') payload = { translations: input.targetRows.map(r => ({ id: r.id, en: 'The market rose today.' })), protectedFacts: [], notes: [] };
      else if (tool === 'submit_english_review') payload = { checkedIds: input.targetRows.map(r => r.id), patches: [], issues: [] };
      else if (tool === 'submit_track_audit') {
        assert.equal(input.generalTranslationRules.version,'2026-10-27.general.3');
        assert.ok(input.generalTranslationRules.rules.some(r=>r.id==='retest-conditionality'));
        payload = { checkedIds: input.targetRows.map(r => r.id), issues: [] };
      }
      else throw Error('Unexpected model tool ' + tool);
      res.end(JSON.stringify({ content: [{ type: 'tool_use', name: tool, input: payload }] }));
    } catch (error) { failures.push(error.message); res.statusCode = 500; res.end(JSON.stringify({ error: 'mock validation failed' })); }
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockOrigin = `http://127.0.0.1:${mock.address().port}`;
  const configDir = path.join(folder, 'config'); await fs.mkdir(configDir);
  const baseEnv = { ...process.env, CANTONES_BIND: '127.0.0.1', CANTONES_ONLY: '1', VIDEO2TEXT_CONFIG_DIR: configDir,
    MINIMAX_ASR_API_KEY: 'synthetic-asr-key', TRANSLATION_API_KEY: 'synthetic-text-key',
    MINIMAX_ASR_ENDPOINT: mockOrigin + '/speech_to_text', TRANSLATION_BASE_URL: mockOrigin + '/v1',
    MINIMAX_ASR_MODEL: 'asr-1.0', MINIMAX_ASR_TIMEOUT_MS: '480000', TRANSLATION_MODEL: 'MiniMax-M3' };
  async function start(extra = {}) {
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const proc = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, env: { ...baseEnv, DEMO_PORT: String(port), CANTONES_PUBLIC_ORIGIN: origin, CANTONES_DATA_DIR: path.join(folder, 'jobs-' + port), ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; proc.stderr.on('data', bytes => { errors = (errors + bytes).slice(-4000); });
    try {
      for (let i = 0; i < 100; i++) {
        if (proc.exitCode !== null) throw Error('Server exited: ' + errors);
        try { const r = await fetch(origin + '/cantones/api/config'); if (r.ok) return { proc, origin, data: path.join(folder, 'jobs-' + port), config: await r.json() }; } catch {}
        await pause(50);
      }
      throw Error('Local server did not start: ' + errors);
    } catch (error) { await stop(proc); throw error; }
  }
  try {
    const app = await start(); child = app.proc;
    assert.equal(app.config.configured, true); assert.equal(app.config.mediaTools, true);
    assert.deepEqual(app.config.mediaStatus.ffprobe, { ready: true, reason: null });
    const video = path.join(folder, 'source.mp4');
    await runProcess(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
    const upload = await fetch(app.origin + '/cantones/api/jobs', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': 'Synthetic.mp4', 'x-recognition-mode': 'yue', 'x-workflow-profile': 'cantones' }, body: await fs.readFile(video) });
    assert.equal(upload.status, 201); const { id } = await upload.json();
    async function complete() {
      for (let i = 0; i < 300; i++) {
        const state = await (await fetch(app.origin + '/cantones/api/jobs/' + id)).json();
        assert.notEqual(state.stage, 'error', state.message + ' ' + failures.join(' '));
        if (!state.running) assert.notEqual(state.stage, 'source-review', 'Synthetic clear speech unexpectedly required review');
        if (state.stage === 'done' && !state.running) return;
        await pause(50);
      }
      assert.fail('Synthetic job did not finish');
    }
    await complete();
    const download = await fetch(app.origin + '/cantones/api/jobs/' + id + '/export');
    assert.equal(download.status, 200); const srt = await download.text();
    assert.match(srt, /The market rose today\./); assert.match(srt, /00:00:00,100 --> 00:00:01,500/);
    const asrIntent = JSON.parse(await fs.readFile(path.join(app.data, id, 'requests/asr-0-0-intent.json'), 'utf8'));
    assert.equal(asrIntent.timeoutMs, 480000);
    const checkpoint = JSON.parse(await fs.readFile(path.join(app.data, id, 'workflow-checkpoint.json'), 'utf8'));
    assert.equal(checkpoint.media.asrUpload, 'mp3-64k-mono16k-v1');
    const sourceRules=JSON.parse(await fs.readFile(path.join(app.data,id,'lexicon-snapshot.json'),'utf8'));
    const translationRules=JSON.parse(await fs.readFile(path.join(app.data,id,'cantones-rules-snapshot.json'),'utf8'));
    assert.equal(sourceRules.version,'2026-10-27.1.general');
    assert.ok(sourceRules.reviewGuidance.some(g=>g.id==='chart-quantity-scale'));
    assert.equal(translationRules.rules.version,'2026-10-27.general.3');
    const before = calls.length;
    const finished = await fetch(app.origin + '/cantones/api/jobs/' + id + '/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(finished.status, 400); assert.equal(calls.length, before);
    // Recreate a persisted interrupted status after successful requests; resume
    // must use the existing checkpoints rather than resubmit model work.
    await fs.writeFile(path.join(app.data, id, 'status.json'), JSON.stringify({ id, stage: 'error', message: 'simulated status interruption', progress: 99 }));
    const resume = await fetch(app.origin + '/cantones/api/jobs/' + id + '/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(resume.status, 200); await complete(); assert.equal(calls.length, before);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.data,id,'lexicon-snapshot.json'),'utf8')),sourceRules);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(app.data,id,'cantones-rules-snapshot.json'),'utf8')),translationRules);
    assert.equal(calls.filter(x => x === 'asr').length, 1); assert.deepEqual(failures, []);
    const failed = await start({ FFPROBE_PATH: path.join(folder, 'missing-ffprobe') }); broken = failed.proc;
    assert.equal(failed.config.asr, true); assert.equal(failed.config.translation, true);
    assert.equal(failed.config.configured, false); assert.equal(failed.config.mediaStatus.ffprobe.reason, 'not-found');
    assert.ok(!JSON.stringify(failed.config).includes(folder));
  } finally {
    await stop(child); await stop(broken); await new Promise(resolve => mock.close(resolve));
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir())) throw Error('Refusing cleanup outside the temporary directory');
    await fs.rm(folder, { recursive: true, force: true });
  }
});
