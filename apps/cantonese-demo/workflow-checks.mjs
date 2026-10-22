import { digest } from './model-client.mjs';
import { scanTerminology, planScreenshotChecks } from './terminology-review.mjs';
import { validateRows } from './public/subtitles.mjs';

export const WORKFLOW_VERSION = 'minimax-yue-review-v2.1';
export const sourceHash = rows => digest(rows.map(({ id, start, end, yue }) => ({ id, start, end, yue })));
export function generalLexicon(lexicon) {
  // Source-dependent numeric evidence must never become a global correction.
  return { version: `${lexicon.version}.general`, purpose: lexicon.purpose,
    precisionPolicy: { allowEvidenceBackedPrecision: false, conditions: lexicon.precisionPolicy?.conditions ?? [] },
    protectedTerms: lexicon.protectedTerms,
    rules: lexicon.rules.filter(rule => !rule.documentSpecific && !rule.rowIds).map(({ source: _source, ...rule }) => rule), documentCorrections: [] };
}
export function reviewTriggers(rows, lexicon) {
  const checks = planScreenshotChecks(rows, generalLexicon(lexicon));
  // Discovery is independent of the dictionary. Names and standalone years,
  // prices and periods can be wrong even when they look plausible.
  for (const row of rows) {
    const terms = row.yue.match(/\d[\d,.]*|[A-Za-z][A-Za-z&.-]*(?:\s+[A-Z][A-Za-z.-]*)*/gu) ?? [];
    for (const text of terms) if (!checks.some(c => c.rowId === row.id && c.text === text)) checks.push({ rowId: row.id, time: row.start, text, trigger: 'name-or-number', action: 'frame-check', sampleTimes: [Math.max(0, row.start - 2), row.start, row.start + 2] });
  }
  return checks;
}
export function sourceAudioRisks(rows, proposals, lexicon, duration) {
  const findings=scanTerminology(rows,generalLexicon(lexicon)).filter(f=>f.contextMatches&&['audio','review'].includes(f.mode));
  return rows.flatMap(row=>{
    const p=proposals.find(p=>p.id===row.id),known=findings.filter(f=>f.rowId===row.id);
    const issues=p?.issues??[],numeric=(p?.changes??[]).filter(c=>c.category==='number');
    if(!known.length&&!issues.length&&!numeric.length)return [];
    return [{id:row.id,start:Math.max(0,row.start-6),end:Math.min(duration,row.end+6),
      score:known.length*80+numeric.length*10+issues.reduce((n,i)=>n+(/听|聽|发音|發音|音频|音頻|英文|数字|數字|缩写|縮寫|術語|术语|品牌/u.test(i.reason)?3:1),0),
      reasons:[...known.map(f=>'易错词触发回听：'+f.ruleId+' / '+f.from),...issues.map(i=>i.reason)],
      triggerRuleIds:known.map(f=>f.ruleId),selection:'Source lexicon triggers plus model review; not a confidence estimate'}];
  }).sort((a,b)=>b.score-a.score||a.start-b.start);
}
export function paragraphBatches(rows, { maxRows = 8, maxSeconds = 35 } = {}) {
  const groups = []; let group = [];
  for (const row of rows) {
    const last = group.at(-1);
    if (last && (group.length >= maxRows || row.end - group[0].start > maxSeconds || row.start - last.end > 1.2)) { groups.push(group); group = []; }
    group.push(row);
    if (group.length >= 3 && /[。！？!?]\s*$/u.test(row.yue)) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}
export function validateIdentity(original, rows) {
  if (!Array.isArray(rows) || rows.length !== original.length) throw new Error('源字幕数量不匹配');
  for (let i = 0; i < original.length; i++) if (rows[i].id !== original[i].id || !Number.isFinite(rows[i].start) || !Number.isFinite(rows[i].end)) throw new Error('源字幕ID缺失、重复或顺序变化');
}
export function mergeReview(original, previous, incoming) {
  validateIdentity(original.rows, incoming);
  const before = previous ?? original;
  const rows = incoming.map((row, i) => {
    const old = before.rows[i];
    if (['yue', 'en', 'zh'].some(lang => typeof row[lang] !== 'string' || row[lang].length > 20000)) throw new Error('无效字幕文本');
    const sourceChanged = row.yue !== old.yue || row.start !== old.start || row.end !== old.end;
    return { ...old, start: row.start, end: row.end, yue: row.yue, en: row.en, zh: row.zh,
      sourceReviewed: Boolean(row.sourceReviewed),
      reviewed: sourceChanged ? false : Boolean(row.reviewed),
      stale: Boolean(old.stale || sourceChanged),
      sourceReviewNote: typeof row.sourceReviewNote === 'string' ? row.sourceReviewNote.slice(0, 2000) : old.sourceReviewNote ?? '' };
  });
  // A source edit can change neighbouring pronouns and calculations too.
  const changed = sourceHash(before.rows) !== sourceHash(rows);
  if (changed) for (const row of rows) { row.stale = true; row.reviewed = false; }
  return { ...before, kind: 'reviewed-draft', rows, editedAt: new Date().toISOString(), sourceApproval: changed ? null : before.sourceApproval,
    issues: validateRows(rows, original.duration), wholeFilmAccepted: false };
}
export function assertSourceApproved(project) {
  const invalid = validateRows(project.rows, project.duration).filter(i => i.blocking && ['time', 'bounds', 'order', 'empty-yue'].includes(i.code));
  if (invalid.length) throw new Error(`粤语源稿尚有无效内容：${invalid[0].message}`);
  if (project.rows.some(row => !row.sourceReviewed || /\[unclear\]|\[听不清\]/iu.test(row.yue))) throw new Error('请先逐段核对粤语并勾选“粤语已核对”；未确认的缺词不能进入正式翻译');
  for (const finding of project.residualTerms ?? []) {
    const row = project.rows.find(r => r.id === finding.rowId);
    if (row?.yue.includes(finding.from) && !row.sourceReviewNote?.trim()) throw new Error(`已知关键误写仍待核（${finding.rowId}：${finding.from}）；请修正，或在源稿核对说明中记录保留依据`);
  }
}
export function remainingKnownTerms(rows, lexicon) {
  return scanTerminology(rows, generalLexicon(lexicon)).filter(item => item.contextMatches && item.status === 'confirmed' && item.severity === 'critical');
}
