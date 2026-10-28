import { message, errorKey, serviceStateKey } from './cantones-i18n.mjs';
import { isSupportedVideoFile } from './media-policy.mjs';

const $ = id => document.getElementById(id), API = '/cantones/api';
const state = { locale: 'zh-Hant', file: null, job: null, project: null, packet: null, busy: false, dirty: false, all: false, ready: false, config: null, timer: null, epoch: 0, stage: '', retryAt: null, notice: null, localMedia: null };
try { if (localStorage.getItem('cantones-locale') === 'en') state.locale = 'en'; } catch {}
const t = key => message(state.locale, key);
const escape = s => String(s ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function controls() {
  $('start').disabled = !state.ready || !state.file || state.busy;
  $('file').disabled = state.busy;
  $('history').disabled = state.busy;
  $('save').disabled = state.busy || !state.dirty;
  $('download').disabled = state.busy;
  $('confirm-source').disabled = state.busy || !$('source-confirmed').checked;
  const seconds = Math.max(0, Math.ceil((Date.parse(state.retryAt || '') - Date.now()) / 1000)) || 0;
  $('cooldown').hidden = !seconds;
  $('cooldown').textContent = seconds ? `${seconds} ${t('cooldown')}` : '';
  $('resume').disabled = state.busy || seconds > 0 || (!$('unknown-box').hidden && !$('unknown').checked);
}
function busy(value) { state.busy = value; controls(); }
function notice(key, error = null) {
  state.notice = { key, error };
  $('notice').hidden = !key;
  $('notice-text').textContent = key ? t(key) : '';
  $('error-details').hidden = !error;
  $('error-text').textContent = error?.message || '';
  if (error?.retryAt) state.retryAt = error.retryAt;
  controls();
}
async function api(route, options) {
  const response = await fetch(API + route, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const error = new Error(body.error || `HTTP ${response.status}`); Object.assign(error, body); throw error;
  }
  return response.json();
}
function localize() {
  document.documentElement.lang = state.locale;
  document.title = t('title');
  for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of document.querySelectorAll('[data-placeholder]')) element.placeholder = t(element.dataset.placeholder);
  for (const element of document.querySelectorAll('[data-label]')) element.setAttribute('aria-label', t(element.dataset.label));
  $('traditional').setAttribute('aria-pressed', String(state.locale === 'zh-Hant'));
  $('english-ui').setAttribute('aria-pressed', String(state.locale === 'en'));
  $('service-state').textContent = t(serviceStateKey(state.config));
  if (state.file) { $('file-name').removeAttribute('data-i18n'); $('file-name').textContent = state.file.name; }
  if (state.notice) notice(state.notice.key, state.notice.error);
  if (state.stage) $('stage').textContent = t(state.stage);
  render(); controls();
}
function setLocale(value) {
  state.locale = value;
  try { localStorage.setItem('cantones-locale', value); } catch {}
  localize();
}
function media(src, local = false) {
  if (state.localMedia) URL.revokeObjectURL(state.localMedia);
  state.localMedia = local ? src : null;
  $('video').src = src; $('preview').hidden = false;
}
function reset() {
  clearTimeout(state.timer); state.epoch++;
  state.job = null; state.project = null; state.packet = null; state.dirty = false; state.retryAt = null; state.stage = ''; state.all = false;
  $('results').hidden = true; $('progress-panel').hidden = true; $('resume').hidden = true; $('unknown-box').hidden = true;
  $('source-confirmed').checked = false; $('rows').replaceChildren(); $('caption').textContent = '';
  notice(null);
}
function chooseFile(file) {
  if (!file || state.busy) return;
  if (state.dirty) { notice('unsaved'); return; }
  if (!isSupportedVideoFile(file)) { notice('invalidFile'); return; }
  reset(); state.file = file;
  $('file-name').removeAttribute('data-i18n'); $('file-name').textContent = file.name;
  // Keep the preview below the upload card as soon as processing begins.
  media(URL.createObjectURL(file), true);
  history.replaceState(null, '', location.pathname); controls();
}

function rowWarnings(row) {
  const warnings = (state.packet?.englishWarnings || []).filter(w => w.id === row.id);
  if (row.englishAuditStale) warnings.push({ code: 'edited', reason: t('warningStale') });
  return warnings;
}
function warningMessage(warning) {
  if (/layout|duration/u.test(warning.code)) return t('warningLayout');
  if (/speed/u.test(warning.code)) return t('warningSpeed');
  if (warning.code === 'edited') return t('warningStale');
  return t('warningSemantic');
}
function evidence(row, items) {
  const frames = [...new Set([...(row.frameIds || []), ...items.flatMap(i => i.frameIds || [])])];
  const changes = [...(row.terminologyChanges || []), ...(row.changes || []), ...(row.englishPatches || []), ...(row.sourceGroundedEnglishRepairs || [])];
  return `<details><summary>${t('evidence')}</summary>${items.length ? `<ul>${items.map(i => `<li>${escape(i.text || '')}${i.suggestion ? ` → ${escape(i.suggestion)}` : ''}<br>${escape(i.reason || i.message || '')}</li>`).join('')}</ul>` : ''}
    ${changes.map(c => `<p class="changes">${escape(c.from)} → ${escape(c.to)}<br>${escape(c.reason)}</p>`).join('')}
    <div class="frame-list">${frames.filter(id => /^f\d{6}$/u.test(id)).map(id => `<a href="${API}/jobs/${state.job}/frame?id=${id}" target="_blank" rel="noopener"><img src="${API}/jobs/${state.job}/frame?id=${id}" alt="${escape(id)}" loading="lazy"></a>`).join('')}</div></details>`;
}
function render() {
  const project = state.project;
  if (!project) return;
  const sourceMode = !project.sourceDecision;
  const questions = state.packet?.sourceQuestions || [];
  const pendingIds = new Set(sourceMode ? questions.map(q => q.id) : project.rows.filter(r => rowWarnings(r).length).map(r => r.id));
  $('results').hidden = false; $('upload-panel').hidden = true;
  $('result-title').textContent = t(sourceMode ? 'sourceTitle' : 'resultTitle');
  $('result-intro').textContent = t(sourceMode ? 'sourceIntro' : 'resultIntro');
  $('stats').textContent = `${project.rows.length} ${t('count')} · ${pendingIds.size} ${t('pending')}`;
  $('download').hidden = sourceMode || project.kind !== 'english-draft';
  $('source-actions').hidden = !sourceMode;
  $('result-toolbar').hidden = sourceMode;
  $('filter-pending').setAttribute('aria-pressed', String(!state.all));
  $('filter-all').setAttribute('aria-pressed', String(state.all));
  $('no-questions').hidden = sourceMode || pendingIds.size > 0;
  const visible = project.rows.filter(r => sourceMode ? pendingIds.has(r.id) : state.all || !pendingIds.size || pendingIds.has(r.id));
  // All values have already been copied into state on input. Re-rendering for
  // locale/filter changes never reconstructs subtitle text from translated UI.
  $('rows').innerHTML = visible.map(row => {
    const items = sourceMode ? questions.find(q => q.id === row.id)?.issues || [] : rowWarnings(row);
    return `<article class="cue" data-id="${escape(row.id)}"><div class="cue-head"><button type="button" data-seek="${escape(row.id)}" aria-label="${t('seek')}">${clock(row.start)}–${clock(row.end)} ▷</button>${items.length ? `<span class="badge">${t('pendingLabel')}</span>` : ''}<span class="cue-id">${escape(row.id)}</span></div>
      <label for="text-${row.id}">${t(sourceMode ? 'source' : 'english')}</label><textarea id="text-${row.id}" data-field="${sourceMode ? 'yue' : 'en'}" rows="2">${escape(row[sourceMode ? 'yue' : 'en'])}</textarea>
      ${sourceMode ? `<label for="note-${row.id}">${t('note')}</label><textarea id="note-${row.id}" data-field="note" rows="1">${escape(row.sourceReviewNote || '')}</textarea>` : `<details><summary>${t('sourceDetails')}</summary><p class="source-text">${escape(row.yue)}</p></details>${items.map(w => `<p class="warning">${escape(warningMessage(w))}</p>`).join('')}`}
      ${evidence(row, items)}</article>`;
  }).join('');
  controls();
}
async function refreshHistory() {
  const { jobs } = await api('/jobs?profile=cantones');
  const select = $('history');
  select.innerHTML = `<option value="">${t('pickHistory')}</option>` + jobs.map(job => `<option value="${job.id}">${escape(job.filename)} · ${t(job.stage === 'error' ? 'paused' : job.stage)}</option>`).join('');
}
async function loadResult() {
  const packet = await api(`/jobs/${state.job}/result`);
  state.packet = packet; state.project = packet.review || packet.original; state.dirty = false;
  render();
}
async function poll(epoch = state.epoch) {
  try {
    const status = await api(`/jobs/${state.job}`);
    if (epoch !== state.epoch) return;
    state.stage = status.stage; state.retryAt = status.retryAt || null;
    $('progress-panel').hidden = false; $('stage').textContent = t(status.stage);
    $('progress').value = status.progress || 0; $('percent').textContent = `${status.progress || 0}%`;
    if (['done', 'source-review'].includes(status.stage) && !status.running) {
      await loadResult(); busy(false); $('resume').hidden = true; $('unknown-box').hidden = true; notice(null); await refreshHistory(); return;
    }
    if (status.stage === 'error' || !status.running) {
      busy(false); $('resume').hidden = false;
      $('unknown-box').hidden = !/未知|unknown/iu.test(status.message || '');
      notice(status.stage === 'error' ? errorKey({ message: status.message, retryAt: status.retryAt }) : 'paused', status.stage === 'error' ? Object.assign(new Error(status.message), status) : null);
      // A paused translation can still show the already-reviewed source.
      await refreshHistory(); controls(); return;
    }
    busy(true); state.timer = setTimeout(() => poll(epoch), 1500);
  } catch (error) {
    if (epoch !== state.epoch) return;
    busy(false); $('resume').hidden = !state.job; notice(errorKey(error), error);
  }
}
async function openJob(id) {
  if (state.dirty) { notice('unsaved'); return; }
  reset(); state.file = null; state.job = id; busy(true);
  $('upload-panel').hidden = true; media(`${API}/jobs/${id}/media`);
  history.replaceState(null, '', `${location.pathname}?job=${encodeURIComponent(id)}`);
  await poll();
}
function upload(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('POST', API + '/jobs');
    xhr.setRequestHeader('content-type', 'application/octet-stream'); xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-workflow-profile', 'cantones'); xhr.setRequestHeader('x-recognition-mode', 'yue');
    xhr.setRequestHeader('x-glossary', btoa(String.fromCharCode(...new TextEncoder().encode($('glossary').value))));
    xhr.upload.onprogress = e => { if (e.lengthComputable) { $('percent').textContent = `${Math.round(e.loaded / e.total * 100)}%`; $('progress').value = e.loaded / e.total * 100; } };
    xhr.onload = () => {
      let body; try { body = JSON.parse(xhr.responseText); } catch { reject(Error('Invalid upload response')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(Object.assign(new Error(body.error || `HTTP ${xhr.status}`), body));
    };
    xhr.onerror = () => reject(Error('Network connection interrupted')); xhr.send(file);
  });
}
async function saveEnglish() {
  if (!state.dirty) return;
  await api(`/jobs/${state.job}/save-english`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: state.packet.revision, rows: state.project.rows.map(({ id, en }) => ({ id, en })) }) });
  await loadResult(); notice('saved');
}

$('traditional').onclick = () => { setLocale('zh-Hant'); refreshHistory().catch(() => {}); };
$('english-ui').onclick = () => { setLocale('en'); refreshHistory().catch(() => {}); };
$('file').onchange = e => chooseFile(e.target.files[0]);
$('dropzone').onkeydown = e => { if (e.target === $('dropzone') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); if (!state.busy) $('file').click(); } };
for (const name of ['dragover', 'dragenter']) $('dropzone').addEventListener(name, e => { e.preventDefault(); if (!state.busy) $('dropzone').classList.add('drag'); });
for (const name of ['drop', 'dragleave']) $('dropzone').addEventListener(name, e => { e.preventDefault(); $('dropzone').classList.remove('drag'); });
$('dropzone').addEventListener('drop', e => chooseFile(e.dataTransfer.files[0]));
$('start').onclick = async () => {
  if (!state.file || state.busy) return;
  reset(); busy(true); $('progress-panel').hidden = false; $('stage').textContent = t('preflight'); state.stage = 'preflight';
  try {
    await api('/preflight', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    $('stage').textContent = t('uploading'); state.stage = 'uploading';
    const job = await upload(state.file); state.job = job.id;
    $('upload-panel').hidden = true; $('results').hidden = false;
    history.replaceState(null, '', `${location.pathname}?job=${job.id}`); await poll();
  } catch (error) { busy(false); notice(errorKey(error), error); }
};
$('resume').onclick = async () => {
  if (!state.job || state.busy) return;
  try {
    busy(true); notice(null); $('resume').hidden = true;
    await api(`/jobs/${state.job}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retryUnknown: $('unknown').checked }) });
    $('unknown').checked = false; await poll();
  } catch (error) { busy(false); $('resume').hidden = false; notice(errorKey(error), error); }
};
$('history').onchange = e => { if (e.target.value) openJob(e.target.value).catch(error => notice(errorKey(error), error)); };
$('rows').addEventListener('input', e => {
  const row = state.project?.rows.find(r => r.id === e.target.closest('[data-id]')?.dataset.id);
  if (!row || !e.target.dataset.field) return;
  if (e.target.dataset.field === 'note') row.sourceReviewNote = e.target.value;
  else row[e.target.dataset.field] = e.target.value;
  state.dirty = true; $('source-confirmed').checked = false; controls();
});
$('rows').addEventListener('click', e => {
  const button = e.target.closest('[data-seek]'); if (!button) return;
  const row = state.project.rows.find(r => r.id === button.dataset.seek);
  $('video').currentTime = row.start; $('video').play().catch(() => {}); $('preview').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('video').addEventListener('timeupdate', () => {
  const time = $('video').currentTime, row = state.project?.rows.find(r => time >= r.start && time < r.end);
  $('caption').textContent = row ? (row.en || row.yue) : '';
});
$('source-confirmed').onchange = controls;
$('unknown').onchange = controls;
$('confirm-source').onclick = async () => {
  if (!state.job || state.busy || !$('source-confirmed').checked) return;
  const rows = state.packet.sourceQuestions.map(q => { const row = state.project.rows.find(r => r.id === q.id); return { id: row.id, yue: row.yue, note: row.sourceReviewNote || '' }; });
  try {
    busy(true);
    await api(`/jobs/${state.job}/confirm-source`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: state.packet.revision, rows }) });
    state.dirty = false; state.project = null; $('results').hidden = true; notice(null); await poll();
  } catch (error) { busy(false); notice(errorKey(error), error); }
};
$('save').onclick = async () => { try { busy(true); await saveEnglish(); } catch (error) { notice(errorKey(error), error); } finally { busy(false); } };
$('download').onclick = async () => {
  if (state.busy) return;
  busy(true);
  try {
    await saveEnglish();
    const response = await fetch(`${API}/jobs/${state.job}/export`);
    if (!response.ok) { const body = await response.json(); throw Error(body.error || `HTTP ${response.status}`); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    const name = state.project.filename.split(/[\\/]/u).at(-1).replace(/\.[^.]+$/u, '') + '.srt';
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) { notice(errorKey(error), error); } finally { busy(false); }
};
$('filter-all').onclick = () => { if (state.project) { state.all = true; render(); } };
$('filter-pending').onclick = () => { if (state.project) { state.all = false; render(); } };
$('new-video').onclick = () => {
  if (state.dirty) { notice('unsaved'); return; }
  reset(); state.file = null; $('file').value = ''; $('file-name').dataset.i18n = 'upload'; $('file-name').textContent = t('upload');
  $('upload-panel').hidden = false; $('preview').hidden = true; $('video').removeAttribute('src'); $('video').load();
  if (state.localMedia) { URL.revokeObjectURL(state.localMedia); state.localMedia = null; }
  history.replaceState(null, '', location.pathname); controls(); window.scrollTo({ top: 0, behavior: 'smooth' });
};
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
setInterval(controls, 1000);

localize(); $('service-state').textContent = t('checking');
try {
  const config = await api('/config'); state.config = config; state.ready = config.configured;
  $('service-state').textContent = t(serviceStateKey(config)); controls();
  await refreshHistory();
  const id = new URLSearchParams(location.search).get('job');
  if (id && /^[a-f0-9-]{36}$/u.test(id)) await openJob(id);
} catch (error) { notice(errorKey(error), error); }
