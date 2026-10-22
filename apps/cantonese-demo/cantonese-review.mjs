import { joinRecognitionText } from './minimax-asr.mjs';

// Anchors locate paragraph boundaries in the original timed word units. They do
// not repair recognition, infer missing speech, or assign reference end times.
export const compact = value => String(value).replace(/\s+/gu, '');
const anchorText = value => compact(value).replace(/[\p{P}\p{S}]/gu, '').toLowerCase();
const key = unit => `${unit.chunkIndex}:${unit.unitIndex}`;

export function buildYueParagraphs(reference, units, definitions) {
  const flat = [], owners = [];
  for (let i = 0; i < units.length; i++) {
    for (const character of anchorText(units[i].text)) { flat.push(character); owners.push(i); }
  }
  const full = flat.join('');
  const boundaries = definitions.map((definition, i) => {
    if (!i) return 0;
    const needle = anchorText(definition.anchor);
    const matches = [...full.matchAll(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gu'))];
    if (!needle || matches.length !== 1) throw new Error(`Paragraph ${i + 1}: anchor must occur exactly once (${matches.length}): ${definition.anchor}`);
    const index = owners[matches[0].index];
    if (owners[matches[0].index - 1] === index) throw new Error(`Paragraph ${i + 1}: anchor splits an ASR word`);
    return index;
  });
  for (let i = 1; i < boundaries.length; i++) if (boundaries[i] <= boundaries[i - 1]) throw new Error('ASR paragraph order is invalid');
  let nextReference = 1;
  const paragraphs = definitions.map((definition, i) => {
    if (definition.from !== nextReference || definition.to < definition.from) throw new Error('Reference paragraph gap or overlap');
    nextReference = definition.to + 1;
    const rows = reference.slice(definition.from - 1, definition.to).map((row, offset) => ({
      key: `reference-yue-${String(definition.from + offset).padStart(4, '0')}`, ...row,
    }));
    const selected = units.slice(boundaries[i], boundaries[i + 1] ?? units.length);
    if (!rows.length || !selected.length) throw new Error('Empty paragraph');
    return { id: `yue-${String(i + 1).padStart(4, '0')}`, index: i + 1, title: definition.title,
      reference: rows, units: selected, start: selected[0].start, end: Math.max(...selected.map(unit => unit.end)),
      referenceText: rows.map(row => row.text).join(' '), asrText: joinRecognitionText(selected.map(unit => unit.text)),
      note: definition.note };
  });
  if (nextReference !== reference.length + 1) throw new Error('Reference tail was omitted');
  auditYueParagraphs(reference, units, paragraphs);
  return paragraphs;
}

export function auditYueParagraphs(reference, units, paragraphs) {
  const expectedReference = reference.map((row, i) => ({ key: `reference-yue-${String(i + 1).padStart(4, '0')}`, ...row }));
  const actualReference = paragraphs.flatMap(paragraph => paragraph.reference);
  const actualUnits = paragraphs.flatMap(paragraph => paragraph.units);
  if (JSON.stringify(expectedReference) !== JSON.stringify(actualReference)) throw new Error('Missing, repeated, reordered, or changed reference record');
  if (JSON.stringify(units) !== JSON.stringify(actualUnits)) throw new Error('Missing, repeated, reordered, or changed ASR unit');
  if (new Set(actualUnits.map(key)).size !== units.length) throw new Error('Duplicate original ASR unit key');
  for (const paragraph of paragraphs) {
    if (paragraph.referenceText !== paragraph.reference.map(row => row.text).join(' ') || paragraph.asrText !== joinRecognitionText(paragraph.units.map(unit => unit.text))) throw new Error('Paragraph text differs from its original records');
  }
  return { passed: true, paragraphs: paragraphs.length, referenceRecords: actualReference.length, asrUnits: actualUnits.length,
    missing: 0, duplicates: 0, changed: 0, orderPreserved: true,
    scope: '展示完整性；不证明 ASR 识别正确，也不证明参考绝对正确。' };
}

// Quotes are checked against the actual originals, not accepted as free-form
// claims. Only whitespace can differ; no numeral, decimal, or name correction.
export function validateReviewChecks(paragraphs, checks) {
  const ids = new Set();
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`Duplicate check ${check.id}`);
    ids.add(check.id);
    const paragraph = paragraphs[check.paragraph - 1];
    if (!paragraph || !['same', 'different', 'pending', 'reference'].includes(check.status)) throw new Error(`Invalid check ${check.id}`);
    for (const [field, text] of [['reference', paragraph.referenceText], ['asr', paragraph.asrText]]) {
      if (!check[field] || !compact(text).includes(compact(check[field]))) throw new Error(`Check ${check.id}: ${field} quote not in original: ${check[field]}`);
    }
    if (check.status !== 'same' && !check.reason) throw new Error(`Unexplained critical difference ${check.id}`);
  }
  const counts = Object.fromEntries(['same', 'different', 'pending', 'reference'].map(status => [status, checks.filter(check => check.status === status).length]));
  return { items: checks.length, counts, accepted: counts.different === 0 && counts.pending === 0,
    scope: '人工列出的核查项目数量，不是全片准确率；未全量回听，不宣布零错误。' };
}
