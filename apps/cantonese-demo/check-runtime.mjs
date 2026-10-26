import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.mjs';
import { inspectMediaTools } from './media-tools.mjs';
import { runProcess } from './pipeline.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.join(root, '.env'), path.join(root, '../web/.env.local'), path.join(root, '../web/.env')]) {
  if (existsSync(file)) process.loadEnvFile(file);
}
const args = new Set(process.argv.slice(2));
if ([...args].some(arg => !['--media-only', '--smoke'].includes(arg))) throw Error('Use --media-only and/or --smoke');
const config = loadConfig(root);
const sources = (await fs.readdir(root)).filter(name => name.endsWith('.mjs'));
sources.push('financial-error-lexicon.json', 'translation-context-rules.json', 'semantic-preservation-policy.json');
async function publicFiles(relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative + '/' + entry.name;
    if (entry.isDirectory()) await publicFiles(name); else if (entry.isFile()) sources.push(name);
  }
}
await publicFiles('public');
const fingerprint = createHash('sha256');
for (const name of sources.sort()) {
  const text = (await fs.readFile(path.join(root, name), 'utf8')).replace(/\r\n/gu, '\n').replace(/\n+$/u, '') + '\n';
  fingerprint.update(name + '\0').update(text + '\0');
}
const report = {
  platform: process.platform, node: process.version, externalRequestsMade: 0,
  sourceFingerprint: fingerprint.digest('hex'), sourceFiles: sources.length,
  asrConfigured: Boolean(config.asr.apiKey), translationConfigured: Boolean(config.translation.apiKey),
  recognitionModel: config.asr.model, translationModel: config.translation.model,
  asrTimeoutMs: config.asr.timeoutMs,
  tools: await inspectMediaTools(config), smoke: { status: 'not-run' },
};
report.ok = Object.values(report.tools).every(tool => tool.ready) && (args.has('--media-only') || (report.asrConfigured && report.translationConfigured));
if (args.has('--smoke') && Object.values(report.tools).every(tool => tool.ready)) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'cantones-runtime-'));
  try {
    const video = path.join(folder, 'source.mp4'), audio = path.join(folder, 'audio.flac'), frame = path.join(folder, 'frame.jpg');
    await runProcess(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2', '-f', 'lavfi', '-i', 'sine=frequency=400:duration=2', '-ac', '2', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
    await runProcess(config.ffmpeg, ['-v', 'error', '-y', '-copyts', '-start_at_zero', '-i', video, '-map', '0:a:0', '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-c:a', 'flac', audio]);
    await runProcess(config.ffmpeg, ['-v', 'error', '-y', '-ss', '0.5', '-i', video, '-frames:v', '1', '-vf', 'scale=320:-2', frame]);
    const probe = async file => JSON.parse(await runProcess(config.ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]));
    const source = await probe(video), extracted = await probe(audio), stream = extracted.streams.find(s => s.codec_type === 'audio');
    const drift = Math.abs(Number(source.format.duration) - Number(extracted.format.duration));
    if (stream?.channels !== 1 || Number(stream.sample_rate) !== 16000 || drift > .5 || !(await fs.stat(frame)).size) throw Error('Extracted audio or frame did not pass validation');
    report.smoke = { status: 'passed', channels: stream.channels, sampleRate: Number(stream.sample_rate), durationDriftSeconds: drift, frameProduced: true };
  } catch {
    report.ok = false;
    report.smoke = { status: 'failed', reason: 'synthetic-media-processing-failed' };
  } finally {
    if (path.dirname(path.resolve(folder)) !== path.resolve(os.tmpdir())) throw Error('Refusing cleanup outside the temporary directory');
    await fs.rm(folder, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
