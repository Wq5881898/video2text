import { renderDelivery, publicationIssues } from './public/subtitle-layout.mjs';
import { filenameStem } from './public/subtitles.mjs';
import { digest } from './model-client.mjs';
import { sourceHash, assertSourceApproved } from './workflow-checks.mjs';

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) { value ^= byte; for (let n = 0; n < 8; n++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
export function zipFiles(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.content), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    // Valid DOS date (1980-01-01); zero month/day can break Windows extractors.
    header.writeUInt16LE(33, 12); record.writeUInt16LE(33, 14);
    local.push(header, name, data); central.push(record, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export function subtitleBundle(project, { final = false } = {}) {
  if (final && project.version === 2) {
    assertSourceApproved(project);
    if (project.translationSourceHash !== sourceHash(project.rows)) throw new Error('正式交付的译文版本与当前粤语不一致，请重新生成');
  }
  const files = [], stem = filenameStem(project.filename), issues = {};
  for (const lang of ['yue', 'en', 'zh']) {
    issues[lang] = publicationIssues(project, lang);
    files.push({ name: `${lang}/${stem}.srt`, content: renderDelivery(project, lang, { final }) });
  }
  const manifest = { kind: final ? 'reviewed-subtitles' : 'draft-subtitles', filename: project.filename, workflowVersion: project.workflowVersion,
    models: project.models, sourceHash: project.sourceHash, translationSourceHash: project.translationSourceHash,
    authorReviewed: final, youtubePlaybackVerified: false, createdAt: new Date().toISOString(), pendingChecks: issues,
    files: files.map(f => ({ name: f.name, sha256: digest(f.content) })) };
  files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) }, { name: 'project.json', content: JSON.stringify(project, null, 2) });
  return { files, bytes: zipFiles(files), manifest };
}
