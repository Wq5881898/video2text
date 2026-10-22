import { createHash } from 'node:crypto';

export const recordFingerprint = record => createHash('sha256').update(JSON.stringify({
  key: record.key, start: record.start, end: record.end, texts: record.texts,
})).digest('hex');

export function makeReferenceRecords(rows, language, parseSeconds) {
  return rows.map((row, index) => ({
    key: `reference-${language}-${String(index + 1).padStart(4, '0')}`, source: `reference-${language}`,
    sequence: index + 1, originalId: null, start: parseSeconds(row.start), end: row.end == null ? null : parseSeconds(row.end),
    texts: { [language]: row.text },
  }));
}

export function makeCandidateRecords(rows) {
  return rows.map((row, index) => ({
    key: `minimax-${row.id}`, source: 'minimax', sequence: index + 1, originalId: row.id,
    start: row.start, end: row.end, texts: { yue: row.yue, en: row.en, zh: row.zh },
  }));
}

function validateRecords(records, duration) {
  const keys = new Set(); const previous = new Map();
  for (const record of records) {
    if (keys.has(record.key)) throw new Error(`Duplicate original ID: ${record.key}`);
    keys.add(record.key);
    if (!Number.isFinite(record.start) || record.start < 0 || record.start >= duration ||
      record.end != null && (!Number.isFinite(record.end) || record.end <= record.start || record.end > duration + 0.05)) throw new Error(`Invalid original time: ${record.key}`);
    if (record.start < (previous.get(record.source) ?? -Infinity)) throw new Error(`Original source order changed: ${record.key}`);
    previous.set(record.source, record.start);
    if (Object.values(record.texts).some(text => typeof text !== 'string')) throw new Error(`Invalid original text: ${record.key}`);
  }
}

export function buildCompleteTimeline(referenceYue, referenceEnglish, candidate, duration) {
  const originals = [...referenceYue, ...referenceEnglish, ...candidate];
  validateRecords(originals, duration);
  if (!referenceYue.length) throw new Error('Cantonese reference is required');
  const anchors = [...new Set(referenceYue.map(record => record.start))];
  const groups = anchors.map((anchor, index) => ({
    id: `timeline-${String(index + 1).padStart(4, '0')}`, index: index + 1,
    start: index ? anchor : 0, end: anchors[index + 1] ?? duration, anchor,
    referenceYue: [], referenceEnglish: [], candidate: [],
  }));
  for (const [source, target] of [[referenceYue, 'referenceYue'], [referenceEnglish, 'referenceEnglish'], [candidate, 'candidate']]) {
    for (let index = 0; index < source.length; index++) {
      const record = source[index];
      const owner = groups.find(group => record.start >= group.start && record.start < group.end);
      if (!owner) throw new Error(`Original record has no timeline position: ${record.key}`);
      // This locator interval is never exported as a reference end time.
      const locatorEnd = record.end ?? source[index + 1]?.start ?? duration;
      for (const group of groups) if (record.start < group.end && locatorEnd > group.start) {
        group[target].push({
          record, primary: group.id === owner.id, primaryGroup: owner.id,
          boundaryContext: record.start < group.start || locatorEnd > group.end,
        });
      }
    }
  }
  return { groups, originals };
}

export function auditTimeline(originals, groups, duration) {
  validateRecords(originals, duration);
  const expected = new Map(originals.map(record => [record.key, record]));
  const occurrences = new Map(originals.map(record => [record.key, []]));
  const unknown = [], changed = [], orderErrors = [], gaps = [], overlaps = [];
  let end = 0;
  for (const group of groups) {
    if (Math.abs(group.start - end) > 0.000001) (group.start > end ? gaps : overlaps).push({ from: end, to: group.start });
    if (group.end <= group.start) orderErrors.push(group.id);
    end = group.end;
    for (const field of ['referenceYue', 'referenceEnglish', 'candidate']) {
      let prior = -Infinity;
      for (const item of group[field]) {
        const original = expected.get(item.record.key);
        if (!original) { unknown.push(item.record.key); continue; }
        if (recordFingerprint(original) !== recordFingerprint(item.record)) changed.push(item.record.key);
        if (item.record.start < prior) orderErrors.push(`${group.id}:${field}`);
        prior = item.record.start;
        occurrences.get(item.record.key).push({ group: group.id, primary: item.primary, boundaryContext: item.boundaryContext });
      }
    }
  }
  if (Math.abs(end - duration) > 0.000001) gaps.push({ from: end, to: duration });
  const ledger = originals.map(record => ({
    key: record.key, source: record.source, sequence: record.sequence, originalId: record.originalId,
    start: record.start, end: record.end, fingerprint: recordFingerprint(record), occurrences: occurrences.get(record.key),
    primaryOccurrences: occurrences.get(record.key).filter(item => item.primary).length,
  }));
  const missing = ledger.filter(item => !item.occurrences.length).map(item => item.key);
  const invalidPrimary = ledger.filter(item => item.primaryOccurrences !== 1).map(item => item.key);
  const sourceCounts = Object.fromEntries([...new Set(originals.map(record => record.source))].map(source => {
    const items = ledger.filter(item => item.source === source);
    return [source, { expected: items.length, displayedUnique: items.filter(item => item.occurrences.length).length,
      primaryRecords: items.reduce((count, item) => count + item.primaryOccurrences, 0),
      contextCopies: items.reduce((count, item) => count + item.occurrences.filter(entry => !entry.primary).length, 0) }];
  }));
  return {
    passed: ![missing, invalidPrimary, unknown, changed, orderErrors, gaps, overlaps].some(items => items.length),
    sourceCounts, missing, invalidPrimary, unknown, changed, orderErrors, gaps, overlaps,
    groups: groups.length, from: groups[0]?.start, to: end, ledger,
    scope: '原始条目与展示内容完整性；不代表语义一一对应、识别准确率或翻译质量通过。参考结束时间始终保持空值。',
  };
}
