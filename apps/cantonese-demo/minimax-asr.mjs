// Utilities for the isolated MiniMax experiment. No reference subtitles are used.
export function joinRecognitionText(parts) {
  return parts.reduce((text, part) => {
    part = String(part ?? '');
    const space = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(part) ? ' ' : '';
    return text + space + part;
  }, '').trim();
}

export function normalizeMiniMaxUnits(payload, offset, chunkDuration, chunkIndex) {
  if (!Array.isArray(payload.segments) || !payload.segments.length) throw new Error('MiniMax did not return timed segments');
  let previous = -Infinity;
  const units = payload.segments.map((segment, index) => {
    const start = Number(segment.start), end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > chunkDuration + 0.25 || start < previous) throw new Error(`Invalid MiniMax alignment at chunk ${chunkIndex}, unit ${index}`);
    previous = start;
    return { chunkIndex, unitIndex: index, start: start + offset, end: end + offset, text: String(segment.text ?? ''), speaker: segment.speaker ?? null };
  });
  const canonical = value => String(value).normalize('NFKC').replace(/\s+/gu, '');
  if (canonical(units.map(u => u.text).join('')) !== canonical(payload.text)) throw new Error('MiniMax text and timed units differ; inspect raw response before export');
  return units;
}

export function captionMiniMaxUnits(units, { maxSeconds = 6, maxCharacters = 42, gapSeconds = 0.55 } = {}) {
  const rows = []; let group = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start, end = Math.max(...group.map(u => u.end));
    if (end <= start) {
      if (!rows.length) return;
      const last = rows.at(-1);
      last.yue = joinRecognitionText([last.yue, ...group.map(u => u.text)]);
      last.sourceUnits.push(...group.map(u => [u.chunkIndex, u.unitIndex]));
      group = []; return;
    }
    rows.push({ id: `s${String(rows.length + 1).padStart(4, '0')}`, start, end,
      yue: joinRecognitionText(group.map(u => u.text)), en: '', zh: '', confidence: null,
      speaker: group[0].speaker, language: 'yue', reviewed: false, stale: false,
      sourceUnits: group.map(u => [u.chunkIndex, u.unitIndex]) });
    group = [];
  };
  for (let i = 0; i < units.length; i++) {
    const unit = units[i]; const last = group.at(-1);
    const groupText = joinRecognitionText(group.map(u => u.text));
    // Keep a spoken amount and its unit together, even if the soft length limit is exceeded.
    const numberTail = /[\d零〇一二兩两三四五六七八九十百千萬万億亿點点.,]$/u.test(groupText);
    const numberNext = /^[\d零〇一二兩两三四五六七八九十百千萬万億亿點点個个厘釐%％]/u.test(unit.text) || /^percent/i.test(unit.text);
    const classifierTail = /[\d零〇一二兩两三四五六七八九十百千萬万億亿](?:個|个)$/u.test(groupText) && /^percent/i.test(unit.text);
    const keepAmount = numberTail && numberNext || classifierTail;
    if (last && (unit.chunkIndex !== last.chunkIndex || unit.start - last.end >= gapSeconds ||
      !keepAmount && (unit.end - group[0].start > maxSeconds || joinRecognitionText([...group.map(u => u.text), unit.text]).length > maxCharacters))) flush();
    group.push(unit);
    const span = unit.end - group[0].start;
    if (/[。！？!?；;]\s*$/u.test(unit.text) && span >= 0.8 || /[，,：:]\s*$/u.test(unit.text) && span >= 2.5) flush();
  }
  flush();
  if (group.length) throw new Error('Unaligned final units cannot be exported');
  const source = units.map(u => u.text).join('').replace(/\s+/gu, '');
  if (rows.map(r => r.yue).join('').replace(/\s+/gu, '') !== source) throw new Error('Caption grouping lost or duplicated recognized text');
  return rows;
}
