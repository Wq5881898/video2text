import { LANGS, LABELS, seconds, timestamp, validateRows, renderSrt, parseReference, matchReference, filenameStem } from './subtitles.mjs';
import { renderDelivery, publicationIssues, layoutIssues, referenceOwnership } from './subtitle-layout.mjs';

const $ = id => document.getElementById(id);
const state = { file: null, objectUrl: null, config: null, jobId: null, original: null, project: null, editLang: 'en', rows: [], refs: {}, lang: 'yue', refLang: 'yue', filter: 'all', query: '', active: null, example: false, dirty: false, busy: false, timer: null, pollEpoch: 0 };
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let cooldownTimer = null;
let serviceRetryAt = 0;
function showCooldown(retryAt) {
  clearInterval(cooldownTimer);
  serviceRetryAt = Date.parse(retryAt ?? '') || 0;
  const resume = $('resume');
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((Date.parse(retryAt ?? '') - Date.now()) / 1000)) || 0;
    resume.disabled = seconds > 0;
    resume.textContent = seconds ? '服务冷却中 · ' + seconds + ' 秒' : '继续此任务';
    updateGenerate();
    $('check-service').disabled = state.busy || seconds > 0;
    if (!seconds) clearInterval(cooldownTimer);
  };
  tick();
  if (Date.parse(retryAt ?? '') > Date.now()) cooldownTimer = setInterval(tick, 1000);
}
async function checkServices(phase = 'source') {
  $('service-status').textContent = '正在检查审校／翻译连接…';
  try {
    const result = await api('/api/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phase }) });
    $('service-status').textContent = result.message + (result.cached ? '（复用五分钟内的检查）' : '');
    return result;
  } catch (error) {
    $('service-status').textContent = error.message;
    if (error.retryAt) showCooldown(error.retryAt);
    throw error;
  }
}

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function notice(message, success = false) {
  $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('success', success);
}
async function api(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error || `请求失败 ${response.status}`), { retryAt: body.retryAt, errorCode: body.errorCode });
  return body;
}
function updateGenerate() { $('generate').disabled = state.busy || !state.file || !state.config?.configured || serviceRetryAt > Date.now(); }
function setBusy(busy) {
  state.busy = busy; updateGenerate();
  for (const id of ['media-input', 'example', 'recognition-mode', 'glossary', 'history', 'check-service']) $(id).disabled = busy;
  $('check-service').disabled = busy || serviceRetryAt > Date.now();
  $('translate').disabled = busy || !state.rows.length || state.rows.some(row => !row.sourceReviewed); $('save').disabled = busy || !state.dirty;
  $('export-bundle').disabled = busy || !state.jobId || !state.rows.length;
  document.querySelectorAll('#subtitle-list input, #subtitle-list textarea').forEach(el => { el.disabled = busy; });
}
function duration() { return state.original?.duration ?? Infinity; }
function currentIssues() {
  const issues = validateRows(state.rows, duration());
  const waitingForSource = state.original?.version === 2 && !state.rows.some(r => r.en || r.zh);
  if (waitingForSource) for (let i = issues.length - 1; i >= 0; i--) if (/^(?:empty|numbers)-(?:en|zh)$/.test(issues[i].code)) issues.splice(i, 1);
  if (state.original?.version === 2) for (const row of state.rows) {
    if (!row.sourceReviewed) for (const item of row.sourceIssues ?? []) issues.push({ id: row.id, code: 'source-review', message: `源稿：${item.reason}` });
    if (!row.reviewed) for (const item of row.semanticIssues ?? []) issues.push({ id: row.id, code: 'semantic-review', blocking: ['critical', 'major'].includes(item.severity), message: `${item.lang}：${item.reason}（${item.quote}）` });
  }
  if (state.original?.version === 2) issues.push(...layoutIssues(state.rows, state.editLang));
  return issues;
}
function updateSummary() {
  const issues = currentIssues();
  $('count-total').textContent = state.rows.length || '—';
  $('count-review').textContent = state.rows.length ? state.rows.filter(r => r.reviewed && !r.stale).length : '—';
  $('count-issues').textContent = state.rows.length ? new Set(issues.map(i => i.id)).size : '—';
  $('save').disabled = !state.rows.length || !state.dirty;
  document.querySelectorAll('[data-export]').forEach(button => { button.disabled = !state.rows.length; });
  $('export-json').disabled = !state.rows.length;
  $('export-bundle').disabled = state.busy || !state.jobId || !state.rows.length;
  const v2 = state.original?.version === 2;
  $('workflow-controls').hidden = !v2;
  $('source-status').textContent = v2 ? `粤语已核对 ${state.rows.filter(r => r.sourceReviewed).length}/${state.rows.length}。源文修改后，两份译文都需更新。截图与机器审校提示请结合原音确认。` : '';
  $('translate').disabled = state.busy || state.rows.some(r => !r.sourceReviewed);
  $('translate').textContent = state.rows.some(r => r.stale) ? '基于修订粤语重新生成英文／简中' : '确认粤语并生成英文／简中';
  $('export-note').textContent = state.rows.length ? `${state.rows.filter(r => !r.reviewed || r.stale).length} 段尚未审核。各语言均下载为 ${filenameStem(state.original?.filename)}.srt，请分别存放。` : '每种语言独立下载，保留原视频同名文件。';
}
function rowIssues(row) {
  return currentIssues().filter(i => i.id === row.id).map(i => `<span class="issue ${i.blocking ? 'blocking' : ''}">${escape(i.message)}</span>`).join('');
}
function evidenceMarkup(row) {
  if (state.original?.version !== 2) return '';
  const changes = [...(row.terminologyChanges ?? []), ...(row.changes ?? [])];
  return `<details class="evidence"><summary>核查依据 · ${row.triggers?.length ?? 0} 项触发 · ${changes.length} 处修订</summary><p>触发：${(row.triggers ?? []).map(t => escape(t.text)).join('、') || '一般原文核查'}</p>${changes.map(c => `<p>${escape(c.from)} → ${escape(c.to)}：${escape(c.reason)}</p>`).join('')}${(row.sourceIssues ?? []).map(i => `<p>${escape(i.text)}：${escape(i.reason)} ${escape(i.suggestion ?? '')}</p>`).join('')}<label>源稿核对说明（已知关键误写若保留，需说明依据）<textarea data-field="sourceReviewNote" aria-label="${escape(row.id)} 源稿核对说明">${escape(row.sourceReviewNote ?? '')}</textarea></label><div class="frame-list">${(row.frameIds ?? []).map(id => `<a target="_blank" rel="noopener" href="/api/jobs/${encodeURIComponent(state.jobId)}/frame?id=${id}"><img loading="lazy" src="/api/jobs/${encodeURIComponent(state.jobId)}/frame?id=${id}" alt="${id} 同期截图"><span>${id}</span></a>`).join('')}</div></details>`;
}
function referenceMarkup(row) {
  const refs = state.refs[state.refLang];
  if (!refs?.length) return '';
  if (state.original?.version === 2) {
    const owned = referenceOwnership(state.rows, refs).get(row.id) ?? [];
    if (!owned.length) return '';
    return `<div class="ref-text"><b>${escape(LABELS[state.refLang])}参考 · 按起点展示，每条全文只出现一次${owned.some(r => r.end == null) ? ' · 无结束时间，不作精确时序评分' : ''}</b>${owned.map(r => `${timestamp(r.start, '.')}  ${escape(r.text)}`).join('\n')}</div>`;
  }
  const matched = matchReference(row, refs);
  return `<div class="ref-text"><b>${escape(LABELS[state.refLang])}参考 · ${matched.some(r => r.end == null) ? '近似时间匹配，无结束时间' : '按时间区间匹配'}</b>${matched.length ? matched.map(r => `${timestamp(r.start, '.')}  ${escape(r.text)}`).join('\n') : '此区间没有匹配到参考文本'}</div>`;
}
function renderRows() {
  const issues = currentIssues(); const issueIds = new Set(issues.map(i => i.id));
  const query = state.query.toLocaleLowerCase();
  const rows = state.rows.filter(row => (state.filter !== 'issues' || issueIds.has(row.id)) && (state.filter !== 'unreviewed' || !row.reviewed || row.stale) && (!query || LANGS.some(l => row[l].toLocaleLowerCase().includes(query))));
  $('editor-empty').hidden = Boolean(state.rows.length);
  $('example-banner').hidden = !state.example;
  $('subtitle-list').innerHTML = rows.map(row => `<article class="subtitle-row ${row.id === state.active ? 'active' : ''}" data-id="${escape(row.id)}">
    <div class="row-top"><span class="row-id">${escape(row.id)}</span><button class="seek" data-seek="${escape(row.id)}" aria-label="回听 ${escape(row.id)}">▶ 回听</button><input class="time-input" data-field="start" value="${timestamp(row.start, '.')}" aria-label="${escape(row.id)} 开始时间"><span class="time-dash">→</span><input class="time-input" data-field="end" value="${timestamp(row.end, '.')}" aria-label="${escape(row.id)} 结束时间">${state.original?.version === 2 ? `<label class="review-check"><input type="checkbox" data-field="sourceReviewed" ${row.sourceReviewed ? 'checked' : ''}>粤语已核对</label>` : ''}<label class="review-check"><input type="checkbox" data-field="reviewed" ${row.reviewed && !row.stale ? 'checked' : ''}>已核对三语</label></div>
    <div class="row-columns ${state.original?.version === 2 ? 'two-columns' : ''}">${(state.original?.version === 2 ? ['yue', ...(state.rows.some(r => r.en || r.zh) ? [state.editLang] : [])] : LANGS).map(lang => `<label><span>${escape(LABELS[lang])}</span><textarea data-field="${lang}" aria-label="${escape(row.id)} ${escape(LABELS[lang])}">${escape(row[lang])}</textarea></label>`).join('')}</div>
    <div class="row-issues">${rowIssues(row)}</div>${evidenceMarkup(row)}${referenceMarkup(row)}</article>`).join('') || (state.rows.length ? '<div class="empty-filter">没有符合筛选条件的字幕。</div>' : '');
  updateSummary();
}
function setCaption(row) {
  $('caption').textContent = row?.[state.lang] || '';
  $('caption').hidden = !row?.[state.lang];
  state.active = row?.id ?? null;
  document.querySelectorAll('.subtitle-row').forEach(el => el.classList.toggle('active', el.dataset.id === state.active));
}
function clock(value) { return Number.isFinite(value) ? timestamp(value, '.').slice(3, 8) : '--:--'; }
function updatePlayback() {
  const video = $('video');
  $('preview-time').textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
  setCaption(state.rows.find(row => row.start <= video.currentTime && row.end > video.currentTime));
}
function releaseLocalMedia() {
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
  $('video').pause(); $('video').removeAttribute('src'); $('video').load(); $('video').hidden = true; $('empty-video').hidden = false;
}
function resetResult() {
  state.pollEpoch++; clearTimeout(state.timer); state.jobId = null; state.original = null; state.project = null; state.rows = []; state.refs = {}; updateReferenceInfo(); state.example = false; state.dirty = false; state.active = null;
  $('progress-box').hidden = true; $('caption').hidden = true; $('resume').hidden = true;
  history.replaceState(null, '', location.pathname); renderRows();
}
function selectFile(file) {
  if (state.busy) return;
  if (state.dirty) { toast('请先保存修订或导出项目 JSON，再切换素材'); return; }
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) { toast('文件超过 512 MB'); return; }
  if (!/\.(mp4|mov|mkv|webm|m4a|mp3|wav|aac|flac|ogg)$/i.test(file.name)) { toast('请选择支持的视频或音频文件'); return; }
  resetResult(); releaseLocalMedia(); state.file = file;
  $('file-name').textContent = file.name; $('file-meta').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 点击可更换`;
  state.objectUrl = URL.createObjectURL(file); $('video').src = state.objectUrl; $('video').hidden = false; $('empty-video').hidden = true;
  $('preview-label').textContent = file.name; notice(''); updateGenerate();
}

function loadResult(original, review = null) {
  state.original = original; state.project = review || original; state.rows = structuredClone(state.project.rows); state.example = original.kind === 'interface-example'; state.dirty = false;
  $('preview-label').textContent = `${state.example ? '界面示例 · ' : ''}${original.filename}`;
  renderRows();
}

async function refreshHistory() {
  try {
    const { jobs } = await api('/api/jobs');
    $('history').innerHTML = '<option value="">选择历史任务…</option>' + jobs.map(job => `<option value="${escape(job.id)}">${escape(job.filename)} · ${job.stage === 'done' ? '待三语终审' : job.stage === 'source-review' ? '待确认粤语' : job.running ? '处理中' : '可继续'}</option>`).join('');
    $('history').value = state.jobId || '';
  } catch { /* Configuration message already explains unavailable backend. */ }
}
async function pollJob(id, epoch) {
  try {
    const status = await api(`/api/jobs/${id}`);
    if (epoch !== state.pollEpoch) return;
    $('progress-box').hidden = false; $('progress').value = status.progress || 0;
    $('progress-value').textContent = `${status.progress || 0}%`; $('stage-text').textContent = status.message;
    if (status.stage === 'done' || status.stage === 'source-review') {
      const result = await api(`/api/jobs/${id}/result`);
      if (epoch !== state.pollEpoch) return;
      loadResult(result.original, result.review); setBusy(false); $('resume').hidden = true;
      $('retry-unknown-box').hidden = true;
      if (status.stage === 'source-review') { notice('请先逐段确认粤语，展开核查依据查看同期截图；全部确认后生成英文和简中。'); await refreshHistory(); return; }
      const lowConfidence = result.original.rows.filter(r => r.confidence != null && r.confidence < 0.7).length;
      const shortSegments = result.original.rows.filter(r => r.end - r.start < 1).length;
      const needsSourceReview = lowConfidence > result.original.rows.length / 4;
      notice(needsSourceReview
        ? `实验初稿已生成，源稿需重点核查：${lowConfidence} 段识别置信度低于 0.7，${shortSegments} 段短于 1 秒。请先确认是否保留粤语口语，以及数字、术语和方向含义；当前结果尚未达到人工字幕验收。置信度不是准确率。`
        : '三语初稿已生成。请重点核对粤语口语、数字、专名和预测语气。', !needsSourceReview);
      await refreshHistory(); return;
    }
    if (status.stage === 'error' || !status.running) {
      setBusy(false); $('resume').hidden = false; showCooldown(status.retryAt); $('retry-unknown-box').hidden = !status.message?.includes('未知'); notice(status.stage === 'error' ? status.message : '任务已暂停。点击继续即可接续已保存的步骤。'); await refreshHistory(); return;
    }
    setBusy(true); state.timer = setTimeout(() => pollJob(id, epoch), 2500);
  } catch (error) {
    if (epoch !== state.pollEpoch) return;
    setBusy(false); $('resume').hidden = false; notice(`无法读取任务：${error.message}。任务可能仍在后台执行，可重新打开此页面。`);
  }
}
async function openJob(id) {
  if (state.dirty) { toast('请先保存修订或导出项目 JSON'); return; }
  resetResult(); releaseLocalMedia(); state.file = null; state.jobId = id;
  $('file-name').textContent = '历史任务'; $('file-meta').textContent = '原文件已保存在 demo 中';
  $('video').src = `/api/jobs/${id}/media`; $('video').hidden = false; $('empty-video').hidden = true;
  history.replaceState(null, '', `?job=${encodeURIComponent(id)}`); await pollJob(id, state.pollEpoch);
}

$('media-input').addEventListener('change', event => selectFile(event.target.files[0]));
$('dropzone').addEventListener('keydown', event => { if (event.target === $('dropzone') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); $('media-input').click(); } });
for (const type of ['dragover', 'dragenter']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.add('drag'); });
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, event => { event.preventDefault(); $('dropzone').classList.remove('drag'); });
$('dropzone').addEventListener('drop', event => selectFile(event.dataTransfer.files[0]));
$('video').addEventListener('timeupdate', updatePlayback);
$('video').addEventListener('loadedmetadata', updatePlayback);
$('video').addEventListener('error', () => { notice('浏览器无法预览此媒体格式，仍可提交识别。预览建议使用 MP4 / H.264。'); });

$('generate').addEventListener('click', async () => {
  if (!state.file || state.busy) return;
  if (state.dirty) { toast('请先保存修订'); return; }
  resetResult(); setBusy(true); notice('先在本机提取音轨，由 MiniMax 识别和审校；粤语确认后再翻译。');
  $('progress-box').hidden = false; $('stage-text').textContent = '正在检查服务连接…';
  try {
    await checkServices();
    $('stage-text').textContent = '正在上传原文件到本地 demo…';
    const job = await api('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(state.file.name), 'x-recognition-mode': $('recognition-mode').value, 'x-glossary': btoa(String.fromCharCode(...new TextEncoder().encode($('glossary').value))) }, body: state.file });
    state.jobId = job.id; history.replaceState(null, '', `?job=${job.id}`); await refreshHistory(); await pollJob(job.id, state.pollEpoch);
  } catch (error) { setBusy(false); notice(error.message); }
});
$('resume').addEventListener('click', async () => {
  if (!state.jobId) return;
  try { setBusy(true); $('resume').hidden = true; await api(`/api/jobs/${state.jobId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retryUnknown: $('retry-unknown').checked }) }); $('retry-unknown').checked = false; await pollJob(state.jobId, state.pollEpoch); }
  catch (error) { setBusy(false); $('resume').hidden = false; showCooldown(error.retryAt); notice(error.message); }
});
$('check-service').addEventListener('click', async () => {
  if (state.busy) return;
  setBusy(true);
  try { await checkServices(); } catch (error) { notice(error.message); }
  finally { setBusy(false); }
});
$('history').addEventListener('change', event => { if (event.target.value) openJob(event.target.value); });

document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => {
  state.lang = button.dataset.lang; document.querySelectorAll('[data-lang]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  setCaption(state.rows.find(r => r.id === state.active));
}));
document.querySelectorAll('[data-editlang]').forEach(button => button.addEventListener('click', () => {
  state.editLang = button.dataset.editlang; document.querySelectorAll('[data-editlang]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderRows();
}));
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); renderRows();
}));
$('search').addEventListener('input', event => { state.query = event.target.value; renderRows(); });

$('subtitle-list').addEventListener('click', event => {
  const button = event.target.closest('[data-seek]'); if (!button) return;
  const row = state.rows.find(r => r.id === button.dataset.seek); if (!row) return;
  setCaption(row);
  if ($('video').getAttribute('src')) { $('video').currentTime = row.start; $('video').play().catch(() => {}); }
  else { $('preview-time').textContent = `${clock(row.start)} / ${clock(duration())}`; toast('当前是界面示例，没有关联原视频'); }
});
$('subtitle-list').addEventListener('input', event => {
  const field = event.target.dataset.field; if (!LANGS.includes(field) && field !== 'sourceReviewNote') return;
  const article = event.target.closest('[data-id]'); const row = state.rows.find(r => r.id === article.dataset.id);
  if (field === 'sourceReviewNote') { row.sourceReviewNote = event.target.value; state.dirty = true; updateSummary(); return; }
  row[field] = event.target.value; row.reviewed = false; if (field === 'yue') { row.sourceReviewed = false; for (const r of state.rows) { r.stale = true; r.reviewed = false; } const sourceCheck = article.querySelector('[data-field=sourceReviewed]'); if (sourceCheck) sourceCheck.checked = false; }
  state.dirty = true; article.querySelector('[data-field=reviewed]').checked = false;
  article.querySelector('.row-issues').innerHTML = rowIssues(row); updateSummary();
  if (row.id === state.active) setCaption(row);
});
$('subtitle-list').addEventListener('change', event => {
  const field = event.target.dataset.field; if (!['start', 'end', 'reviewed', 'sourceReviewed'].includes(field)) return;
  const article = event.target.closest('[data-id]'); const row = state.rows.find(r => r.id === article.dataset.id);
  if (field === 'sourceReviewed') row.sourceReviewed = event.target.checked;
  else if (field === 'reviewed') { if (state.original?.version === 2 && (row.stale || !row.en || !row.zh)) { event.target.checked = false; toast('请先基于当前粤语生成两份译文'); return; } row.reviewed = event.target.checked; if (row.reviewed && state.original?.version !== 2) row.stale = false; }
  else {
    const value = seconds(event.target.value);
    if (!Number.isFinite(value) || value < 0) { toast('请输入有效时间，例如 00:01:23.500'); event.target.value = timestamp(row[field], '.'); return; }
    row[field] = value; row.reviewed = false; if (state.original?.version === 2) { row.sourceReviewed = false; for (const r of state.rows) { r.stale = true; r.reviewed = false; } }
  }
  state.dirty = true; renderRows();
});

function updateReferenceInfo() {
  const refs = state.refs[state.refLang] || [];
  $('clear-reference').hidden = !refs.length;
  $('reference-info').textContent = refs.length ? `已载入 ${refs.length} 段${LABELS[state.refLang]}参考。${refs.some(r => r.end == null) ? '缺少结束时间：仅用于内容和近似时间匹配，不生成精确时序评分。' : '含起止时间，可逐段对照；等义表达需人工判断。'}` : '支持 SRT、VTT、JSON、TXT。只有开始时间的参考，不能用于精确时序评分。';
}
$('reference-language').addEventListener('change', event => { state.refLang = event.target.value; updateReferenceInfo(); renderRows(); });
$('reference-input').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 4 * 1024 * 1024) throw new Error('参考文件超过 4 MB');
    state.refs[state.refLang] = parseReference(await file.text(), file.name);
    updateReferenceInfo(); renderRows(); toast('参考已载入浏览器，未发送给模型');
  } catch (error) { toast(error.message); }
  event.target.value = '';
});
$('clear-reference').addEventListener('click', () => { delete state.refs[state.refLang]; updateReferenceInfo(); renderRows(); });

function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime })); const link = document.createElement('a');
  link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => {
  try {
    const content = state.original?.version === 2 ? renderDelivery({ ...state.project, rows: state.rows }, button.dataset.export, { final: $('export-mode').value === 'final' }) : renderSrt(state.rows, button.dataset.export, duration());
    download(`${filenameStem(state.original.filename)}.srt`, content, 'application/x-subrip;charset=utf-8');
    toast(`${LABELS[button.dataset.export]}已下载${state.example ? '（界面示例数据）' : '，请按语言分别保存'}`);
  } catch (error) { toast(error.message); }
}));
$('export-json').addEventListener('click', () => {
  const project = { ...(state.project ?? state.original), kind: state.example ? 'interface-example' : 'review-project', rows: state.rows, originalRows: state.original.rows, references: state.refs, issues: currentIssues(), exportedAt: new Date().toISOString() };
  download(`${filenameStem(state.original.filename)}.json`, JSON.stringify(project, null, 2), 'application/json;charset=utf-8');
  state.dirty = false; updateSummary(); toast('项目 JSON 已导出，包含初稿、修订和参考');
});
$('save').addEventListener('click', async () => {
  try {
    if (state.example) { localStorage.setItem('cantonese-demo-example', JSON.stringify({ original: state.original, rows: state.rows })); toast('界面示例修订已保存在此浏览器'); }
    else { const saved = await api(`/api/jobs/${state.jobId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: state.rows }) }); if (saved.review) { state.project = saved.review; state.rows = structuredClone(saved.review.rows); renderRows(); } toast('修订已保存，原始生成版保持独立'); }
    state.dirty = false; updateSummary();
  } catch (error) { toast(`保存失败：${error.message}`); }
});
async function saveRealReview() {
  const saved = await api(`/api/jobs/${state.jobId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: state.rows }) });
  state.project = saved.review; state.rows = structuredClone(saved.review.rows); state.dirty = false; renderRows();
}
$('translate').addEventListener('click', async () => {
  try { if (state.dirty) await saveRealReview(); setBusy(true); await api(`/api/jobs/${state.jobId}/translate`, { method: 'POST' }); await pollJob(state.jobId, state.pollEpoch); }
  catch (error) { setBusy(false); notice(error.message); }
});
$('export-bundle').addEventListener('click', async () => {
  try {
    if (state.dirty) await saveRealReview();
    const r = await fetch(`/api/jobs/${state.jobId}/export?final=${$('export-mode').value === 'final'}`);
    if (!r.ok) throw new Error((await r.json()).error);
    download(`${filenameStem(state.original.filename)}.zip`, await r.blob(), 'application/zip');
    toast('三份同名字幕已按 yue / en / zh 分目录打包');
  } catch (error) { toast(error.message); }
});

$('example').addEventListener('click', () => {
  if (state.dirty) { toast('请先保存修订或导出项目 JSON'); return; }
  resetResult(); releaseLocalMedia(); state.file = null; updateGenerate();
  const original = {
    kind: 'interface-example', filename: '界面演示.mp4', duration: 23,
    notes: ['人工编写的虚构界面示例，不是模型输出，不代表真实视频内容。'],
    rows: [
      { id: 's0001', start: 0.8, end: 5.4, yue: '大家好，今日我哋一齊睇下市場嘅變化。', en: 'Hello everyone. Let’s look at how the market is changing.', zh: '大家好，今天我们一起看看市场的变化。', confidence: 0.95 },
      { id: 's0002', start: 5.8, end: 11.3, yue: '如果跌穿呢個支持位，短期可能仲會向下。', en: 'If it breaks below this support level, it could fall further in the short term.', zh: '如果跌破这个支撑位，短期内可能继续下跌。', confidence: 0.92 },
      { id: 's0003', start: 11.8, end: 17.6, yue: '呢個數字係 3.7%，唔係 3.6%，大家要留意。', en: 'The figure is 3.7%, not 3.6%. Pay attention to that difference.', zh: '这个数字是 3.7%，不是 3.6%，请注意区别。', confidence: 0.62, note: '演示检查项：请回听小数与否定表达。' },
      { id: 's0004', start: 18, end: 22.6, yue: '而家只係一個可能性，未可以當成確定嘅結果。', en: 'For now, this is only a possibility, not a certain outcome.', zh: '目前这只是一种可能性，还不能视为确定的结果。', confidence: 0.91 },
    ].map(r => ({ ...r, reviewed: false, stale: false })),
  };
  let saved;
  try { saved = JSON.parse(localStorage.getItem('cantonese-demo-example')); } catch { /* Old cache may be unavailable. */ }
  loadResult(saved?.original?.kind === 'interface-example' && Array.isArray(saved.rows) ? saved.original : original, saved?.rows?.length === 4 ? { rows: saved.rows } : null);
  $('file-name').textContent = '拖入原视频或音频'; $('file-meta').textContent = '或点击选择文件';
  notice('现在展示的是人工编写的界面示例，可测试编辑、参考对照和下载；这不是模型质量测试。'); setCaption(state.rows[0]);
});
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });

try {
  state.config = await api('/api/config');
  $('connection').textContent = state.config.configured ? '已配置 · 开始前检查连接' : '可预览 · 真实服务待配置';
  $('connection').classList.toggle('ready', state.config.configured);
  const missing = [!state.config.asr && 'MiniMax ASR Key', !state.config.translation && '翻译 Key', !state.config.mediaTools && 'FFmpeg / FFprobe'].filter(Boolean);
  $('config-help').textContent = state.config.configured ? `识别：${state.config.recognitionModel} · 审校／翻译：${state.config.translationModel}。提交后使用服务商额度。` : `尚缺 ${missing.join('、')}。按 demo README 配置后重启；现在可以体验界面示例。`;
  updateGenerate(); await refreshHistory();
  const blocked = Object.values(state.config.services ?? {}).find(service => service.blocked);
  if (blocked) { $('service-status').textContent = '模型服务冷却中，可重试时间：' + new Date(blocked.retryAt).toLocaleTimeString(); showCooldown(blocked.retryAt); }
  const id = new URLSearchParams(location.search).get('job'); if (id) await openJob(id);
} catch (error) { $('connection').textContent = '后台未连接'; $('config-help').textContent = '请通过 start-demo.bat 启动，再打开本地地址。'; notice(error.message); }
