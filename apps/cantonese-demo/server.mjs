import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { readJson, writeJson, runPipeline, runProcess, recognitionConfig } from './pipeline.mjs';
import { LANGS, validateRows } from './public/subtitles.mjs';
import { loadConfig } from './config.mjs';
import { prepareSource, translateApproved } from './workflow-v2.mjs';
import { WORKFLOW_VERSION, mergeReview, assertSourceApproved, remainingKnownTerms } from './workflow-checks.mjs';
import { subtitleBundle } from './subtitle-bundle.mjs';
import { preflight, inspectServices, validatePreflightConfig, assertServiceAvailability } from './preflight.mjs';
import { providerErrorStatus } from './provider-runtime.mjs';
import { CANTONES_PROFILE, runCantones, sourceQuestions, projectRevision, confirmCantonesSource, saveCantonesEnglish, cantonesDelivery, englishWarnings } from './cantones-workflow.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(ROOT, '.env'), path.join(ROOT, '../web/.env.local'), path.join(ROOT, '../web/.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const DATA = process.env.CANTONES_DATA_DIR || path.join(ROOT, '.data');
const config = loadConfig(ROOT);
const port = Number(process.env.DEMO_PORT || 4178);
const MAX_BYTES = 512 * 1024 * 1024;
const publicOrigin = process.env.CANTONES_PUBLIC_ORIGIN ? new URL(process.env.CANTONES_PUBLIC_ORIGIN).origin : null;
const localOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
const allowedOrigins = publicOrigin ? [publicOrigin, ...localOrigins] : localOrigins;
const allowedHosts = new Set(allowedOrigins.map(origin => new URL(origin).host));
const running = new Set();
const toolsReady = await Promise.all([config.ffmpeg, config.ffprobe].map(c => runProcess(c, ['-version'], 10000).then(() => true, () => false)));

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('请求内容过大'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function jobDir(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('任务编号无效');
  return path.join(DATA, id);
}

async function startJob(id, phase = 'source', options = {}) {
  if (running.size) throw new Error('已有任务正在运行，请等待完成');
  running.add(id);
  const dir = jobDir(id);
  const update = async (stage, message, progress, details = {}) => writeJson(path.join(dir, 'status.json'), { id, stage, message, progress, ...details, updatedAt: new Date().toISOString() });
  let job;
  try {
    job = await readJson(path.join(dir, 'job.json'));
    await writeJson(path.join(dir, 'active-phase.json'), { phase });
    const previous = await readJson(path.join(dir, 'status.json'), {});
    // Publish the new phase before returning 200. Otherwise the first browser
    // poll can see the old completed source-review and stop watching this run.
    await update(job.workflowVersion ? 'preflight' : 'queued',
      job.workflowVersion ? '开始前检查审校／翻译服务连接…' : '正在接续任务…', previous.progress || 3);
  } catch (error) { running.delete(id); throw error; }
  const work = (async () => {
    if (job.workflowVersion) {
      const check = await preflight(config, { source: phase !== 'translation', mediaTools: toolsReady.every(Boolean) });
      await writeJson(path.join(dir, 'preflight-latest.json'), check);
    }
    if (job.profile === CANTONES_PROFILE) return runCantones(dir, config, update, options);
    return job.workflowVersion ? phase === 'translation' ? translateApproved(dir, config, update, options) : prepareSource(dir, config, update, options) : runPipeline(dir, config, update);
  })();
  work.catch(async error => {
    const previous = await readJson(path.join(dir, 'status.json'), {});
    await update('error', error.message, previous.progress || 0, providerErrorStatus(error));
  }).catch(() => console.error('Unable to persist demo job state')).finally(() => running.delete(id));
}

async function serveMedia(req, res, file) {
  const stat = await fs.stat(file);
  const ext = path.extname(file).toLowerCase();
  const type = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' }[ext] || 'application/octet-stream';
  let start = 0, end = stat.size - 1;
  if (req.headers.range) {
    const m = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) { res.writeHead(416); res.end(); return; }
    start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), end) : end;
    if (start > end || start >= stat.size) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return; }
  }
  res.writeHead(req.headers.range ? 206 : 200, { 'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(req.headers.range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}), 'cache-control': 'no-store' });
  await pipeline(createReadStream(file, { start, end }), res);
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']], ['/app.mjs', ['app.mjs', 'text/javascript']],
  ['/subtitles.mjs', ['subtitles.mjs', 'text/javascript']], ['/styles.css', ['styles.css', 'text/css']],
  ['/subtitle-layout.mjs', ['subtitle-layout.mjs', 'text/javascript']],
  ['/cantones', ['cantones.html', 'text/html']], ['/cantones/', ['cantones.html', 'text/html']],
  ['/cantones.mjs', ['cantones.mjs', 'text/javascript']], ['/cantones-i18n.mjs', ['cantones-i18n.mjs', 'text/javascript']],
  ['/cantones.css', ['cantones.css', 'text/css']],
]);
const server = http.createServer(async (req, res) => {
  try {
    // Public mode sits behind the existing authenticated Caddy route. Do not
    // trust arbitrary forwarded headers or expose a second unauthenticated port.
    if (!allowedHosts.has(req.headers.host)) { send(res, 403, { error: 'Host is not allowed' }); return; }
    if (req.method === 'POST' && req.headers.origin && !allowedOrigins.includes(req.headers.origin)) { send(res, 403, { error: 'Origin is not allowed' }); return; }
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (process.env.CANTONES_ONLY === '1' && !/^\/cantones(?:\/|$)/u.test(url.pathname)) { send(res, 404, { error: 'Not found' }); return; }
    // Keep every request below /cantones on the public host; the original
    // /api routes continue to belong to the existing STT worker.
    if (url.pathname.startsWith('/cantones/')) {
      const rest = url.pathname.slice('/cantones'.length);
      if (rest !== '/') url.pathname = rest;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      send(res, 200, { configured: Boolean(config.asr.apiKey && config.translation.apiKey && toolsReady.every(Boolean)), asr: Boolean(config.asr.apiKey), recognitionModel: config.asr.model, workflowVersion: WORKFLOW_VERSION, gladia: Boolean(config.gladiaKey), translation: Boolean(config.translation.apiKey), mediaTools: toolsReady.every(Boolean), translationModel: config.translation.model, services: await inspectServices(config), maxBytes: MAX_BYTES, maxMinutes: 30 }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/preflight') {
      if (running.size) throw new Error('已有任务正在运行，请等待完成');
      const body = await readBody(req);
      send(res, 200, await preflight(config, { source: body.phase !== 'translation', mediaTools: toolsReady.every(Boolean) })); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      await fs.mkdir(DATA, { recursive: true });
      const ids = (await fs.readdir(DATA)).filter(id => /^[a-f0-9-]{36}$/.test(id));
      const jobs = await Promise.all(ids.map(async id => {
        const job = await readJson(path.join(DATA, id, 'job.json'));
        if (!job) return null;
        const status = await readJson(path.join(DATA, id, 'status.json'), { stage: 'error', message: '上传尚未完成' });
        if (url.searchParams.get('profile') === 'cantones' ? job.profile !== CANTONES_PROFILE : job.profile === CANTONES_PROFILE) return null;
        return { id, filename: job.filename, profile: job.profile, createdAt: job.createdAt, ...status, running: running.has(id) };
      }));
      send(res, 200, { jobs: jobs.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20) }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      if (!config.asr.apiKey || !config.translation.apiKey || !toolsReady.every(Boolean)) throw new Error('真实处理尚未配置完成，请查看 demo README；可先体验界面示例');
      if (running.size) throw new Error('已有任务正在运行，请等待完成');
      validatePreflightConfig(config, { mediaTools: toolsReady.every(Boolean) });
      await assertServiceAvailability(config);
      if (req.headers['content-type'] !== 'application/octet-stream') throw new Error('请上传媒体文件');
      const filename = path.basename(decodeURIComponent(String(req.headers['x-filename'] || 'video.mp4'))).slice(0, 180);
      const ext = path.extname(filename).toLowerCase();
      if (!['.mp4', '.mov', '.mkv', '.webm', '.m4a', '.mp3', '.wav', '.aac', '.flac', '.ogg'].includes(ext)) throw new Error('不支持此媒体格式');
      if (Number(req.headers['content-length']) > MAX_BYTES) throw new Error('文件超过 512 MB');
      const mode = String(req.headers['x-recognition-mode'] || 'yue');
      if (mode !== 'yue') throw new Error('新版流程使用明确的粤语识别模式');
      const glossary = Buffer.from(String(req.headers['x-glossary'] || ''), 'base64').toString('utf8');
      if (glossary.length > 2000) throw new Error('术语表超过 2000 字');
      const profile = req.headers['x-workflow-profile'] === 'cantones' ? CANTONES_PROFILE : null;
      if (process.env.CANTONES_ONLY === '1' && !profile) throw new Error('Choose the Cantonese workflow');
      const id = randomUUID(); const dir = jobDir(id);
      // Reserve the single worker while a file is uploading as well.
      running.add(id);
      try {
        await fs.mkdir(dir, { recursive: true });
        let size = 0; const hash = createHash('sha256');
        const limit = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; hash.update(chunk); callback(size > MAX_BYTES ? new Error('文件超过 512 MB') : null, chunk); } });
        await pipeline(req, limit, createWriteStream(path.join(dir, `source${ext}`)));
        if (!size) throw new Error('媒体文件为空');
        await writeJson(path.join(dir, 'job.json'), { id, filename, sourceFile: `source${ext}`, sourceHash: hash.digest('hex'), createdAt: new Date().toISOString(), mode, glossary, workflowVersion: WORKFLOW_VERSION, ...(profile ? { profile } : {}) });
        await writeJson(path.join(dir, 'status.json'), { id, stage: 'queued', message: '文件上传完成', progress: 3 });
      } finally { running.delete(id); }
      await startJob(id);
      send(res, 201, { id }); return;
    }
    const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(result|resume|review|media|frame|translate|export|confirm-source|save-english))?$/);
    if (match) {
      const [, id, action] = match; const dir = jobDir(id);
      const job = await readJson(path.join(dir, 'job.json'));
      if (!job) { send(res, 404, { error: '任务不存在' }); return; }
      if (req.method === 'GET' && !action) { send(res, 200, { ...await readJson(path.join(dir, 'status.json'), {}), filename: job.filename, running: running.has(id) }); return; }
      if (req.method === 'GET' && action === 'result') {
        const original = await readJson(path.join(dir, 'result.json'));
        if (!original) { send(res, 409, { error: '字幕尚未完成' }); return; }
        const review = await readJson(path.join(dir, 'review.json'));
        const project = review || original;
        send(res, 200, { original, review, ...(job.profile === CANTONES_PROFILE ? { revision: projectRevision(project), sourceQuestions: project.sourceDecision ? [] : sourceQuestions(project), englishWarnings: project.kind === 'english-draft' ? englishWarnings(project) : [] } : {}) }); return;
      }
      if (req.method === 'GET' && action === 'media') { await serveMedia(req, res, path.join(dir, job.sourceFile)); return; }
      if (req.method === 'GET' && action === 'frame') {
        const frame = url.searchParams.get('id'); if (!/^f\d{6}$/.test(frame)) throw new Error('截图编号无效');
        const bytes = await fs.readFile(path.join(dir, 'frames', `${frame}.jpg`));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' }); res.end(bytes); return;
      }
      if (req.method === 'GET' && action === 'export') {
        if (running.has(id)) throw new Error('请等待任务处理完成');
        const project = await readJson(path.join(dir, 'review.json'), await readJson(path.join(dir, 'result.json')));
        if (!project) throw new Error('任务尚无可导出的结果');
        if (job.profile === CANTONES_PROFILE) {
          const delivery = cantonesDelivery(project);
          res.writeHead(200, { 'content-type': 'application/x-subrip; charset=utf-8', 'content-disposition': `attachment; filename="subtitles.srt"; filename*=UTF-8''${encodeURIComponent(delivery.filename)}`, 'cache-control': 'no-store' });
          res.end(delivery.content); return;
        }
        const final = url.searchParams.get('final') === 'true', bundle = subtitleBundle(project, { final });
        const target = path.join(dir, 'deliverables', `${final ? 'reviewed' : 'draft'}-${Date.now()}`);
        for (const file of bundle.files) { const output = path.join(target, file.name); await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, file.content, 'utf8'); }
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="subtitles-${final ? 'reviewed' : 'draft'}.zip"`, 'content-length': bundle.bytes.length, 'cache-control': 'no-store' }); res.end(bundle.bytes); return;
      }
      if (req.method === 'POST' && ['confirm-source', 'save-english'].includes(action)) {
        if (job.profile !== CANTONES_PROFILE || running.size) throw Error('This task cannot be edited while a job is running');
        // Reserve the worker across read/validate/write to reject concurrent
        // saves and uploads, including two tabs confirming the same revision.
        running.add(id);
        try {
          const project = await readJson(path.join(dir, 'review.json'), await readJson(path.join(dir, 'result.json')));
          const body = await readBody(req);
          const next = action === 'confirm-source' ? confirmCantonesSource(project, body) : saveCantonesEnglish(project, body);
          await writeJson(path.join(dir, 'revisions', `${Date.now()}-${randomUUID().slice(0, 8)}.json`), next);
          await writeJson(path.join(dir, 'review.json'), next);
        } finally { running.delete(id); }
        if (action === 'confirm-source') await startJob(id, 'translation');
        send(res, 200, { id }); return;
      }
      if (req.method === 'POST' && action === 'translate') {
        if (job.profile === CANTONES_PROFILE) throw Error('Use the Cantonese source confirmation step');
        if (running.size) throw new Error('已有任务正在运行');
        const project = await readJson(path.join(dir, 'review.json'), await readJson(path.join(dir, 'result.json')));
        if (!project || project.version !== 2) throw new Error('需要新版粤语审校任务');
        assertSourceApproved(project);
        await startJob(id, 'translation'); send(res, 200, { id }); return;
      }
      if (req.method === 'POST' && action === 'resume') {
        if (!(job.workflowVersion ? config.asr.apiKey : config.gladiaKey) || !config.translation.apiKey) throw new Error('请先配置识别与翻译服务');
        if (!job.workflowVersion && await readJson(path.join(dir, 'result.json'))) throw new Error('此任务已完成');
        const body = await readBody(req), phase = await readJson(path.join(dir, 'active-phase.json')), status = await readJson(path.join(dir, 'status.json'));
        if (['source-review', 'done'].includes(status?.stage)) throw new Error('当前阶段已完成，请在审阅区确认或重新生成译文');
        await startJob(id, phase?.phase || 'source', { retryUnknown: body.retryUnknown === true }); send(res, 200, { id }); return;
      }
      if (req.method === 'POST' && action === 'review') {
        if (job.profile === CANTONES_PROFILE) throw Error('Use the Cantonese review screen');
        if (running.has(id)) throw new Error('处理期间不能修改源稿');
        const original = await readJson(path.join(dir, 'result.json'));
        if (!original) throw new Error('任务未完成');
        const body = await readBody(req);
        if (!Array.isArray(body.rows) || body.rows.length !== original.rows.length) throw new Error('修订片段数量不匹配');
        const rows = body.rows.map((row, index) => {
          if (row.id !== original.rows[index].id || !Number.isFinite(row.start) || !Number.isFinite(row.end) || LANGS.some(l => typeof row[l] !== 'string' || row[l].length > 20000)) throw new Error('修订内容格式无效');
          return { ...original.rows[index], start: row.start, end: row.end, yue: row.yue, en: row.en, zh: row.zh, reviewed: Boolean(row.reviewed), stale: Boolean(row.stale) };
        });
        const review = original.version === 2 ? mergeReview(original, await readJson(path.join(dir, 'review.json')), body.rows) : { ...original, kind: 'reviewed-draft', editedAt: new Date().toISOString(), rows, issues: validateRows(rows, original.duration) };
        if (original.version === 2) review.residualTerms = remainingKnownTerms(review.rows, await readJson(path.join(dir, 'lexicon-snapshot.json'), await readJson(path.join(ROOT, 'financial-error-lexicon.json'))));
        await writeJson(path.join(dir, 'revisions', `${Date.now()}-${randomUUID().slice(0, 8)}.json`), review);
        await writeJson(path.join(dir, 'review.json'), review);
        send(res, 200, { savedAt: review.editedAt, review }); return;
      }
    }
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, type] = staticFiles.get(url.pathname);
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
      res.end(await fs.readFile(path.join(ROOT, 'public', file))); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    send(res, 404, { error: '路径不存在' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) send(res, error.retryAt ? 503 : 400, { error: error.message, ...providerErrorStatus(error) });
  }
});
server.requestTimeout = 30 * 60000;
server.listen(port, process.env.CANTONES_BIND || '127.0.0.1', () => console.log(`Cantonese demo: http://127.0.0.1:${port}/cantones\nMiniMax ASR: ${config.asr.apiKey ? 'configured' : 'not configured'}; translation: ${config.translation.apiKey ? 'configured' : 'not configured'}`));
