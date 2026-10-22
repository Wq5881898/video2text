export const LANGS = ['yue', 'en', 'zh'];
export const LABELS = { yue: '粤语原文', en: 'English', zh: '简体中文' };

export function seconds(value) {
  if (typeof value === 'number') return value;
  const parts = String(value ?? '').trim().replace(',', '.').split(':');
  if (!parts.every(p => /^\d+(?:\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function timestamp(value, separator = ',') {
  if (!Number.isFinite(value) || value < 0) throw new Error('时间必须是非负秒数');
  const ms = Math.round(value * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`;
}

export function validateRows(rows, duration = Infinity) {
  const issues = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const add = (code, message, blocking = false) => issues.push({ id: row.id, code, message, blocking });
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || Math.round(row.end * 1000) <= Math.round(row.start * 1000)) add('time', '起止时间无效', true);
    if (row.end > duration + 0.05) add('bounds', '字幕超出视频时长', true);
    if (i && row.start < rows[i - 1].start) add('order', '字幕时间倒序', true);
    if (i && row.start < rows[i - 1].end - 0.03) add('overlap', '与上一条字幕重叠');
    for (const lang of LANGS) {
      const text = String(row[lang] ?? '').trim();
      if (!text) add(`empty-${lang}`, `${LABELS[lang]}为空`, true);
      else if (text.length / (row.end - row.start) > (lang === 'en' ? 22 : 12)) add(`speed-${lang}`, `${LABELS[lang]}阅读速度偏快`);
    }
    if (row.end - row.start > 8) add('long', '单段超过 8 秒，建议检查断句');
    if (row.confidence != null && row.confidence < 0.7) add('confidence', '原文识别置信度偏低');
    if (row.stale) add('stale', '原文已修改，请核对对应译文', true);
    if (row.note) add('model-note', row.note);
    // Numeric differences are review hints only; written-out numbers and unit conversions may be correct.
    const sourceNumbers = (String(row.yue).match(/\d+(?:[.,]\d+)*/g) || []).sort().join('|');
    for (const lang of ['en', 'zh']) {
      const targetNumbers = (String(row[lang]).match(/\d+(?:[.,]\d+)*/g) || []).sort().join('|');
      if (sourceNumbers !== targetNumbers) add(`numbers-${lang}`, `${LABELS[lang]}数字写法与原文不同，请核对`);
    }
  }
  return issues;
}

export function renderSrt(rows, lang, duration = Infinity) {
  if (!LANGS.includes(lang)) throw new Error('不支持的字幕语言');
  if (!rows.length) throw new Error('没有可导出的字幕');
  const blocking = validateRows(rows, duration).filter(i => i.blocking && (!i.code.startsWith('empty-') || i.code === `empty-${lang}`));
  if (blocking.length) throw new Error(`请先处理：${blocking[0].message}（${blocking[0].id}）`);
  return rows.map((r, i) => `${i + 1}\n${timestamp(r.start)} --> ${timestamp(r.end)}\n${String(r[lang]).trim().replace(/\r/g, '').replace(/\n\s*\n/g, '\n')}\n`).join('\n');
}

export function parseReference(text, filename = '') {
  text = text.replace(/^\uFEFF/, '').replace(/\r/g, '').trim();
  let entries;
  if (/\.json$/i.test(filename) || /^[\[{]/.test(text) && !/^\[\d+:/.test(text)) {
    const data = JSON.parse(text);
    entries = Array.isArray(data) ? data : data.segments || data.rows;
    if (!Array.isArray(entries)) throw new Error('JSON 需包含 start、text 的数组');
  } else if (text.includes('-->')) {
    entries = [];
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const pos = lines.findIndex(line => line.includes('-->'));
      if (pos < 0) continue;
      const match = lines[pos].match(/([\d:.,]+)\s*-->\s*([\d:.,]+)/);
      if (match) entries.push({ start: match[1], end: match[2], text: lines.slice(pos + 1).join('\n') });
    }
  } else {
    entries = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*\[?((?:\d+:)?\d+:\d{2}(?:[.,]\d+)?)\]?\s*(.*)$/);
      if (match) entries.push({ start: match[1], text: match[2] });
      else if (entries.length && line.trim()) entries.at(-1).text += `${entries.at(-1).text ? '\n' : ''}${line}`;
    }
  }
  if (!entries.length) throw new Error('没有找到带时间的字幕，支持 SRT、VTT、JSON 和时间戳 TXT');
  return entries.map((r, i) => {
    const start = seconds(r.start);
    const end = r.end == null ? null : seconds(r.end);
    if (!Number.isFinite(start) || start < 0 || end != null && (!Number.isFinite(end) || end <= start)) throw new Error(`参考字幕第 ${i + 1} 段时间无效`);
    if (typeof r.text !== 'string' || !r.text.trim()) throw new Error(`参考字幕第 ${i + 1} 段没有文本`);
    return { id: `ref-${i + 1}`, start, end, text: r.text.trim() };
  }).sort((a, b) => a.start - b.start);
}

export function matchReference(row, refs) {
  return refs.filter((r, i) => {
    // An inferred end is used only for finding nearby text, never for export or timing scoring.
    const windowEnd = r.end ?? refs[i + 1]?.start ?? Math.max(r.start + 1, row.end);
    return r.start < row.end && windowEnd > row.start;
  });
}

export function filenameStem(filename) {
  return String(filename || 'video').split(/[\\/]/).at(-1).replace(/\.[^.]+$/, '') || 'video';
}

export function normalizeUtterances(raw, duration) {
  const utterances = raw?.result?.transcription?.utterances ?? raw?.transcription?.utterances;
  if (!Array.isArray(utterances) || !utterances.length) throw new Error('Gladia 没有返回可用语音片段');
  return utterances.map((u, i) => {
    const start = Number(u.start), end = Number(u.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.25) throw new Error(`识别片段 ${i + 1} 的时间无效，请查看原始结果`);
    // Keep every segment, including short phrases. Empty recognitions stay visible for review.
    return { id: `s${String(i + 1).padStart(4, '0')}`, start, end, yue: String(u.text || '').trim(), en: '', zh: '', confidence: u.confidence ?? null, speaker: u.speaker ?? null, language: u.language ?? null, reviewed: false, stale: false };
  });
}

export function validateTranslation(content, batch) {
  const clean = String(content).trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  const result = JSON.parse(clean);
  const rows = result.translations;
  if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('翻译片段数量不一致');
  const byId = new Map();
  for (const r of rows) {
    if (byId.has(r.id) || !batch.some(b => b.id === r.id) || typeof r.en !== 'string' || !r.en.trim() || typeof r.zh !== 'string' || !r.zh.trim()) throw new Error('翻译包含重复、缺失或无效片段');
    byId.set(r.id, { en: r.en.trim(), zh: r.zh.trim(), note: String(r.note || '').slice(0, 500) });
  }
  return batch.map(b => ({ ...b, ...byId.get(b.id) }));
}
