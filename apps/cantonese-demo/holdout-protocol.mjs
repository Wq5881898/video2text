import fs from 'node:fs/promises';
import path from 'node:path';
import { digestFile } from './model-client.mjs';
import { readJson, writeJson } from './pipeline.mjs';

export const HOLDOUT_VERSION = 'evidence-holdout-v1';
export const thin = ({ id, start, end, yue }) => ({ id, start, end, yue });

export function assertExactCoverage(expected, actual, label = 'rows') {
  if (!Array.isArray(actual) || actual.length !== expected.length ||
      new Set(actual.map(r => r.id)).size !== expected.length ||
      actual.some((r, i) => r.id !== expected[i].id)) throw Error(`${label}: missing, duplicated or reordered IDs`);
}

export function assertSourceIdentity(expected, actual) {
  assertExactCoverage(expected, actual);
  for (let i = 0; i < expected.length; i++) {
    for (const key of ['start', 'end', 'yue']) {
      if (expected[i][key] !== actual[i][key]) throw Error(`Source changed: ${actual[i].id}/${key}`);
    }
  }
}

export async function seal(dir, basename, value) {
  const file = path.join(dir, `${basename}.json`);
  const previous = await readJson(path.join(dir, `${basename}-seal.json`));
  if (previous) {
    if (await digestFile(file) !== previous.sha256) throw Error(`Existing seal changed: ${basename}`);
    const existing = await readJson(file);
    if (JSON.stringify(existing) !== JSON.stringify(value)) throw Error(`Refusing to replace sealed ${basename}`);
    return previous;
  }
  await writeJson(file, value);
  const record = { version: HOLDOUT_VERSION, at: new Date().toISOString(), sha256: await digestFile(file), rows: value.rows?.length, referenceBodiesUsed: false };
  await writeJson(path.join(dir, `${basename}-seal.json`), record);
  return record;
}

export async function requireSeal(dir, basename) {
  const record = await readJson(path.join(dir, `${basename}-seal.json`));
  if (!record || await digestFile(path.join(dir, `${basename}.json`)) !== record.sha256) throw Error(`Missing or invalid seal: ${basename}`);
  return { record, value: await readJson(path.join(dir, `${basename}.json`)) };
}

// This is the only reference-body reader used by the evaluation CLI. Opaque
// path/size/hash registration is permitted before generation; parsing is gated.
export async function revealReferenceBodies(dir, manifest) {
  await requireSeal(dir, 'source-final');
  await requireSeal(dir, 'minimax-final');
  if (manifest.requireIndependent) await requireSeal(dir, 'independent-final');
  if (['semantic-preservation-v2','semantic-preservation-v3'].includes(manifest.semanticPolicy?.version)) {
    await requireSeal(dir, 'chinese-final');
    for (const variant of ['minimax', ...(manifest.requireIndependent ? ['independent'] : [])]) {
      const audit = await readJson(path.join(dir, `relation-audit-${variant}.json`));
      const input = await requireSeal(dir, variant === 'minimax' ? 'minimax-draft' : 'independent-final');
      if (!audit || audit.inputSha256 !== input.record.sha256) throw Error(`Missing or stale relation audit: ${variant}`);
      const unreviewed=audit.unreviewedIds??[];
      if(unreviewed.length && (audit.coverageComplete!==false || audit.acceptance!==false)) throw Error('Failed review cannot claim acceptance');
      const accounting=[...audit.checkedIds,...unreviewed].sort((a,b)=>input.value.rows.findIndex(r=>r.id===a)-input.value.rows.findIndex(r=>r.id===b));
      assertExactCoverage(input.value.rows, accounting.map(id => ({ id })), 'relation review accounting before reveal');
    }
  }
  const revealFile = path.join(dir, 'reference-reveal.json');
  const files = [];
  for (const reference of manifest.references) {
    if (await digestFile(reference.path) !== reference.sha256) throw Error('Reference changed since intake');
    files.push({ ...reference, body: await fs.readFile(reference.path, 'utf8') });
  }
  if (!await readJson(revealFile)) await writeJson(revealFile, { at: new Date().toISOString(), priorSealsVerified: true, files: files.map(({ body, ...r }) => r) });
  return files;
}

export function validatePlan(payload, rows) {
  if (!Array.isArray(payload?.paragraphs) || !payload.paragraphs.length) throw Error('Missing semantic plan');
  const flattened = payload.paragraphs.flatMap(p => p.sourceIds ?? []).map(id => ({ id }));
  assertExactCoverage(rows, flattened, 'semantic plan');
  if (payload.paragraphs.some(p => typeof p.title !== 'string' || !p.title || !p.sourceIds.length)) throw Error('Invalid paragraph');
  return payload.paragraphs.map((p, i) => ({ id: `g${String(i + 1).padStart(3, '0')}`, title: p.title, sourceIds: p.sourceIds }));
}

export function planTitleIssues(plan, rows) {
  return plan.flatMap(p => {
    const source=p.sourceIds.map(id=>rows.find(r=>r.id===id)?.yue??'').join('').toUpperCase().replace(/\s/gu,'');
    return [...p.title.toUpperCase().matchAll(/\b(?:MACD|CCI|RSI|ADX|MOVE|VIX|AAII|NYSE|NDX|SPX)\b/gu)].filter(m=>!source.includes(m[0])).map(m=>({id:p.id,term:m[0],reason:'Named indicator in generated topic title is not present in its source paragraph; review the heading.'}));
  });
}

// Quotes may cross cue boundaries. Whitespace-only differences and an ID
// attached to the wrong half of a word can be resolved against actual source;
// invented/mutated facts remain quarantined and never count as verified facts.
export function protectSourceFacts(facts, rows) {
  const text = rows.map(r => r.yue).join(' '), chars = [], owners = [];
  let offset = 0;
  for (const row of rows) {
    for (let i = 0; i < row.yue.length; i++) owners[offset + i] = row.id;
    offset += row.yue.length + 1;
  }
  let compact = '';
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) { compact += text[i]; chars.push(i); }
  const verified = [], unverified = [];
  for (const fact of Array.isArray(facts) ? facts : [facts]) {
    const quote = typeof fact?.sourceQuote === 'string' ? fact.sourceQuote.replace(/\s/gu, '') : '';
    const start = quote ? compact.indexOf(quote) : -1;
    if (start < 0 || compact.indexOf(quote, start + 1) >= 0 || !fact?.requirement?.trim()) {
      unverified.push({ providerFact: fact ?? null, reason: 'No unique literal source quote; not treated as verified evidence.' }); continue;
    }
    const first = chars[start], last = chars[start + quote.length - 1];
    const ids = [...new Set(owners.slice(first, last + 1).filter(Boolean))];
    verified.push({ ...fact, ids, sourceQuote: text.slice(first, last + 1), providerIds: fact.ids, providerSourceQuote: fact.sourceQuote });
  }
  return { verified, unverified };
}

export async function workers(items, action, concurrency = 2) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; await action(items[i], i); }
  }));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map(r => r.reason), failed.map(r => r.reason.message).join('; '));
}

export function ownRecordsOnce(groups, records) {
  const owners = groups.map(g => ({ ...g, records: [] }));
  if (records.length && !groups.length) throw Error('comparison ownership: no groups');
  for (const record of records) {
    // Reference/source clocks can differ slightly at a topic boundary. Use
    // the whole cue's overlap, not just its start, without splitting/copying it.
    // A cue wholly in a gap or outside the source span goes to the nearest
    // group. Equal overlaps/distances retain the earlier group.
    let index = 0, bestOverlap = -1, bestDistance = Infinity;
    groups.forEach((group, i) => {
      const overlap = Math.max(0, Math.min(record.end, group.end) - Math.max(record.start, group.start));
      const distance = Math.max(group.start - record.end, record.start - group.end, 0);
      if (overlap > bestOverlap || (overlap === bestOverlap && distance < bestDistance)) {
        index = i; bestOverlap = overlap; bestDistance = distance;
      }
    });
    owners[index].records.push(record);
  }
  assertExactCoverage(records, owners.flatMap(g => g.records), 'comparison ownership');
  return owners;
}
