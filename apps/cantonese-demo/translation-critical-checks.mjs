// Source-grounded review flags, never silent translation replacements.
// These checks deliberately do not certify any unflagged sentence as correct.
import {semanticRiskIssues} from './semantic-repair.mjs';
// Split adjacent spoken letter names as separate entities. PMO S M P must
// retain PMO AND S&P, while normalizing SMP must not be reported as a loss.
const KNOWN_CODES = ['AAII','FOMC','NASDAQ','PMO','SMP','UGA','MOVE','VIX','WTI','CCI','CPI','PPI','SOX','IWM','NDX','SPX','ETF','USD'];
export function sourceEntities(text) {
  const entities = /\bS\s*&\s*P\b/iu.test(text) ? ['S&P'] : [];
  for (const m of String(text).matchAll(/\b[A-Z]{2,}\b|\b[A-Z](?:\s+[A-Z]){1,12}\b/gu)) {
    let code = m[0].replace(/\s/gu, '');
    while (code) {
      const part = KNOWN_CODES.find(k => code.startsWith(k)) ?? code;
      if(!['OK','AND','THE','OR'].includes(part))entities.push(part === 'SMP' ? 'S&P' : part);
      code = code.slice(part.length);
    }
  }
  return [...new Set(entities)];
}
function containsEntity(english, code) {
  if (code === 'S&P') return /\bS\s*&\s*P\b|Standard\s*(?:and|&)\s*Poor/iu.test(english);
  return new RegExp('(?<![A-Z])' + code.split('').join('\\s*') + '(?![A-Z])', 'u').test(english.toUpperCase());
}
export function criticalTranslationIssues(rows) {
  const issues = semanticRiskIssues(rows);
  const source = rows.map(r => r.yue).join(' ');
  const add = (r, lang, code, reason, severity = 'major') => issues.push({ id: r.id, lang, code, severity, quote: r[lang === 'source' ? 'yue' : lang], reason, origin: 'deterministic-source-check' });
  for (const [index, row] of rows.entries()) {
    const localSource = rows.slice(Math.max(0,index-2),index+3).map(r=>r.yue).join(' ');
    const localEnglish = rows.slice(Math.max(0,index-2),index+3).map(r=>r.en).join(' ');
    const compactSource = localSource.replace(/[\s，,。；;]+/gu, '');
    const bollinger = /bollinger|布林/iu.test(localSource);
    if (bollinger && /\bmedium\s+line\b/iu.test(localEnglish) && /\bmedium\b/iu.test(row.en)) {
      add(row,'en','bollinger-middle-band','布林带中线应为 middle band/middle line；此提示不适用于 medium term 等其他表达。');
    }
    if (bollinger && /\b(?:below|beneath)\b/iu.test(row.en)
      && /\b(?:below|beneath)\s+(?:(?:the|its|his)\s+)?Bollinger\s+Bands?\b/iu.test(localEnglish)
      && /(?:Band|布林帶|布林带).{0,12}(?:下方|下邊|下边|下面)/iu.test(localSource)) {
      add(row,'en','bollinger-lower-position','源文“下方/下边”可能指带内下部或下轨支撑，英文 below 整条带可能改变技术位置；结合同期画面确认，不自动替换。');
    }
    if (/落[返翻].{0,14}再(?:探|test)/iu.test(row.yue) && /正常/u.test(localSource)
      && /\bcame\s+back\s+down\b.{0,35}\btested\b/iu.test(row.en)) {
      add(row,'en','retest-actuality','源文可能在说回落再测试也正常；过去式可能新增“已经回测”。核实条件/实际发生的关系，不凭参考或语法偏好直接重写。');
    }
    if (/即[係系].{0,12}去到|有機會.{0,12}去到|有机会.{0,12}去到/u.test(row.yue)
      && /\b(?:straight|directly)\s+to\b/iu.test(row.en) && !/直接|直達|直达/u.test(row.yue)) {
      add(row,'en','unspoken-direct-path','源文去到某处未必含“直接到达”；即系是解释语，核对英文是否新增路径含义。');
    }
    if (/(?:呢|[嚟黎來来])緊嘅市[場场]/u.test(row.yue)
      && /\btight[ -]market\b|\bupcoming\s+market\b/iu.test(row.en)
      && /health\s*care|healthcare|financial|地[產产]|板[塊块]|sector/iu.test(localSource)) {
      add(row,'source','sector-leading-source-unclear','板块语境的呢緊可能是lead緊，也可能是未来表达；先回听源稿，不能自行补成领涨或tight market。','source');
    }
    if (/^[.。]\s*[A-Za-z]/u.test(row.en)) add(row,'en','orphan-leading-period','英文句首有孤立句点；结合上一条清理标点，不删除实质内容。','style');
    const duration=row.en.match(/\b(?:for|over)\s+(?:almost\s+|nearly\s+)?(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s+and\s+a\s+half)?\s+(months?|weeks?|years?)\b/iu);
    const sourceUnit=duration&&(/^month/iu.test(duration[1])?/月|month/iu:/^week/iu.test(duration[1])?/周|週|礼拜|禮拜|week/iu:/年|year/iu);
    if (duration && !sourceUnit.test(localSource)) {
      add(row,'en','unsupported-duration','邻近源句没有年月周时长，英文却新增确定持续时间；不清楚的近音词不能被补成具体月份。','critical');
    }
    if (/正常(?:嘅)?(?:环境|環境)/u.test(compactSource) && /\b(?:normal|usual)\s+range\b/iu.test(row.en)
      && !/区间|區間|范围|範圍/u.test(localSource)) {
      add(row,'en','circumstances-not-range','正常环境指一般情形，不能新增指标处于正常区间的判断。');
    }
    if (/(?:net|净|淨).{0,12}(?:五十二|52)/iu.test(compactSource)
      && /52[ -]week|fifty[ -]two[ -]week/iu.test(localEnglish)
      && !/\bnet\b|highs\s+minus\s+(?:new\s+)?lows/iu.test(localEnglish)) {
      if(/52|fifty[ -]two/iu.test(row.en))add(row,'en','net-indicator-qualifier','源文的net净值限定未保留；不能把净新高新低指标改成两个独立数量。');
    }
    if (/(?:五十二|52)(?:个|個)?(?:礼拜|禮拜|周|週)/u.test(compactSource)
      && /\b(?:52|fifty[ -]two)\s*(?:percent|%)/iu.test(row.en)
      && !/\b(?:52|fifty[ -]two)[ -]weeks?\b/iu.test(localEnglish)) {
      add(row,'en','week-not-percent','跨字幕的“礼／拜”仍是周单位；52周不得变成52%。','critical');
    }
    if (/(?:唔|冇|不).{0,35}panic.{0,25}(?:去到|至於|至于).{0,30}(?:对冲|對沖)/iu.test(localSource)
      && /\b(?:their|the)\s+hedging\s+(?:was|is)\s+(?:very|extremely|highly)\s+aggressive\b|\bhedg(?:e[ds]?|ing)\b.{0,15}\bvery aggressively\b/iu.test(row.en)) {
      add(row,'en','negated-degree-hedging','“没有恐慌到猛烈对冲的程度”不能拆成“没有恐慌；对冲很猛烈”。','critical');
    }
    if (/(?:得嗰|只有|仅有|僅有|得返).{0,18}(?:percent|%)/iu.test(row.yue)
      && /\b(?:just\s+)?(?:over|more than)\s+(?:\d|[a-z]+[ -](?:three|four|five|six|seven|eight|nine))/iu.test(row.en)) {
      add(row,'en','only-versus-over','原文只有限定数量，英文额外增加大于关系；如原音本身含糊，应核实而非猜测。');
    }
    if (/機會率|机会率|概率/u.test(localSource) && /\b(?:fallen?|dropped?|decreased?|declined?)\s+by\b/iu.test(row.en)) add(row,'en','probability-change-basis','概率被译为下降了某个幅度；必须核对原文说的是起点、终点还是降幅。数字相同不代表关系正确。','critical');
    if (/股票/u.test(localSource) && /(?:天|日)(?:以上|之上)|均線|均线|平均線|平均线/u.test(localSource) && /\bstocks\b.{0,90}\b(?:fell|fallen|dropped|fall|falling)\b.{0,15}\bto\b.{0,25}(?:percent|%)/iu.test(row.en) && !/percentage|proportion|share of|percent of/iu.test(localEnglish)) add(row,'en','stock-proportion-object','均线以上股票比例可能被译为股票价格或股票本身跌到某个百分比；明确比例的分母和对象，不能只匹配数字。');
    const phrase = String(row.en ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    const previous = String(rows[index - 1]?.en ?? '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
    if (phrase.length >= 20 && phrase.split(/\s+/u).length >= 4 && previous.includes(phrase)) {
      add(row, 'en', 'repeated-target-fragment', '本条英文长短语已出现在紧邻上一条中；核对是否跨字幕重复翻译。原口播也可能重复，因此只提示审阅，不自动删除。');
    }
    if (/百分点/u.test(row.zh) && /percent|百分之|百分比|%/iu.test(source) && !/百分点|百分點|percentage\s+points?|basis\s+points?|基点|基點/iu.test(source)) {
      add(row, 'zh', 'percent-not-point', '源段只有百分比变化，译文出现“百分点”；核对相对变化与百分点单位，不能自动认定二者等价。', 'critical');
    }
    if (/息口|利率|收益率/u.test(row.yue) && /\bmargins?\b/iu.test(row.en) && !/margin|利润|利潤|毛利/u.test(row.yue)) {
      add(row, 'en', 'rate-not-margin', '源句谈利率，英文却出现利润率 margin；须核对金融对象。', 'critical');
    }
    if (/冇咁快|没那么快|沒那麼快/u.test(row.yue) && /\bless\s+slowly\b/iu.test(row.en)) {
      add(row, 'en', 'comparative-direction', '“没那么快”与“less slowly”的方向冲突；须重新核对比较关系。', 'critical');
    }
    for (const match of row.yue.matchAll(/(?:[12]\d{3}|[一二][零〇一二三四五六七八九]{3})年/gu)) {
      const year = match[0].slice(0, -1).replace(/[零〇一二三四五六七八九]/gu, c => String('零一二三四五六七八九'.indexOf(c === '〇' ? '零' : c)));
      if (!new RegExp(`\\b${year}\\b`, 'u').test(localEnglish)) add(row, 'source', 'year-not-found', `源文年份 ${year} 未在邻近英文中以数字找到；检查是否漏译或使用了英文数字拼写。`);
    }
    for (const code of sourceEntities(row.yue)) {
      if (!containsEntity(localEnglish, code)) add(row, 'source', 'ticker-not-found', `源文代码 ${code} 未在邻近英文找到；检查是否丢失、误扩写或在上下段正确承接。`);
    }
  }
  return issues;
}
