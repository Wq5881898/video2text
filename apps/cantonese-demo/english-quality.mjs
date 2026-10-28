// Source-derived guards for new serial jobs. No reference subtitle is accepted.
import { applyLocalChanges } from './visual-review.mjs';
export const ENGLISH_QUALITY_POLICY = 'source-guard-v2';
const zhDigits = new Map([...'零一二三四五六七八九'].map((c,i)=>[c,String(i)]));
const digits = s => String(s).replaceAll('〇','零').replace(/[兩两]/gu,'二').replace(/[零一二三四五六七八九]/gu,c=>zhDigits.get(c));
const compact = s => String(s??'').replace(/\s+/gu,' ').trim();
const join = (rows,lang='yue') => rows.map(r=>r[lang]??'').join(' ');
const numberTokens = s => String(s).match(/\d+(?:[,.]\d+)*/gu)??[];
const numericBag = s => numberTokens(s).map(n=>n.replaceAll(',','')).sort();
const unitBag = s => (String(s).toLowerCase().match(/percentage\s+points?|basis\s+points?|percent|%|\b(?:days?|weeks?|months?|years?)\b/gu)??[])
  .map(u=>/^(?:percent|%)$/u.test(u)?'%':/^percentage/u.test(u)?'pp':/^basis/u.test(u)?'bp':u.replace(/s$/u,'')).sort();
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
function spokenNumber(s) {
  s=digits(s).replace(/[點点]/gu,'.');
  if (/^\d+(?:\.\d+)?$/u.test(s)) return s;
  if(/^[\d百千十]+(?:\.\d+)?$/u.test(s)&&/[百千]/u.test(s)) {
    const [head,tail]=s.split('.');let value=0,last=0;
    for(const c of head){if(/\d/u.test(c))last=last*10+Number(c);else{value+=(last||1)*({十:10,百:100,千:1000}[c]);last=0;}}
    return String(value+last)+(tail?'.'+tail:'');
  }
  const m=s.match(/^(\d?)十(\d?)(?:\.(\d+))?$/u);
  return m?String(Number(m[1]||1)*10+Number(m[2]||0))+(m[3]?'.'+m[3]:''):null;
}
function englishRates(text) {
  const normalized=normalizeEnglishNumbers(text)
    .replace(/\b(\d+)\s+and\s+a\s+half\s+(?=percent\b)/giu,(_,w)=>String(Number(w)+.5)+' ')
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?=percent\b)/giu,(_,w)=>String(words[w.toLowerCase()])+' ');
  return [...normalized.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s*(?:%|percent\b)/giu)].map(m=>Number(m[1]));
}
const words={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function normalizeEnglishNumbers(text) {
  const ones='zero|one|two|three|four|five|six|seven|eight|nine';
  const head='(?:(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[ -]+(?:'+ones+'))?|'+Object.keys(words).join('|')+')';
  const numeric=new RegExp('\\b('+head+')(?:\\s+point\\s+((?:(?:'+ones+')[ -]+)*(?:'+ones+')))?\\b','giu');
  return String(text).replace(numeric,(_,h,t)=>{
    const whole=h.toLowerCase().split(/[ -]+/u).reduce((sum,w)=>sum+words[w],0);
    return String(whole)+(t?'.'+t.toLowerCase().split(/[ -]+/u).map(w=>words[w]).join(''):'');
  });
}
const election = /\bmid[ -]?term\s+elections?\b/iu;
const nearElection = /approach|draw\w*\s+(?:near|clos)|nearer|nearing|around\s+the\s+corner|loom|ahead\s+of|coming\s+(?:mid[ -]?term|election)/iu;
const rateRecoverySource = text => /(?:之前|先前).{0,8}[嘅的]?地[產产][版板][塊块]/u.test(text)&&/因[為为]息\s*口向下跌/u.test(text)&&/[開开]始.{0,8}表[現现]好/u.test(text);
const inventedSectorDecline = text => /\breal\s+estate(?:(?!\bbecause\b|\bsince\b|\bas\b|[.!?;]).){0,180}\b(?:has|have|is|are)\s+(?:(?:also|been|now|currently|still|already)\s+)*(?:come\s+down|fallen|falling|declining|dropped|dropping)\b/iu.test(text);
const duplicatedRecovery = text => {
  const position=text.search(/\breal\s+estate\b/iu);if(position<0)return false;
  return (text.slice(position).match(/\b(?:improv\w*|recover\w*|(?:start\w*\s+to\s+)?perform(?:ing)?\s+(?:well|better))\b/giu)??[]).length>1;
};
export function sourceQualityFacts(rows, targets=rows) {
  const ids=new Set(targets.map(r=>r.id)),facts=[];
  const targetText=join(targets);
  if (election.test(targetText)) facts.push({type:'election-event',sourceIds:targets.filter(r=>/midterm|election/iu.test(r.yue)).map(r=>r.id),sourceQuote:targetText,
    approaching:/臨近|临近|接近|將近|将近/u.test(targetText)});
  for (const [i,row] of rows.entries()) {
    if(!ids.has(row.id))continue;
    // A spoken decimal is one value even when rendered in words. 個點 is
    // left unit-ambiguous here; only source/visual review can disambiguate it.
    const span=row.yue+' '+(rows[i+1]?.yue??'');
    if(rateRecoverySource(span))facts.push({type:'rate-driven-sector-recovery',sourceIds:[row.id,rows[i+1].id],sourceQuote:span,requirement:'The real estate sector previously underperformed and is starting to perform well BECAUSE RATES FALL. Do not say the sector has fallen or come down. Falling modifies interest rates, not the sector.'});
    for(const m of span.matchAll(/(?<![零〇一二兩两三四五六七八九十百千萬万億亿廿卅\d])([零〇一二兩两三四五六七八九十百千萬万億亿廿卅\d]+(?:[點点.][零〇一二兩两三四五六七八九\d]+)?)[\s，,]*(?:[個个嘅][\s，,]*)?(percent\b|[%％]|[點点](?![零〇一二兩两三四五六七八九十\d]))/giu)) {
      if(m.index>=row.yue.length)continue;
      const value=spokenNumber(m[1]);if(value==null)continue;
      const crosses=m.index+m[0].length>row.yue.length;
      facts.push({type:'explicit-quantity',sourceIds:[row.id,...(crosses?[rows[i+1].id]:[])],sourceQuote:m[0],value:Number(value),unit:/percent|[%％]/iu.test(m[2])?'percent':'source-point',basis:'Preserve the approved spoken number as a single amount. A colloquial point unit requires source/visual review, not an assumed percentage.'});
    }
    const context=join(rows.slice(Math.max(0,i-8),i+4));
    const bond=/十年|10年|債券|债券|收益率|bond\s*(?:market|yield)|treasury|\bTNX\b/iu.test(context);
    // A monthly loan's 厘 is not this annual bond-yield convention.
    const monthly=/月息|月利|每月|按月|monthly/iu.test(join(rows.slice(Math.max(0,i-1),i+2)));
    if(!bond||monthly)continue;
    for(const m of row.yue.matchAll(/([零〇一二兩两三四五六七八九十\d]+(?:[點点.][零〇一二兩两三四五六七八九\d]+)?)\s*[厘釐]([零〇一二兩两三四五六七八九\d]*)/gu)) {
      const head=spokenNumber(m[1]),tail=digits(m[2]);if(head==null||!/^\d*$/u.test(tail))continue;
      const rest=row.yue.slice(m.index+m[0].length);
      if(/^[幾几多]/u.test(rest))continue;
      let value=head+(tail?(head.includes('.')?'':'.')+tail:'');
      if(rest.startsWith('半')){if(tail||head.includes('.'))continue;value=String(Number(value)+.5);}
      facts.push({type:'annual-bond-yield',sourceIds:[row.id],sourceQuote:m[0],value:Number(value),unit:'percent',
        basis:'Approved annual bond-yield context; preserve spoken value, not a plotted replacement. Monthly-interest contexts are excluded.'});
    }
  }
  return facts;
}
export function validateQualityDraft(payload, targets, completeSource) {
  const english=payload.translations?.map(r=>r.en).join(' ')??'';
  for(const fact of sourceQualityFacts(completeSource,targets)) {
    if(!fact.sourceIds.every(id=>targets.some(r=>r.id===id)))continue;
    if(fact.type==='election-event'&&!election.test(english))throw Error('Source event midterm election is missing from the paragraph');
    if(fact.type==='election-event'&&fact.approaching&&!nearElection.test(english))throw Error('Source temporal condition approaching the midterm election is missing');
    if(fact.type==='annual-bond-yield'&&!englishRates(english).some(n=>Math.abs(n-fact.value)<1e-8))throw Error(`Annual bond-yield source ${fact.sourceQuote} requires ${fact.value}% in this paragraph; preserve its scale and unit`);
    if(fact.type==='rate-driven-sector-recovery'&&inventedSectorDecline(english))throw Error('Causal source says real estate is STARTING TO PERFORM WELL because INTEREST RATES FALL. Remove the invented current decline of the sector; falling modifies rates, not real estate');
    if(fact.type==='rate-driven-sector-recovery'&&duplicatedRecovery(english))throw Error('The source recovery is one claim: do not render both has been improving and is starting to perform well. State the recovery once and attach falling interest rates as its cause');
    if(fact.type==='explicit-quantity') {
      const candidates=fact.unit==='percent'?englishRates(english):numberTokens(normalizeEnglishNumbers(english)).map(n=>Number(n.replaceAll(',','')));
      if(!candidates.some(n=>Math.abs(n-fact.value)<1e-8))throw Error(`Source quantity ${fact.sourceQuote} must remain one amount ${fact.value}${fact.unit==='percent'?'%':''}; do not split or invent decimal values`);
    }
  }
  return payload;
}

const normalized = s => compact(s).toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim();
function transfer(from,to) {
  from=normalized(from);to=normalized(to);
  return from && (from.split(' ').length>=3||/\d/u.test(from)) && (' '+to+' ').includes(' '+from+' ');
}
export function atomicEnglishReview(rows, review) {
  const rejected=(review.quarantinedEvidence??[]).filter(r=>r.kind==='patch').map(r=>({...r.original,rejected:true}));
  const nodes=[...review.patches,...rejected],seen=new Set(),accepted=[],held=[];
  for(let first=0;first<nodes.length;first++) {
    if(seen.has(first))continue;
    const queue=[first],component=[];seen.add(first);
    for(let n=0;n<queue.length;n++) {
      const index=queue[n],p=nodes[index];component.push(p);
      for(let j=0;j<nodes.length;j++)if(!seen.has(j)&&(transfer(p.from,nodes[j].to)||transfer(nodes[j].from,p.to))) {seen.add(j);queue.push(j);}
    }
    const actual=component.filter(p=>!p.rejected),source=component.map(p=>p.sourceQuote??'').join(' ');
    const changed=actual.filter(p=>!same(numericBag(p.from),numericBag(p.to)));
    // Only relocate an already present, source-supported year atomically.
    // Equal totals alone do not authorize moving arbitrary financial quantities.
    const yearMove=changed.length>1&&same(numericBag(actual.map(p=>p.from).join(' ')),numericBag(actual.map(p=>p.to).join(' ')))
      &&changed.every(p=>[...numberTokens(p.from),...numberTokens(p.to)].every(n=>/^[12]\d{3}$/u.test(n)&&digits(source).includes(n)));
    const unitsChanged=!same(unitBag(actual.map(p=>p.from).join(' ')),unitBag(actual.map(p=>p.to).join(' ')));
    let reason=component.some(p=>p.rejected)?'A linked correction lacks valid evidence; the entire linked group was retained':changed.length&&!yearMove||unitsChanged?'Numerical correction needs confirmation; the entire linked group was retained':null;
    const affected=rows.filter(r=>actual.some(p=>p.id===r.id));
    const before=join(affected,'en'),after=affected.map(r=>applyLocalChanges(r.en,actual.filter(p=>p.id===r.id))).join(' ');
    if(!reason&&election.test(before)&&election.test(join(rows))&&!election.test(after))reason='Linked correction would remove the source election event';
    if(reason)held.push(...actual.map(p=>({id:p.id,reason,proposal:p})));
    else accepted.push(...actual);
  }
  return rows.map(row=>{
    const patches=accepted.filter(p=>p.id===row.id);
    return {...row,en:applyLocalChanges(row.en,patches),englishPatches:patches,
      englishQuestions:[...(row.englishQuestions??[]),...review.issues.filter(i=>i.id===row.id),...held.filter(i=>i.id===row.id)],reviewed:false};
  });
}

// Exact, source-supported language repairs. Never change a numerical value,
// source spelling or timeline here. Uncertain source terms remain questions.
export function repairSourceGroundedEnglish(rows, completeSource=rows) {
  const output = rows.map(row=>{
    const i=completeSource.findIndex(r=>r.id===row.id),nearby=completeSource.slice(Math.max(0,i-1),i+2),source=join(nearby);
    const repairs=[];let english=row.en;
    const replace=(pattern,to,rule)=>{english=english.replace(pattern,from=>{const value=typeof to==='function'?to(from):to;if(value!==from)repairs.push({id:row.id,from,to:value,rule,sourceIds:nearby.map(r=>r.id),sourceQuote:source,reason:'Approved source wording supports this local repair; no reference text used',policy:ENGLISH_QUALITY_POLICY});return value;});};
    if(/(?:資金|资金).{0,24}(?:喺|在).{0,5}(?:入邊|入边|內|内|入面)/u.test(source)&&/輪轉|轮转|rotat/iu.test(source)&&!/流入|淨流入|净流入|入市|進入|进入|inflow/iu.test(source)) {
      replace(/\b(?:capital|money|funds)\s+(?:is|are)\s+still\s+coming\s+in\b/giu,s=>s.replace(/coming\s+in$/iu,'in the market'),'inside-not-inflow');
    }
    if(/Consumer\s+Staples/iu.test(source))replace(/\bconsumer\s+stable\b/giu,'consumer staples','confirmed-source-sector');
    // The known S M P sound can span two cues. Restrict the alias to the
    // financial-sector-versus-index comparison, not a company named SMP.
    if(/financial.{0,35}表[現现]好[過过]S\s+M\s+P\b/iu.test(source))replace(/\bSMP\b/gu,'S&P','financial-index-smp-alias');
    if(/反[彈弹].{0,28}(?:去|到).{0,10}[頸颈][線线]/u.test(row.yue)&&!/突破|升穿|上穿|高[於于]|上方/u.test(row.yue)) {
      replace(/\bback\s+up\s+above\s+((?:that|the|this)\s+neckline)\b/giu,s=>s.replace(/above/iu,'to'),'neckline-target-not-crossing');
    }
    const gap=/\bgap\b|缺口/iu.test(row.yue),fill=/\bfill\b|回補|回补|填補|填补/iu.test(row.yue);
    if(gap&&fill) {
      replace(/\breach\s+back\s+to\s+(?:that|the|this)\s+gap\b/giu,'fill that gap','fill-not-touch');
      if(!/向上跳空|向下跳空|上跳空|下跳空|gap[ -](?:up|down)/iu.test(source)) {
        replace(/\bgap\s+from\s+the\s+(?:gap[ -](?:up|down)|overnight\s+jump)\b/giu,'gap','no-unspoken-gap-direction');
        replace(/\bgap[ -](?:up|down)\s+gap\b/giu,'gap','no-unspoken-gap-direction');
      }
    }
    replace(/(?<=[A-Za-z]),{2,}(?!\d)/gu,',','duplicate-comma');
    if(/支持|支撐|支撑/u.test(source)&&/trend\s*line/iu.test(source))replace(/\bthe one the (?=support(?:ing)?\s+trend\s*line\b)/giu,'the ','duplicate-trendline-determiner');
    if(!same(numericBag(row.en),numericBag(english)))throw Error('Language repair attempted to change a number');
    return {...row,en:english,sourceGroundedEnglishRepairs:[...(row.sourceGroundedEnglishRepairs??[]),...repairs]};
  });
  for(let i=1;i<output.length;i++) {
    const before=output[i-1],current=output[i],source=before.yue+' '+current.yue;
    if(/(?:之前|先前).{0,8}[嘅的]?[地][產产][版板][塊块]/u.test(source)&&/因[為为]息\s*口向下跌/u.test(source)&&/開始.{0,8}表現好|开始.{0,8}表现好/u.test(source)
      &&/\breal estate sector has also been falling because interest rates are moving down,\s*$/iu.test(before.en)&&/^so they are starting to perform well\.$/iu.test(current.en)) {
      const oldBefore=before.en,oldCurrent=current.en;
      before.en=before.en.replace(/ has also been falling because interest rates are moving down,\s*$/iu,',');
      current.en='is starting to perform well because interest rates are moving down.';
      for(const [r,from] of [[before,oldBefore],[current,oldCurrent]])r.sourceGroundedEnglishRepairs.push({id:r.id,from,to:r.en,rule:'rate-driven-recovery-cause',sourceIds:[before.id,current.id],sourceQuote:source,reason:'The source describes previous underperformance and a new recovery caused by falling rates, not a present fall of the sector',policy:ENGLISH_QUALITY_POLICY});
    }
    if(/\b(?:expected|anticipated)\s+(?:money|capital|funds)\s+to\s*$/iu.test(before.en)
      &&/^would\s+rotate\b/iu.test(current.en)&&/預料|预料|預計|预计/u.test(source)&&/rotate|輪轉|轮转/iu.test(source)) {
      current.en=current.en.replace(/^would\s+/iu,'');
      current.sourceGroundedEnglishRepairs.push({id:current.id,from:rows[i].en,to:current.en,rule:'expected-to-rotate-boundary',sourceIds:[before.id,current.id],sourceQuote:source,
        reason:'The expectation is already expressed by expected ... to; keep its infinitive across the cue boundary, not to would',policy:ENGLISH_QUALITY_POLICY});
    }
  }
  return output;
}

export function qualitySourceIssues(rows) {
  const issues=[],add=(row,code,reason)=>issues.push({id:row.id,lang:'en',code,severity:'critical',quote:row.en,reason,origin:'source-quality-guard'});
  const fullEnglish=join(rows,'en');
  for(const fact of sourceQualityFacts(rows)) {
    const row=rows.find(r=>r.id===fact.sourceIds[0])??rows[0];
    if(fact.type==='election-event'&&!election.test(fullEnglish))add(row,'missing-election-event','源稿有中期選舉事件，英文全文未保留；ID完整不等於內容完整。');
    if(fact.type==='election-event'&&fact.approaching&&election.test(fullEnglish)&&!nearElection.test(fullEnglish))add(row,'missing-election-condition','源稿有選舉臨近的時間條件，英文未找到對應條件。');
    if(fact.type==='rate-driven-sector-recovery') {
      const local=join(rows.filter(r=>fact.sourceIds.includes(r.id)),'en');
      if(inventedSectorDecline(local))add(row,'rates-sector-cause-reversed','源稿是地產先前落後、因利率下跌而開始改善；英文把下跌加到了地產板塊。');
      if(duplicatedRecovery(local))add(row,'sector-recovery-duplicated','同一個地產改善的主張出現兩次；須合併同義述語並保留利率下降的因果。');
    }
    if(fact.type==='annual-bond-yield'||fact.type==='explicit-quantity') {
      const i=rows.indexOf(row),local=join(rows.slice(Math.max(0,i-1),i+2),'en');
      const candidates=fact.type==='annual-bond-yield'||fact.unit==='percent'?englishRates(local):numberTokens(normalizeEnglishNumbers(local)).map(n=>Number(n.replaceAll(',','')));
      if(!candidates.some(v=>Math.abs(v-fact.value)<1e-8))add(row,fact.type==='annual-bond-yield'?'yield-scale-or-omission':'source-quantity-split-or-loss',`源稿${fact.sourceQuote}須完整保留${fact.value}${fact.unit==='percent'?'%':''}；不能拆成另一組數字或用圖中別的數值替代。`);
    }
  }
  for(const row of rows) {
    if(/\bconsumer\s+stable\b/iu.test(row.en)&&/股|板塊|板块|sector/iu.test(row.yue))add(row,'unresolved-sector-spelling','consumer stable可能是Consumer Staples；先確認同對象來源，不直接照抄基線。');
    const index=rows.indexOf(row),nearby=join(rows.slice(Math.max(0,index-1),index+2));
    if(/financial.{0,35}表[現现]好[過过]S\s+M\s+P\b/iu.test(nearby)&&/\bSMP\b/u.test(row.en))add(row,'unresolved-financial-index-alias','金融板塊對指數的比較仍有SMP近音，跨行術語須按詞庫規範。');
    if(/(?:二八|二十八|28)天(?:平均|均)/u.test(row.yue))add(row,'moving-average-source-question','28天候選命中易錯期限；須同對象圖證或原音確認，不能把少見當成錯誤或直接改200。');
  }
  return issues;
}
