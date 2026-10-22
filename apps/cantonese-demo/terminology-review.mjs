// Deterministic pre/post checks complement the text model. A model cannot
// silently leave a confirmed error unresolved or override a protected spelling.
const expression = pattern => new RegExp(pattern, 'giu');
const contextExpression = pattern => new RegExp(pattern, 'iu');
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

// Learned facts about a particular chart are not general spelling rules.
// They require the exact video, row and matching local visual evidence.
function activeRules(lexicon, sourceVideoSha256 = '') {
  return [...lexicon.rules, ...(lexicon.documentCorrections ?? [])
    .filter(rule => sourceVideoSha256 && rule.sourceVideoSha256 === sourceVideoSha256)
    .filter(rule => rule.kind !== 'precision' || lexicon.precisionPolicy?.allowEvidenceBackedPrecision)
    .map(rule => ({ ...rule, canonical: rule.to, pattern: rule.fromExamples.map(escapePattern).join('|'),
      context: rule.context ?? '.', mode: 'visual', status: 'confirmed', severity: rule.kind === 'precision' ? 'optional' : 'critical',
      category: 'number', evidencePattern: rule.evidencePattern ?? escapePattern(rule.evidenceText), documentSpecific: true }))];
}

export function scanTerminology(rows, lexicon, { sourceVideoSha256 = '' } = {}) {
  const findings = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const context = rows.slice(Math.max(0, i - 2), i + 3).map(item => item.yue).join(' ');
    const candidates = activeRules(lexicon, sourceVideoSha256).filter(rule => !rule.rowIds || rule.rowIds.includes(row.id))
      .flatMap(rule => [...row.yue.matchAll(expression(rule.pattern))].map(match => ({ rule, match })))
      .sort((a, b) => a.match.index - b.match.index || b.match[0].length - a.match[0].length);
    let end = -1;
    for (const { rule, match } of candidates) {
      if (match.index < end) continue;
      const contextMatches = contextExpression(rule.context).test(rule.contextScope === 'row' || rule.id === 'sp-abbreviation' ? row.yue : context);
      findings.push({ rowId: row.id, start: row.start, end: row.end, ruleId: rule.id, from: match[0], to: rule.canonical,
        index: match.index, contextMatches, severity: rule.severity, mode: rule.mode, status: rule.status });
      end = match.index + match[0].length;
    }
  }
  return findings;
}

export function planScreenshotChecks(rows, lexicon, options = {}) {
  const known = scanTerminology(rows, lexicon, options).filter(item => item.contextMatches);
  const checks = known.map(item => ({ rowId: item.rowId, time: item.start, ruleId: item.ruleId, text: item.from,
    trigger: 'known-error', action: item.mode === 'review' ? 'listen-or-review' : item.mode === 'audio' ? 'required-audio-check' : item.mode === 'visual' ? 'required-frame-check' : 'confirmed-term-correction',
    sampleTimes: ['review', 'audio'].includes(item.mode) ? [] : [-2, 0, 2].map(offset => Math.max(0, Math.round((item.start + offset) * 100) / 100)) }));
  // Correct-looking technical quantities also need evidence. Absence from the
  // error dictionary must not make a term invisible to the review workflow.
  const technical = /(?:\d[\d,.]*|[零〇一二兩两三四五六七八九十百千萬万點点]+)(?:\s*(?:个|個)?percent|[%％]|天(?:平均[线線]|均[线線])|年(?:嘅)?(?:债券|債券|midterm)|点|點|厘|釐)|\b(?:[A-Z]\s*){2,5}\b/gu;
  for (const row of rows) for (const match of row.yue.matchAll(technical)) {
    if (checks.some(check => check.rowId === row.id && check.text.includes(match[0]))) continue;
    checks.push({ rowId: row.id, time: row.start, ruleId: null, text: match[0], trigger: 'technical-term-or-quantity', action: 'frame-check',
      sampleTimes: [-2, 0, 2].map(offset => Math.max(0, Math.round((row.start + offset) * 100) / 100)) });
  }
  return checks;
}

function selectEvidence(finding, rule, ledger, sourceVideoSha256) {
  if (rule.mode === 'audio') return ledger.filter(item => item.sourceVideoSha256 === sourceVideoSha256
    && item.trust === 'machine-audio-reviewed' && item.ruleIds.includes(rule.id) && item.rowIds.includes(finding.rowId)
    && Math.abs(item.time - finding.start) <= 25 && Array.isArray(item.supportingRecognitions)
    && new Set(item.supportingRecognitions.map(result => result.responseId)).size >= 2
    && new Set(item.supportingRecognitions.map(result => result.audioSha256)).size >= 2
    && item.supportingRecognitions.some(result => result.variant === 'normal')
    && item.supportingRecognitions.some(result => result.variant === 'slow')
    && item.supportingRecognitions.every(result => result.audioSha256 && contextExpression(rule.evidencePattern).test(result.text)));
  if (rule.mode !== 'visual') return [];
  return ledger.filter(item => item.sourceVideoSha256 === sourceVideoSha256 && item.trust === 'user-confirmed'
    && item.ruleIds.includes(rule.id) && item.rowIds.includes(finding.rowId)
    && Math.abs(item.time - finding.start) <= 25 && contextExpression(rule.evidencePattern).test(item.observedText));
}

export function applyConfirmedTerminology(rows, lexicon, { evidence = [], sourceVideoSha256 = '' } = {}) {
  const before = scanTerminology(rows, lexicon, { sourceVideoSha256 });
  const rules = activeRules(lexicon, sourceVideoSha256);
  const applied = [], pending = [];
  const corrected = rows.map(row => {
    const replacements = [];
    for (const finding of before.filter(item => item.rowId === row.id)) {
      const rule = rules.find(rule => rule.id === finding.ruleId);
      const proof = selectEvidence(finding, rule, evidence, sourceVideoSha256);
      let reason;
      if (!finding.contextMatches) reason = '不符合该规则的财经语境，保留原词';
      else if (rule.status !== 'confirmed' || rule.mode === 'review') reason = '尚未确认的词，只触发审阅/回听';
      else if (rule.mode === 'visual' && !proof.length) reason = '必须补齐同一对象的同期截图证据';
      else if (rule.mode === 'audio' && !proof.length) reason = '必须复核本句原音；固定表达提示不能代替音频证据';
      if (reason) { pending.push({ ...finding, reason }); continue; }
      const change = { ...finding, lexiconVersion: lexicon.version, category: rule.category,
        reason: proof.length ? rule.mode === 'audio' ? '固定表达命中，原速与慢速音频复识均支持；机器复核非人工听审' : '已确认错误词命中，语境及同期画面均匹配' : '已确认固定术语误写，语境匹配',
        evidenceIds: proof.map(item => item.id), frameIds: [...new Set(proof.flatMap(item => item.frameIds ?? []))] };
      replacements.push(change); applied.push(change);
    }
    let yue = row.yue;
    for (const change of replacements.sort((a, b) => b.index - a.index)) yue = yue.slice(0, change.index) + change.to + yue.slice(change.index + change.from.length);
    return { ...row, yue, terminologyChanges: replacements.sort((a, b) => a.index - b.index) };
  });
  const residual = scanTerminology(corrected, lexicon, { sourceVideoSha256 }).filter(item => item.contextMatches && item.status === 'confirmed' && item.severity === 'critical');
  return { rows: corrected, applied, pending, residual, screenshotChecks: planScreenshotChecks(rows, lexicon, { sourceVideoSha256 }),
    knownTermGate: { passed: residual.length === 0, remaining: residual.length, scope: '只核查词库中的已确认关键误写；不代表全文零错误。' } };
}

export function terminologyReviewInput(rows, lexicon, options = {}) {
  const proposed = applyConfirmedTerminology(rows, lexicon, options);
  return { lexiconVersion: lexicon.version, precisionPolicy: lexicon.precisionPolicy, protectedTerms: lexicon.protectedTerms,
    confirmedCorrections: proposed.applied, mandatoryChecks: proposed.pending.filter(item => item.contextMatches), screenshotChecks: proposed.screenshotChecks,
    instruction: '逐条处理已确认误写的每次出现。已匹配的用户确认词库和截图依据不得遗漏；不确定项列明。既有正确术语不得改错。审定后还会独立扫描残留已知错误。' };
}

export function verifyProtectedTerms(sourceRows, reviewedRows, lexicon) {
  const violations = [];
  for (const source of sourceRows) {
    const reviewed = reviewedRows.find(row => row.id === source.id);
    if (!reviewed) { violations.push({ rowId: source.id, reason: 'missing row' }); continue; }
    for (const term of lexicon.protectedTerms) {
      if (source.yue.includes(term) && !reviewed.yue.includes(term)) violations.push({ rowId: source.id, term, reason: '已正确的术语被改动，需提供独立审阅依据' });
    }
  }
  return violations;
}
