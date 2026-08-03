#!/usr/bin/env node
/**
 * scrape.mjs —— 法途内容 feed 抓取生成管线
 *
 * 数据源（全部为官方公开发布页）：
 *   1. 最高法指导案例：最高人民法院公报网指导性案例列表（http，全量分页）
 *   2. 最高检检例：spp.gov.cn 指导性案例栏目（批次列表 → 批次详情）
 *   3. 最高法司法解释：court.gov.cn 权威发布·司法解释栏目（分页）
 *   4. 司法部典型案例：moj.gov.cn 新闻要闻栏目（best-effort，失败容忍）
 *
 * 输出：
 *   guiding-cases-feed.json  { meta, cases: GuidingCase[] }
 *   legal-updates-feed.json  { meta, updates: LegalUpdate[] }
 *   （指定 --out 时追加）legalUpdates.json  裸数组，供应用内置兜底
 *
 * 合并策略：
 *   - 新抓取条目生成 stub（要旨整理中 + 官方原文链接）
 *   - 人工富化条目（stub != true）永不被 stub 覆盖
 *   - 富化来源优先级：上次 feed 人工编辑 > seeds/enriched-snapshot.json（应用数据快照）
 *   - 本次未抓到的旧条目保留（源抖动不清空内容）
 *
 * 安全自检：spc / spp / sfjs 任一源本次抓取数 < 上次的 90% → 回退沿用上次 feed 中该源条目（降级不中止）；
  *   仅当所有核心源均无数据且无上次 feed 时才中止
 *
 * 用法：
 *   node scrape.mjs                  # 输出到本仓库根（feed 仓库模式）
 *   node scrape.mjs --out <dir>      # 输出到指定目录（应用 public/data 模式）
 *   node scrape.mjs --pretty         # 格式化 JSON
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');

// ===== 参数 =====
const args = process.argv.slice(2);
let outDir = REPO_ROOT;
let pretty = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outDir = args[++i];
  if (args[i] === '--pretty') pretty = true;
}
if (!isAbsolute(outDir)) outDir = resolve(process.cwd(), outDir);

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json',
};
const TIMEOUT_MS = 15000;
const SLEEP_MS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== HTTP 工具 =====
async function get(url, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers: UA });
    const buf = await resp.arrayBuffer();
    return { status: resp.status, text: new TextDecoder('utf-8').decode(buf) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * POST 表单请求（公报专栏翻页：ASP.NET unobtrusive-ajax，GET 忽略 page 参数，
 * 必须带 X-Requested-With 头 + 表单体重发 serial_no/page，否则恒返回第 1 页）
 */
async function postForm(url, body, referer, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        ...UA,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: referer,
      },
      body,
    });
    const buf = await resp.arrayBuffer();
    return { status: resp.status, text: new TextDecoder('utf-8').decode(buf) };
  } finally {
    clearTimeout(t);
  }
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function absUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** 中文数字转阿拉伯（1-999 覆盖批次号场景） */
function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const d = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let rest = s;
  if (rest.includes('百')) {
    const [a, b] = rest.split('百');
    total += (d[a] ?? 1) * 100;
    rest = b ?? '';
  }
  if (rest.includes('十')) {
    const [a, b] = rest.split('十');
    total += (a ? d[a] ?? 0 : 1) * 10 + (b ? d[b] ?? 0 : 0);
  } else if (rest) {
    total += d[rest] ?? 0;
  }
  return total;
}

/** 从案例标题推断案由（粗糙启发式，人工富化时会修正） */
function extractCause(title) {
  const civil = title.match(/([一-龥]{2,20}?(?:纠纷|争议))案?$/);
  if (civil) return civil[1];
  let t = title.replace(/案$/, '');
  if (t.includes('诉')) t = t.split('诉').pop() ?? t;
  // 去匿名化当事人名（如「严某聪」「王某群等」）
  t = t.replace(/^[一-龥]{1,3}某[一-龥]{0,2}(?:等人?)?/, '');
  t = t.replace(/^(?:公司|企业|集团|厂|院|所|中心|局|行|社|站)+/, '');
  return t.length >= 2 && t.length <= 24 ? t : title;
}

/**
 * 解析批次通知页正文中的案例条目（两种官方格式）
 *   行内式：指导案例第251号：四川某化工股份有限公司…案
 *   多行式：「指导案例53号」独立行 → 标题跨行 → （最高人民法院审判委员会讨论通过…
 * 多行式同时尝试提取「关键词」行（a/b/c 形式）。
 */
function parseNoticeCases(lines) {
  const out = []; // {num,title,keywords}
  // 编号头的三种官方排版：「指导案例53号」同行 / 「指导案例第53号」/ 三行拆分「指导案例」「53」「号」
  const headAt = (i) => {
    const m1 = lines[i].match(/^指导案例第?(\d+)号$/);
    if (m1) return { num: Number(m1[1]), next: i + 1 };
    if (
      lines[i] === '指导案例' &&
      /^\d{1,3}$/.test(lines[i + 1] ?? '') &&
      lines[i + 2] === '号'
    ) {
      return { num: Number(lines[i + 1]), next: i + 3 };
    }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^指导(?:性)?案例第?(\d+)号[：:]\s*(.{4,120})$/);
    if (inline && /案$/.test(inline[2].trim())) {
      out.push({ num: Number(inline[1]), title: inline[2].trim(), keywords: [] });
      continue;
    }
    const head = headAt(i);
    if (head) {
      const parts = [];
      let j = head.next;
      while (j < lines.length && parts.join('').length < 90) {
        const l = lines[j];
        if (l.startsWith('（最高人民法院审判委员会') || /^指导案例/.test(l) || l === '关键词') break;
        parts.push(l);
        j++;
      }
      const title = parts.join('');
      if (title.length >= 4 && /案$/.test(title)) {
        let keywords = [];
        const k = lines.indexOf('关键词', j);
        if (k !== -1 && k <= j + 3 && lines[k + 1] && lines[k + 1].length < 60) {
          // 分隔符两种：「民事/金融借款合同/…」或全角空格「刑事   危险驾驶罪   …」
          keywords = lines[k + 1].split(/\/|　+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
        }
        out.push({ num: head.num, title, keywords });
      }
    }
  }
  return out;
}

// ===== 源 1：最高法指导案例（公报网） =====
async function scrapeSpc() {
  const BASE = 'http://gongbao.court.gov.cn';
  const caseMap = new Map(); // num → {num,title,url}
  const notices = []; // {batch,url}

  for (let page = 1; page <= 40; page++) {
    const url = `${BASE}/ArticleList.html?serial_no=al&page=${page}`;
    // 公报网偶发 502/限流，每页最多重试 4 次（递增退避）
    // 注意：该专栏翻页走 POST 表单（GET 的 page 参数被忽略，恒返回第 1 页）
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = await postForm(
          url,
          `serial_no=al&page=${page}`,
          `${BASE}/ArticleList.html?serial_no=al`,
        );
        if (resp.status === 200) {
          r = resp;
          break;
        }
      } catch {
        // 重试
      }
      await sleep(1500 * (attempt + 1));
    }
    if (!r) break;
    const links = [...r.text.matchAll(/<a[^>]+href="(\/Details\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)].map(
      (m) => ({ url: BASE + m[1], text: stripTags(m[2]).trim() }),
    );
    if (links.length === 0) break;
    for (const it of links) {
      // 标题分隔符兼容全角冒号/半角冒号/空格（公报网部分条目无冒号，如「指导性案例254号 厦门某…」）
      const cm = it.text.match(/^指导性案例(\d+)号[：:\s]+(.+)$/);
      if (cm) {
        const num = Number(cm[1]);
        if (!caseMap.has(num)) caseMap.set(num, { num, title: cm[2].trim(), url: it.url });
        continue;
      }
      const nm = it.text.match(/关于发布第([0-9]+|[零一二两三四五六七八九十百]+)批指导性案例的通知/);
      if (nm) notices.push({ batch: cnToNum(nm[1]), url: it.url });
    }
    if (links.length < 25) break; // 末页
    await sleep(600); // 公报网限流较敏感，放缓翻页
  }

  // 补充源：站内检索「指导性案例」（专栏仅含近期 1000 条，老批次通知需检索补齐）
  // 与专栏同属 POST 表单分页；通知页正文含全量案例标题（含全文），据此补 stub
  // 部分老批次通知标题不含「性」字，第二轮用「指导案例」补检
  for (const [kw, maxPage] of [['指导性案例', 8], ['指导案例', 10]]) {
    for (let p = 1; p <= maxPage; p++) {
      const enc = encodeURIComponent(kw);
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await postForm(
          `${BASE}/QueryArticle.html?title=${enc}&page=${p}`,
          `title=${enc}&page=${p}`,
          `${BASE}/QueryArticle.html?title=${enc}`,
        );
        if (resp.status === 200) {
          r = resp;
          break;
        }
      } catch {
        // 重试
      }
      await sleep(1500 * (attempt + 1));
    }
    if (!r) break;
    const links = [...r.text.matchAll(/<a[^>]+href="(\/Details\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)].map(
      (m) => ({ url: BASE + m[1].replace(/\?.*$/, ''), text: stripTags(m[2]).trim() }),
    );
    if (links.length === 0) break;
    for (const it of links) {
      const cm = it.text.match(/^指导(?:性)?案例(\d+)号[：:\s]+(.+)$/);
      if (cm) {
        const num = Number(cm[1]);
        if (!caseMap.has(num)) caseMap.set(num, { num, title: cm[2].trim(), url: it.url });
        continue;
      }
      const nm = it.text.match(/关于发布第([0-9]+|[零一二两三四五六七八九十百]+)批指导性?案例的通知/);
      if (nm) notices.push({ batch: cnToNum(nm[1]), url: it.url });
    }
    if (links.length < 20) break; // 末页
    await sleep(600);
  }
  await sleep(400);
}

// 官方批次区间兜底表：仅补检索始终命不到的批次（固定官方事实）
// 第1批：2011-12-20 发布，指导案例1-4号（上海中原物业诉陶德华居间合同等 4 件）
const BATCH_FALLBACK = new Map([[1, { year: 2011, from: 1, to: 4 }]]);

  // 补充源 2：最高法官网「指导案例」栏目（全量索引，覆盖公报检索缺口如 192-211 区间）
  // 注意：列表长标题可能被官网截断（含 … 或 ...），截断标题不入库（宁缺毋滥）
  {
    const COURT = 'https://www.court.gov.cn';
    const truncatedCourt = []; // {num,url} 标题被截断的条目，事后抓详情页 <title> 补全
    for (let p = 1; p <= 20; p++) {
      const url = p === 1 ? `${COURT}/shenpan/gengduo/77.html` : `${COURT}/shenpan/gengduo/77_${p}.html`;
      let r = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await get(url);
          if (resp.status === 200) {
            r = resp;
            break;
          }
        } catch {
          // 重试
        }
        await sleep(1200 * (attempt + 1));
      }
      if (!r) break;
      const links = [...r.text.matchAll(/<a[^>]+href="([^"]*xiangqing[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/g)].map(
        (m) => ({ url: absUrl(COURT, m[1]), text: stripTags(m[2]).trim() }),
      );
      if (links.length === 0) break;
      for (const it of links) {
        const cm = it.text.match(/^指导性?案例(\d+)号[：:\s]+(.+)$/);
        if (cm) {
          const num = Number(cm[1]);
          const title = cm[2].trim();
          if (!caseMap.has(num)) {
            if (/…|\.{3}/.test(title)) truncatedCourt.push({ num, url: it.url });
            else caseMap.set(num, { num, title, url: it.url });
          }
          continue;
        }
        const nm = it.text.match(/关于发布第([0-9]+|[零一二两三四五六七八九十百]+)批指导性?案例的通知/);
        if (nm) notices.push({ batch: cnToNum(nm[1]), url: it.url });
      }
      if (links.length < 20) break; // 末页
      await sleep(500);
    }

    // 截断标题补全：详情页 <title> 含完整标题（格式「指导性案例N号：标题 - 中华人民共和国最高人民法院」）
    for (const t of truncatedCourt) {
      if (caseMap.has(t.num)) continue;
      try {
        const r = await get(t.url);
        if (r.status === 200) {
          const tm = r.text.match(
            /<title>指导性?案例\d+号[：:]\s*([\s\S]+?)\s*-\s*中华人民共和国最高人民法院<\/title>/,
          );
          const title = tm ? tm[1].replace(/\s+/g, '').trim() : '';
          if (title.length >= 4 && /案$/.test(title) && !/…|\.{3}/.test(title)) {
            caseMap.set(t.num, { num: t.num, title, url: t.url });
          }
        }
      } catch {
        // 单件失败容忍
      }
      await sleep(400);
    }
  }

  // 静态补充通知：公报检索间歇命不到的批次（已人工核实官方 URL）
  // 第1批通知（公报网）：覆盖指导案例1-4号
  notices.push({ batch: 1, url: 'http://gongbao.court.gov.cn/Details/c796c701e6f036c15e3272b478c0ec.html' });

  // 批次去重（专栏 + 检索可能重复命中同一通知）
  const uniqNotices = [...new Map(notices.map((n) => [n.batch, n])).values()];

  // 批次通知页 → 发布年份 + 编号区间（正文行缓存供标题解析复用）
  const batchInfo = new Map(BATCH_FALLBACK); // batch → {year, from, to}
  for (const n of uniqNotices) {
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await get(n.url);
        if (resp.status === 200) {
          r = resp;
          break;
        }
      } catch {
        // 重试
      }
      await sleep(1200 * (attempt + 1));
    }
    if (r) {
        const text = stripTags(r.text).replace(/\s+/g, ' ');
        const dateM = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        const rangeM = text.match(/指导性?案例\s*(\d+)\s*[-—–~～]\s*(\d+)\s*号/);
        batchInfo.set(n.batch, {
          year: dateM ? Number(dateM[1]) : null,
          from: rangeM ? Number(rangeM[1]) : null,
          to: rangeM ? Number(rangeM[2]) : null,
        });
        n._lines = r.text
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, '\n')
          .replace(/&nbsp;/g, ' ')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
    }
    // 三次重试仍失败则容忍，后续按未映射处理
    await sleep(400);
  }

  // 通知页正文解析：补专栏/检索未覆盖的案例标题（老批次全文发布在通知页）
  for (const n of uniqNotices) {
    if (!n._lines) continue;
    for (const c of parseNoticeCases(n._lines)) {
      if (!caseMap.has(c.num)) {
        caseMap.set(c.num, { num: c.num, title: c.title, url: n.url, keywords: c.keywords });
      }
    }
  }

  const cases = [];
  for (const c of caseMap.values()) {
    let batch = null;
    let year = null;
    for (const [b, info] of batchInfo) {
      if (info.from != null && c.num >= info.from && c.num <= info.to) {
        batch = b;
        year = info.year;
      }
    }
    cases.push({
      id: `spc-${c.num}`,
      source: 'spc',
      code: `指导案例第${c.num}号`,
      batch: batch ? `第${batch}批指导性案例（${year ?? '待核'}）` : '批次待核验',
      year: year ?? 0,
      title: c.title,
      cause: extractCause(c.title),
      keywords: c.keywords ?? [],
      gist: '要旨整理中，以官方发布原文为准。',
      practicePoints: [],
      relatedArticleIds: [],
      officialUrl: c.url,
      stub: true,
    });
  }
  return { cases, batches: batchInfo.size };
}

// ===== 源 2：最高检检例 =====
async function scrapeSpp() {
  const BASE = 'https://www.spp.gov.cn';
  const batches = []; // {label,url,date}

  for (let p = 0; p < 20; p++) {
    const url = p === 0 ? `${BASE}/spp/jczdal/index.shtml` : `${BASE}/spp/jczdal/index_${p}.shtml`;
    let r;
    try {
      r = await get(url);
    } catch {
      break;
    }
    if (r.status !== 200) break;
    const items = [
      ...r.text.matchAll(
        /<li><a href="([^"]+)"[^>]*>(第[0-9零一二两三四五六七八九十百]+批指导性案例)<\/a><span>(\d{4}-\d{2}-\d{2})<\/span><\/li>/g,
      ),
    ];
    if (items.length === 0) break;
    for (const m of items) batches.push({ label: m[2], url: absUrl(url, m[1]), date: m[3] });
    await sleep(SLEEP_MS);
  }

  const cases = [];
  const seen = new Set();
  for (const b of batches) {
    try {
      const r = await get(b.url);
      if (r.status !== 200) continue;
      const text = stripTags(r.text);
      // 标题可能含空格、与编号间可能有空白；限定不换行防止跨段串扰
      const re = /([^\n（）()【】]{4,80}?)\s*[（(]检例第(\d+)号[)）]/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const num = Number(m[2]);
        if (seen.has(num)) continue;
        let title = m[1];
        // 截掉上一句残留（标题本身不含句号/换行）
        if (title.includes('。')) title = title.split('。').pop();
        if (title.includes('\n')) title = title.split('\n').pop();
        title = title.replace(/^[：:、，,.\s"“”]+/, '').trim();
        // 案例标题均以「案」结尾，否则视为误捕获的元信息（会议名称等）
        if (title.length < 4 || !title.endsWith('案')) continue;
        seen.add(num);
        cases.push({
          id: `spp-${num}`,
          source: 'spp',
          code: `检例第${num}号`,
          batch: `${b.label}（${b.date.slice(0, 4)}）`,
          year: Number(b.date.slice(0, 4)),
          title,
          cause: extractCause(title),
          keywords: [],
          gist: '要旨整理中，以官方发布原文为准。',
          practicePoints: [],
          relatedArticleIds: [],
          officialUrl: b.url,
          stub: true,
        });
      }
    } catch {
      // 单批次失败容忍
    }
    await sleep(SLEEP_MS);
  }
  return { cases, batches: batches.length };
}

// ===== 源 3：最高法司法解释 → 法律更新 =====
async function scrapeSfjs() {
  const BASE = 'https://www.court.gov.cn';
  const updates = [];
  for (let p = 1; p <= 20; p++) {
    const url = p === 1 ? `${BASE}/fabu/gengduo/16.html` : `${BASE}/fabu/gengduo/16_${p}.html`;
    let r;
    try {
      r = await get(url);
    } catch {
      break;
    }
    if (r.status !== 200) break;
    const items = [
      ...r.text.matchAll(
        /<li>\s*<a title="([^"]+)"[^>]+href="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<i class="date">(\d{4}-\d{2}-\d{2})<\/i>\s*<\/li>/g,
      ),
    ];
    if (items.length === 0) break;
    for (const m of items) {
      const idM = m[2].match(/(\d+)\.html/);
      const link = absUrl(BASE, m[2]);
      updates.push({
        id: `sfjs-${idM ? idM[1] : updates.length}`,
        priority: 'medium',
        type: 'interpretation',
        title: m[1],
        date: m[3],
        authority: '最高人民法院',
        description: `（自动收录）最高人民法院司法解释/司法文件，官方原文：${link}`,
        keyChanges: [],
        examRelevance: '新发布司法解释/司法文件，请关注后续解读与考点分析。',
        affectedSubjects: [],
      });
    }
    await sleep(SLEEP_MS);
  }
  return { updates };
}

// ===== 源 4：司法部典型案例（best-effort） =====
async function scrapeMoj() {
  const BASE = 'https://www.moj.gov.cn';
  const cases = [];
  for (let p = 0; p < 6; p++) {
    const url =
      p === 0 ? `${BASE}/pub/sfbgw/gwxw/xwyw/` : `${BASE}/pub/sfbgw/gwxw/xwyw/index_${p}.html`;
    let r;
    try {
      r = await get(url);
    } catch {
      break;
    }
    if (r.status !== 200) break;
    const items = [
      ...r.text.matchAll(/<a[^>]+href="([^"]*t(\d{4})(\d{2})(\d{2})_(\d+)\.html)"[^>]*>([^<]*典型案例[^<]*)<\/a>/g),
    ];
    for (const m of items) {
      const id = `moj-auto-${m[5]}`;
      if (cases.some((c) => c.id === id)) continue;
      cases.push({
        id,
        source: 'moj',
        code: `司法部典型案例（${m[2]}）`,
        batch: `${m[2]}年度典型案例`,
        year: Number(m[2]),
        title: m[6].trim(),
        cause: '典型案例',
        keywords: [],
        gist: '要旨整理中，以官方发布原文为准。',
        practicePoints: [],
        relatedArticleIds: [],
        officialUrl: absUrl(url, m[1]),
        stub: true,
      });
    }
    await sleep(200);
  }
  return { cases };
}

// ===== 应用内置富化数据快照（仅 monorepo 本地可用） =====
async function buildEnrichedSnapshot() {
  const appRoot = resolve(REPO_ROOT, '..', 'fatu');
  const entry = join(appRoot, 'src', 'data', 'guidingCases', 'index.ts');
  const esbuildMain = join(appRoot, 'node_modules', 'esbuild', 'lib', 'main.js');
  if (!existsSync(entry) || !existsSync(esbuildMain)) return [];
  try {
    const esbuild = await import(pathToFileURL(esbuildMain).href);
    const result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      logLevel: 'silent',
    });
    const code = result.outputFiles[0].text;
    const mod = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
    const list = mod.GUIDING_CASES ?? [];
    return list.map((c) => ({ ...c, stub: false }));
  } catch (e) {
    console.warn(`  [snapshot] 快照生成失败（跳过）：${e.message}`);
    return [];
  }
}

/** 读取 seeds/enriched-snapshot.json（feed 仓库模式下由本地生成后提交） */
function loadSnapshotSeed() {
  const p = join(REPO_ROOT, 'seeds', 'enriched-snapshot.json');
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// ===== 合并 =====
function loadPrevFeed(file) {
  const p = join(outDir, file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 案例合并：非 stub 永不降级；stub 之间新抓取优先；旧条目缺失保留 */
function mergeCases(scraped, prevCases, snapshots) {
  const map = new Map();
  for (const c of snapshots) map.set(c.id, c);
  for (const p of prevCases) {
    const cur = map.get(p.id);
    if (!cur || (cur.stub && !p.stub) || (!cur.stub && !p.stub)) map.set(p.id, p);
  }
  for (const c of scraped) {
    const cur = map.get(c.id);
    if (!cur) {
      map.set(c.id, c);
    } else if (cur.stub) {
      if (!c.year && cur.year) c.year = cur.year;
      if (c.batch === '批次待核验' && cur.batch !== '批次待核验') c.batch = cur.batch;
      map.set(c.id, c);
    }
  }
  return [...map.values()];
}

/** 法律更新合并：按 id，先传入的源优先（人工编辑永不覆盖），新 id 补入 */
function mergeUpdates(...sources) {
  const map = new Map();
  for (const list of sources) {
    for (const u of list) if (!map.has(u.id)) map.set(u.id, u);
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** 读取应用内置兜底 legalUpdates.json（裸数组，--out 模式下作为富化来源） */
function loadBundledUpdates() {
  const p = join(outDir, 'legalUpdates.json');
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function bumpVersion(prevMeta) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}.${String(now.getUTCMonth() + 1).padStart(2, '0')}.${String(
    now.getUTCDate(),
  ).padStart(2, '0')}`;
  let seq = 1;
  if (prevMeta?.feedVersion?.startsWith(stamp)) {
    seq = Number(prevMeta.feedVersion.split('-')[1] ?? 0) + 1;
  }
  return {
    feedVersion: `${stamp}-${seq}`,
    generatedAt: now.toISOString(),
    source: 'fatu-feed pipeline（最高人民法院/最高人民检察院/司法部官方发布页）',
  };
}

// ===== 主流程 =====
console.log('== 法途内容 feed 抓取 ==');
console.log(`输出目录: ${outDir}`);
mkdirSync(outDir, { recursive: true });

const prevCases = loadPrevFeed('guiding-cases-feed.json');
const prevUpdates = loadPrevFeed('legal-updates-feed.json');

// 快照：本地 monorepo 实时生成；feed 仓库读 seeds 文件
let snapshot = await buildEnrichedSnapshot();
if (snapshot.length === 0) snapshot = loadSnapshotSeed();
console.log(`富化快照: ${snapshot.length} 件`);

const [spc, spp, sfjs, moj] = await Promise.all([
  scrapeSpc().catch((e) => ({ cases: [], error: e.message })),
  scrapeSpp().catch((e) => ({ cases: [], error: e.message })),
  scrapeSfjs().catch((e) => ({ updates: [], error: e.message })),
  scrapeMoj().catch((e) => ({ cases: [], error: e.message })),
]);

console.log(`SPC 指导案例: ${spc.cases.length} 件（批次通知 ${spc.batches ?? 0}）${spc.error ? ' [错误] ' + spc.error : ''}`);
console.log(`SPP 检例:     ${spp.cases.length} 件（批次 ${spp.batches ?? 0}）${spp.error ? ' [错误] ' + spp.error : ''}`);
console.log(`司法解释:     ${sfjs.updates.length} 条${sfjs.error ? ' [错误] ' + sfjs.error : ''}`);
console.log(`MOJ 典型案例: ${moj.cases.length} 件（best-effort）${moj.error ? ' [错误] ' + moj.error : ''}`);

// ===== 安全自检：任一核心源低于上次 90% → 该源回退沿用上次 feed（降级，不中止整轮）=====
// 背景：官方站点可能按机房 IP 封禁（如 GitHub Actions 跑 SPP 返回 0），
// 单源抖动不应阻塞其他源的正常更新；merge 机制会保留富化条目。
const GUARDS = [
  ['spc', spc.cases.length, (prevCases?.cases ?? []).filter((c) => c.source === 'spc' && c.stub).length],
  ['spp', spp.cases.length, (prevCases?.cases ?? []).filter((c) => c.source === 'spp' && c.stub).length],
  ['sfjs', sfjs.updates.length, (prevUpdates?.updates ?? []).filter((u) => u.id.startsWith('sfjs-')).length],
];
for (const [name, now, before] of GUARDS) {
  if (before > 0 && now < before * 0.9) {
    if (name === 'spc') spc.cases = (prevCases?.cases ?? []).filter((c) => c.source === 'spc');
    if (name === 'spp') spp.cases = (prevCases?.cases ?? []).filter((c) => c.source === 'spp');
    if (name === 'sfjs') sfjs.updates = (prevUpdates?.updates ?? []).filter((u) => u.id.startsWith('sfjs-'));
    console.warn(`自检警告：源 ${name} 本次 ${now} 条 < 上次 ${before} 条的 90%，该源回退沿用上次 feed 条目`);
  }
}
// 首次运行底线：核心源全空则视为网络故障，中止
if (spc.cases.length === 0 && spp.cases.length === 0 && sfjs.updates.length === 0 && !prevCases && !prevUpdates) {
  console.error('自检失败：所有核心源均无数据且无上次的 feed，已中止');
  process.exit(1);
}

const cases = mergeCases(
  [...spc.cases, ...spp.cases, ...moj.cases],
  prevCases?.cases ?? [],
  snapshot,
);
// 合并优先级：上次 feed（含人工编辑）> 应用内置富化 > 本次抓取（新 id）

// 案件事实 overlay：seeds/spc-facts.json（AI 精读富化层，随仓库分发，重抓不丢）
// 结构 { "spc-61": { facts, outcome } }，按 id attach 到 SPC 条目
let factsAttached = 0;
try {
  const factsPath = join(REPO_ROOT, 'seeds', 'spc-facts.json');
  if (existsSync(factsPath)) {
    const factsOverlay = JSON.parse(readFileSync(factsPath, 'utf-8'));
    for (const c of cases) {
      const o = factsOverlay[c.id];
      if (!o) continue;
      if (o.facts) c.facts = o.facts;
      if (o.outcome) c.outcome = o.outcome;
      factsAttached++;
    }
  }
} catch (e) {
  console.warn('spc-facts overlay 加载失败（容忍，不阻塞）:', e?.message ?? e);
}
if (factsAttached > 0) console.log(`案件事实 overlay: ${factsAttached} 件已附加`);
const bundledUpdates = loadBundledUpdates();
const updates = mergeUpdates(prevUpdates?.updates ?? [], bundledUpdates, sfjs.updates);

const casesFeed = { meta: bumpVersion(prevCases?.meta), cases };
const updatesFeed = { meta: bumpVersion(prevUpdates?.meta), updates };

writeFileSync(
  join(outDir, 'guiding-cases-feed.json'),
  JSON.stringify(casesFeed, null, pretty ? 2 : 0),
);
writeFileSync(
  join(outDir, 'legal-updates-feed.json'),
  JSON.stringify(updatesFeed, null, pretty ? 2 : 0),
);
// 应用内置兜底（仅 --out 模式，即 fatu/public/data）
if (outDir !== REPO_ROOT) {
  writeFileSync(join(outDir, 'legalUpdates.json'), JSON.stringify(updates, null, pretty ? 2 : 0));
  // 同步刷新富化快照种子（供 feed 仓库提交）
  if (snapshot.length > 0) {
    mkdirSync(join(REPO_ROOT, 'seeds'), { recursive: true });
    writeFileSync(
      join(REPO_ROOT, 'seeds', 'enriched-snapshot.json'),
      JSON.stringify(snapshot, null, pretty ? 2 : 0),
    );
  }
}

console.log(`\n指导案例 feed: ${cases.length} 件（版本 ${casesFeed.meta.feedVersion}）`);
console.log(`法律更新 feed: ${updates.length} 条（版本 ${updatesFeed.meta.feedVersion}）`);
console.log('完成。');
