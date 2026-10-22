import { renderSrt, validateRows } from './subtitles.mjs';

const compact = text => String(text).replace(/\s/gu, '');
export function referenceOwnership(rows, refs) {
  const owners = new Map(rows.map(row => [row.id, []]));
  for (const ref of refs) {
    // A start-only reference is a point for display ownership, never a
    // fabricated interval or evidence of exact acoustic alignment.
    const owner = rows.find(row => row.end > ref.start) ?? rows.at(-1);
    if (owner) owners.get(owner.id).push(ref);
  }
  return owners;
}
export function wrapCaption(text, lang) {
  const width = lang === 'en' ? 42 : 24;
  const tokens = String(text).trim().match(/[A-Za-z0-9][A-Za-z0-9&'’.,%+\/-]*|\s+|./gu) ?? [];
  const lines = []; let line = '';
  for (const token of tokens) {
    if (line.trim() && (line + token).trimEnd().length > width) { lines.push(line.trim()); line = ''; }
    line += token;
  }
  if (line.trim()) lines.push(line.trim());
  const result = lines.join('\n');
  if (compact(result) !== compact(text)) throw new Error('字幕排版改变了正文');
  return result;
}
export function layoutIssues(rows, lang) {
  return rows.flatMap(row => {
    const lines = wrapCaption(row[lang] ?? '', lang).split('\n');
    const issues = [];
    if (lines.length > 2 || lines.some(line => line.length > (lang === 'en' ? 42 : 24))) issues.push({ id: row.id, code: `layout-${lang}`, message: `${lang} 需要缩短分段或调整换行（保留内容）`, blocking: true });
    if (row.end - row.start > 8) issues.push({ id: row.id, code: `duration-${lang}`, message: '单条超过8秒，需重新分段或确认时序', blocking: true });
    return issues;
  });
}
export function publicationIssues(project, lang) {
  const all = validateRows(project.rows, project.duration).filter(i => i.blocking && (!i.code.startsWith('empty-') || i.code === `empty-${lang}`));
  all.push(...validateRows(project.rows, project.duration).filter(i => i.code === 'overlap').map(i => ({ ...i, blocking: true })));
  all.push(...layoutIssues(project.rows, lang));
  for (const row of project.rows) {
    if (!row.sourceReviewed || !row.reviewed) all.push({ id: row.id, code: 'unreviewed', message: '需确认粤语与三语终审', blocking: true });
    if (/\[[^\]\r\n]*(?:unclear|unintelligible|听不清|聽不清|未听清|未聽清)[^\]\r\n]*\]/iu.test(row[lang] ?? '')) all.push({ id: row.id, code: 'unclear', message: '存在尚未确认的缺词', blocking: true });
    if (row.semanticIssues?.some(i => ['critical', 'major'].includes(i.severity)) && !row.reviewed) all.push({ id: row.id, code: 'semantic', message: '语义审校问题待确认', blocking: true });
    const speed = String(row[lang] ?? '').replace(/\s/gu, '').length / (row.end - row.start);
    if (speed > (lang === 'en' ? 22 : 12)) all.push({ id: row.id, code: `speed-${lang}`, message: '阅读速度过快，需要调整', blocking: true });
  }
  return all;
}
export function renderDelivery(project, lang, { final = false } = {}) {
  if (final) { const issues = publicationIssues(project, lang); if (issues.length) throw new Error(`暂不能导出正式字幕：${issues[0].message}（${issues[0].id}）`); }
  // Layout never estimates new speech times or silently removes words.
  return renderSrt(project.rows.map(row => ({ ...row, [lang]: wrapCaption(row[lang], lang), stale: final ? row.stale : false })), lang, project.duration);
}
