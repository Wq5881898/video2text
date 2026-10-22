import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from './pipeline.mjs';
import { digestFile, digest } from './model-client.mjs';
import { requireSeal, revealReferenceBodies, assertExactCoverage, ownRecordsOnce, planTitleIssues } from './holdout-protocol.mjs';
import { parseReference, filenameStem, timestamp } from './public/subtitles.mjs';
import { renderDelivery, publicationIssues } from './public/subtitle-layout.mjs';
import { zipFiles } from './subtitle-bundle.mjs';

const [phase, runArgument, outputArgument] = process.argv.slice(2);
if (!phase || !runArgument) throw Error('Usage: node holdout-report.mjs <compare|export> <run-dir> [report-dir]');
const dir = path.resolve(runArgument), read = n => readJson(path.join(dir, n));
const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');
const html = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function compare() {
  const frozen = await read('frozen.json');
  const source = (await requireSeal(dir, 'source-final')).value;
  const minimax = (await requireSeal(dir, 'minimax-final')).value;
  const independent = frozen.requireIndependent ? (await requireSeal(dir, 'independent-final')).value : null;
  const referenceFiles = await revealReferenceBodies(dir, frozen);
  const refs = referenceFiles.map((f, i) => {
    const rows = parseReference(f.body, f.path).map((r, n) => ({ ...r, id: `ref${i}-${String(n + 1).padStart(4, '0')}` }));
    const text = rows.map(r => r.text).join('');
    const latin = (text.match(/[A-Za-z]/gu) ?? []).length, han = (text.match(/\p{Script=Han}/gu) ?? []).length;
    return { file: f.path, sha256: f.sha256, language: latin > han * 2 ? 'en' : 'yue', languageClassification: 'Character-script heuristic, not proof of authorship or correctness', rows };
  });
  if (refs.filter(r => r.language === 'en').length !== 1 || refs.filter(r => r.language === 'yue').length !== 1) throw Error('Expected exactly one English and one Chinese/Cantonese comparator; review roles explicitly');
  const plan = await read('semantic-plan.json'), raw = await read('source-original.json');
  const titleIssues=planTitleIssues(plan,source.rows);
  if(titleIssues.length)throw Error('Unverified topic headings: '+JSON.stringify(titleIssues));
  const groups = plan.map(p => {
    const sourceRows = p.sourceIds.map(id => source.rows.find(r => r.id === id));
    return { ...p, start: sourceRows[0].start, end: sourceRows.at(-1).end, source: sourceRows, raw: p.sourceIds.map(id => raw.find(r => r.id === id)), minimax: p.sourceIds.map(id => minimax.rows.find(r => r.id === id)), independent: independent ? p.sourceIds.map(id => independent.rows.find(r => r.id === id)) : [] };
  });
  for (const reference of refs) {
    const owned = ownRecordsOnce(groups, reference.rows);
    groups.forEach((g, i) => { g[`${reference.language}Reference`] = owned[i].records; });
  }
  for (const [key, expected] of [['source', source.rows], ['raw', raw], ['minimax', minimax.rows], ...(independent ? [['independent', independent.rows]] : []), ...refs.map(r => [`${r.language}Reference`, r.rows])]) assertExactCoverage(expected, groups.flatMap(g => g[key]), key);
  const packet = { kind: 'sealed-new-video-comparison', createdAt: new Date().toISOString(), frozen, source, raw, minimax, independent, refs, groups, referencesRevealed: await read('reference-reveal.json'), wholeFilmAccepted: false };
  await writeJson(path.join(dir, 'comparison.json'), packet);
  await fs.writeFile(path.join(dir, 'full-comparison.txt'), groups.map(g => `${g.id} ${g.start.toFixed(2)}–${g.end.toFixed(2)} ${g.title}\n粤语原始：${g.raw.map(r => r.id + ' ' + r.yue).join(' ')}\n粤语审定：${g.source.map(r => r.id + ' ' + r.yue).join(' ')}\n粤语参考：${g.yueReference.map(r => r.id + ' ' + r.text).join(' ')}\n英文基线：${g.enReference.map(r => r.id + ' ' + r.text).join(' ')}\n独立英文：${g.independent.map(r => r.id + ' ' + r.en).join(' ')}\nMiniMax英文：${g.minimax.map(r => r.id + ' ' + r.en).join(' ')}\n`).join('\n'), 'utf8');
  console.log(JSON.stringify({ phase, paragraphs: groups.length, sourceRows: source.rows.length, refs: refs.map(r => ({ language: r.language, rows: r.rows.length, filename: path.basename(r.file) })) }));
}

async function exportReport() {
  if (!outputArgument) throw Error('Export needs output directory');
  const out = path.resolve(outputArgument); await fs.mkdir(out, { recursive: true });
  const p = await read('comparison.json'); if (!p) throw Error('Compare after sealing first');
  const assessment = await read('assessment.json') ?? { summary: ['结果已封存，语义判断尚待逐段审阅。'], findings: [], paragraphs: [] };
  const cleanProbe = await read('minimax-clean-probe-seal.json') ? (await requireSeal(dir,'minimax-clean-probe')).value : null;
  const grammarProbe = await read('minimax-grammar-probe-seal.json') ? (await requireSeal(dir,'minimax-grammar-probe')).value : null;
  const punctuationProbe = await read('minimax-punctuation-probe-seal.json') ? (await requireSeal(dir,'minimax-punctuation-probe')).value : null;
  const quoteSources = { source: p.source.rows, raw: p.raw, minimax: p.minimax.rows, independent: p.independent?.rows ?? [], cleanProbe:cleanProbe?.rows??[], grammarProbe:grammarProbe?.rows??[], punctuationProbe:punctuationProbe?.rows??[], enReference: p.refs.find(r => r.language === 'en').rows, yueReference: p.refs.find(r => r.language === 'yue').rows };
  for (const finding of assessment.findings) for (const quote of finding.quotes ?? []) {
    const records = quoteSources[quote.key];
    if (!records || !quote.ids?.length || !quote.text?.trim()) throw Error('Finding quote needs its track, IDs and actual text');
    const positions = quote.ids.map(id => records.findIndex(r => r.id === id));
    if (positions.some(i => i < 0) || positions.some((n, i) => i && n !== positions[i - 1] + 1)) throw Error('Finding quotes must use consecutive actual records');
    const field = quote.key.endsWith('Reference') ? 'text' : ['source', 'raw'].includes(quote.key) ? 'yue' : 'en';
    if (!positions.map(i => records[i][field]).join(' ').includes(quote.text)) throw Error('Finding quote differs from sealed/reference text');
  }
  const inventory = (await requireSeal(dir, 'visual-inventory')).value.frames;
  const frames = await read('frames.json'), media = await read('media.json');
  const chinese = await read('chinese-final-seal.json') ? (await requireSeal(dir,'chinese-final')).value : null;
  const files = [], downloads = [], quality = {};
  for (const [folder, project, lang, label] of [['independent', p.independent, 'en', '独立英文'], ['minimax', p.minimax, 'en', 'MiniMax英文'], ['yue', p.source, 'yue', '粤语审定稿'], ...(chinese ? [['zh', chinese, 'zh', '简体中文']] : [])]) {
    if (!project) continue;
    const filename = `${filenameStem(p.frozen.video.filename)}.srt`, relative = `${folder}/${filename}`;
    const content = renderDelivery(project, lang, { final: false });
    await fs.mkdir(path.join(out, folder), { recursive: true });
    await fs.writeFile(path.join(out, relative), content, 'utf8');
    const textPath = `${folder}/${filenameStem(p.frozen.video.filename)}.txt`;
    const text = project.rows.map(r => `[${timestamp(r.start, '.')}] ${r[lang]}`).join('\n');
    await fs.writeFile(path.join(out, textPath), text, 'utf8');
    files.push({ name: relative, content }, { name: textPath, content: text });
    downloads.push({ label, href: relative, textHref: textPath, sha256: digest(content), rows: project.rows.length, lang, folder, content, textContent: text });
    quality[folder] = publicationIssues(project, lang);
  }
  for (const reference of p.refs) {
    const content = await fs.readFile(reference.file);
    files.push({ name: `references/${reference.language}.srt`, content });
  }
  const proofFiles = ['frozen.json', 'media.json', 'source-final.json', 'source-final-seal.json', 'minimax-draft.json', 'minimax-draft-seal.json', 'minimax-final.json', 'minimax-final-seal.json', 'independent-final.json', 'independent-final-seal.json', 'chinese-final.json', 'chinese-final-seal.json', 'reference-reveal.json', 'visual-inventory.json', 'visual-inventory-seal.json', 'source-decisions.json', 'source-extra-patches.json', 'source-proposals.json', 'source-priorities.json', 'audio-recheck-selection.json', 'audio-rechecks.json', 'public-source-context.json', 'english-audit.json', 'english-decisions.json', 'program-checks.json', 'relation-audit-minimax.json', 'relation-audit-independent.json', 'asr-unknown-retry.json', 'text-unknown-retry.json', 'assessment.json', 'input/source.json', 'input/manifest.json', 'source-original.json', 'source-model-proposals.json', 'source-coordinator-issues.json', 'pre-reveal-english-review.json', 'semantic-plan-coordinator-fixes.json', 'asr-split-recovery.json', 'asr-recovery-complete.json', 'lineage.json', 'runtime-implementation-fix.json', 'preflight.json', 'learned-rules-candidates.json', 'minimax-clean-probe.json', 'minimax-clean-probe-seal.json', 'minimax-grammar-probe.json', 'minimax-grammar-probe-seal.json', 'minimax-punctuation-probe.json', 'minimax-punctuation-probe-seal.json'];
  proofFiles.push('pipeline-final-implementation.json');
  for (const file of proofFiles) try { files.push({ name: `evidence/${file}`, content: await fs.readFile(path.join(dir, file)) }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const file of await fs.readdir(path.join(dir, 'requests'))) if (/-response\.json$|-intent\.json$|-unknown-\d+\.json$/u.test(file)) files.push({ name: `evidence/requests/${file}`, content: await fs.readFile(path.join(dir, 'requests', file)) });
  for (const frame of frames) files.push({ name: `evidence/frames/${path.basename(frame.path)}`, content: await fs.readFile(frame.path) });
  const manifest = { filename: p.frozen.video.filename, kind: 'Review drafts, not accepted publication', rows: p.source.rows.length, baselineRows: Object.fromEntries(p.refs.map(r => [r.language, r.rows.length])), wholeFilmAccepted: assessment.wholeFilmAccepted === true, youtubePlaybackVerified: false, humanAudioReview: false, downloads, quality, audioRecovery: media.recoveredAudio, phaseRunner: 'holdout-runner.mjs', referenceIsolation: 'Candidates sealed before reference-body reader; independent worker uses instruction allowlist, not OS isolation', modelAuditIsNotAcceptance: true };
  files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });
  await fs.writeFile(path.join(out, '字幕与审阅证据.zip'), zipFiles(files));
  await writeJson(path.join(out, 'manifest.json'), manifest);
  const packet = { ...p, chinese, assessment, downloads, quality, inventory, frames: frames.map(f => ({ ...f, href: rel(out, f.path) })), audioRechecks: (await read('audio-rechecks.json') ?? []).map(r => ({ ...r, href: rel(out, r.file) })), video: rel(out, path.join(dir, 'source.mp4')), manifest };
  const data = JSON.stringify(packet).replaceAll('<', String.fromCharCode(92) + 'u003c');
  const poster = packet.frames.find(f => f.time >= 25)?.href ?? packet.frames[0]?.href;
  const document = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新视频盲测与完整对照</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f5ef;color:#163e34;font:16px/1.7 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1440px;margin:auto;padding:24px}h1{font-size:28px}h2{font-size:21px}p{margin:8px 0}a{color:#176e58;overflow-wrap:anywhere}button,select{font:inherit;border:1px solid #a8c2b3;border-radius:6px;background:white;color:#174536;padding:7px 12px;cursor:pointer}section,article{background:white;border:1px solid #d5dfd1;border-radius:10px;padding:20px;margin:16px 0}.notice{border-left:5px solid #b87735;padding:10px 14px;background:#fff4e5}.toolbar{position:sticky;top:0;z-index:2;background:#f3f5ef;padding:12px 0;display:flex;flex-wrap:wrap;gap:10px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:18px}.column{background:#f7f8f2;padding:14px;min-width:0}.cue{border-top:1px solid #dde4d6;padding:10px 0;overflow-wrap:anywhere}.time{font-size:12px;color:#54776b}.text{white-space:pre-wrap}.source{font-size:14px;color:#4a6c60}video{width:100%;max-height:570px;background:black}#caption{min-height:62px;background:#193e32;color:white;text-align:center;padding:12px;font-size:20px}.facts{background:#edf4e8;padding:10px}.frame{max-width:100%;max-height:550px;display:block}.finding{border-left:4px solid #b87735;padding:12px;background:#fff9ee;margin:12px 0}summary{cursor:pointer}ul{padding-left:22px}.muted{color:#677b70;font-size:13px}.downloads{display:flex;gap:18px;flex-wrap:wrap}.verdict{font-weight:650}.record-id{font-size:12px;color:#5f7e70}audio{max-width:100%}@media(max-width:700px){main{padding:12px}.pair{grid-template-columns:1fr}h1{font-size:23px}section,article{padding:13px}}
</style><main><h1>${html(filenameStem(p.frozen.video.filename).match(/\d{4}年\d+月\d+日/u)?.[0] ?? '新视频')}：盲测与完整对照</h1><div class="notice">先封存候选，再揭示基线。当前提供审阅草稿；模型自审、格式通过与本地播放都不等于整片质量验收。</div><section id="summary"></section><section><h2>原视频与候选字幕</h2><video id="video" controls preload="metadata" poster="${html(poster)}" src="${html(packet.video)}"></video><div id="caption"></div><label>预览字幕 <select id="track"><option value="independent">独立英文</option><option value="minimax">MiniMax英文</option><option value="source">粤语</option><option value="chinese">简体中文</option></select></label><p class="muted">音轨来源及恢复情况见下方运行清单。点击任一字幕时间可定位。未做人耳全片听审或YouTube上传验收。</p></section><section><h2>字幕下载与交付检查</h2><div class="downloads" id="downloads"></div><p><a href="字幕与审阅证据.zip" download>下载字幕与审阅证据 ZIP</a></p><div id="quality"></div></section><section><h2>具体差异与审阅意见</h2><details id="finding-details"><summary>展开 ${assessment.findings.length} 项差异与原图证据</summary><div id="findings"></div></details></section><div class="toolbar"><select id="mode"><option value="independent">英文基线 ↔ 独立英文</option><option value="minimax">英文基线 ↔ MiniMax英文</option><option value="yue">粤语参考 ↔ 粤语审定</option><option value="raw">原始ASR ↔ 粤语审定</option></select><span id="coverage"></span></div><div id="groups"></div><section><h2>流程、证据与限制</h2><p>固定词库/规则 → 检查媒体与音轨 → 连续分块ASR → 独立截图清单 → 全量源稿核查 → 有界疑点复识 → 封存粤语 → 完整语义段翻译/保护信息 → 全量语义审查/局部修正 → 封存候选 → 揭盲对照。</p><p>参考字幕在候选封存后才读取。独立译者不继承协调者对话；文件访问以允许清单约束，不是操作系统隔离。OCR及同一识别引擎复跑均可能重复出错。审阅者对照原文判断，未以英文词差替代准确率。</p><details><summary>运行清单与技术检查</summary><pre id="manifest" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details></section></main><script id="packet" type="application/json">${data}</script><script>
const P=JSON.parse(document.getElementById('packet').textContent),$=id=>document.getElementById(id),esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const fmt=t=>new Date(t*1000).toISOString().slice(11,23);window.reportPacket=P;const labels={enReference:'英文基线',yueReference:'粤语参考',independent:'独立英文',minimax:'MiniMax英文',source:'粤语审定稿',raw:'原始粤语转写',yue:'粤语审定稿',zh:'简体中文'};
$('summary').innerHTML='<h2>'+esc(P.assessment.headline??'本轮测试结果')+'</h2>'+P.assessment.summary.map(s=>'<p>'+esc(s)+'</p>').join('')+'<p class="muted">源稿 '+P.source.rows.length+' 条，英文参考 '+P.refs.find(r=>r.language==='en').rows.length+' 条；各对照模式原始条目全文各一次。</p>';
$('downloads').innerHTML=P.downloads.map(d=>{const srt=URL.createObjectURL(new Blob([d.content],{type:'application/x-subrip;charset=utf-8'})),txt=URL.createObjectURL(new Blob([d.textContent],{type:'text/plain;charset=utf-8'}));return '<div><strong>'+esc(d.label)+'</strong><br><a download="'+esc(d.href.split('/').at(-1))+'" href="'+srt+'">SRT</a> · <a download="'+esc(d.textHref.split('/').at(-1))+'" href="'+txt+'">TXT</a></div>'}).join('');
$('quality').innerHTML=Object.entries(P.quality).map(([k,v])=>'<p class="muted">'+esc(labels[k]??k)+'：'+v.filter(i=>i.code==='unreviewed').length+' 条尚未终审，另有 '+v.filter(i=>i.code!=='unreviewed').length+' 项阅读速度、排版或语义提示。待审数量不等于错误数量；字幕当前为审阅稿。</p>').join('');
$('findings').innerHTML=P.assessment.findings.map((f,i)=>'<div class="finding" id="finding-'+i+'"><strong>'+esc(f.status)+' · '+esc(f.title)+'</strong><p>'+esc(f.reason)+'</p>'+(f.quotes??[]).map(q=>'<p><span class="muted">'+esc(q.label)+'</span> '+esc(q.text)+'</p>').join('')+(f.time!=null?'<button data-seek="'+f.time+'">定位 '+fmt(f.time)+'</button>':'')+((f.frameIds??[]).length?'<details><summary>查看同期原图证据</summary>'+f.frameIds.map(id=>{const frame=P.frames.find(x=>x.id===id);return frame?'<p class="muted">'+fmt(frame.time)+' · '+esc(id)+'</p><a href="'+encodeURI(frame.href)+'" target="_blank"><img class="frame" loading="lazy" src="'+encodeURI(frame.href)+'"></a>':''}).join('')+'</details>':'')+'</div>').join('')||'<p>待逐项审阅。</p>';
function cue(r,field,side){const src=P.source.rows.find(x=>x.id===r.id);const pending=src?.sourceIssues?.some(x=>x.origin==='coordinator-source-only-review')||P.assessment.findings.some(f=>f.sourceId===r.id&&/待核|未决|遗留/.test(f.status));return '<div class="cue" data-record="'+side+':'+esc(r.id)+'"><button class="time" data-seek="'+r.start+'">'+fmt(r.start)+(r.end!=null?'–'+fmt(r.end):'')+'</button><div class="record-id">'+esc(r.id)+'</div>'+(pending?'<p class="muted">此处有待核事项，见审阅意见</p>':'')+'<div class="text" data-content>'+esc(r[field])+'</div></div>'}
function render(){const mode=$('mode').value;let left=mode==='raw'?'raw':mode==='yue'?'yueReference':'enReference',right=mode==='raw'||mode==='yue'?'source':mode;let lf=left==='raw'?'yue':'text',rf=right==='source'?'yue':'en';$('coverage').textContent='左 '+P.groups.flatMap(g=>g[left]).length+' 条 / 右 '+P.groups.flatMap(g=>g[right]).length+' 条，全文各一次';$('groups').innerHTML=P.groups.map(g=>{const opinion=P.assessment.paragraphs?.find(p=>p.id===g.id);const near=P.frames.filter(f=>f.time>=g.start-8&&f.time<=g.end+5);return '<article id="'+g.id+'"><h2>'+fmt(g.start)+' · '+esc(g.title)+'</h2>'+(opinion?'<p class="verdict">'+esc(opinion.verdict??'')+'</p><p>'+esc(opinion.reason)+'</p>':'')+'<div class="pair"><div class="column"><strong>'+esc(labels[left]??left)+'</strong>'+g[left].map(r=>cue(r,lf,'left')).join('')+'</div><div class="column"><strong>'+esc(labels[right]??right)+'</strong>'+g[right].map(r=>cue(r,rf,'right')).join('')+'</div></div><details><summary>粤语原文与同期图证</summary><p class="source">'+esc(g.source.map(r=>r.id+' '+r.yue).join(' '))+'</p>'+near.map(f=>'<details><summary>'+fmt(f.time)+' · '+esc(f.id)+'</summary><img class="frame" loading="lazy" src="'+encodeURI(f.href)+'"><p class="muted">OCR候选：'+esc((P.inventory.find(x=>x.frameId===f.id)?.terms??[]).join(' · '))+'</p></details>').join('')+'</details></article>'}).join('')}
if(!P.independent){$('mode').querySelector('[value="independent"]').remove();$('track').querySelector('[value="independent"]').remove();$('mode').value='minimax';$('track').value='minimax'}
if(!P.chinese)$('track').querySelector('[value="chinese"]').remove();
$('mode').addEventListener('change',render);render();document.addEventListener('click',e=>{const b=e.target.closest('[data-seek]');if(b){$('video').currentTime=Number(b.dataset.seek);$('video').scrollIntoView({behavior:'smooth',block:'center'})}});
$('video').addEventListener('timeupdate',()=>{const key=$('track').value,rows=P[key]?.rows??[],r=rows.find(r=>$('video').currentTime>=r.start&&$('video').currentTime<r.end);$('caption').textContent=r?.[key==='source'?'yue':key==='chinese'?'zh':'en']??''});$('manifest').textContent=JSON.stringify(P.manifest,null,2);
</script></html>`;
  await fs.writeFile(path.join(out, '新视频盲测与完整对照.html'), document, 'utf8');
  await writeJson(path.join(dir, 'export.json'), { at: new Date().toISOString(), directory: out, html: path.join(out, '新视频盲测与完整对照.html'), htmlSha256: digest(document), manifest });
  console.log(JSON.stringify({ phase, directory: out, sourceRows: p.source.rows.length, files: downloads.length, findings: assessment.findings.length }));
}

if (phase === 'compare') await compare(); else if (phase === 'export') await exportReport(); else throw Error('Use compare or export');
