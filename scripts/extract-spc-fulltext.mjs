#!/usr/bin/env node
/**
 * extract-spc-fulltext.mjs —— SPC 指导案例官方全文提取
 *
 * 输入：应用或仓库的 guiding-cases-feed.json（279 个 SPC 条目）
 * 输出：seeds/spc-fulltext.json  { "spc-61": { num, title, url, factsText, outcomeText, fullText? } }
 *
 * 机制：
 *   1. 重建 编号→详情页 URL 映射（feed officialUrl 138 条 + 公报专栏 POST 翻页
 *      + QueryArticle 检索 + court.gov.cn 栏目，逻辑与 scrape.mjs 一致）
 *   2. 逐件抓详情页，按官方小节标题切分：「基本案情」→ factsText、
 *      「裁判结果/执行结果/处理结果」→ outcomeText；无小节的老批次存 fullText 兜底
 *   3. 覆盖率 < 90% 退出码 1（站点抖动时保护已有输出）
 *
 * 用法：node extract-spc-fulltext.mjs [--feed <path>] [--limit N]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const OUT_FILE = join(REPO_ROOT, 'seeds', 'spc-fulltext.json');

const args = process.argv.slice(2);
let feedPath = join(REPO_ROOT, 'guiding-cases-feed.json');
let limit = Infinity;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--feed' && args[i + 1]) feedPath = args[++i];
  if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
}

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, timeout = 15000) {
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

async function postForm(url, body, referer, timeout = 15000) {
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

const stripTags = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');

const toLines = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

const absUrl = (base, href) => {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
};

// ===== 1. 重建 编号→URL 映射 =====
const BASE = 'http://gongbao.court.gov.cn';
const caseMap = new Map(); // num → url

async function buildUrlMap() {
  // 专栏 POST 翻页（GET 忽略 page 参数）
  for (let page = 1; page <= 40; page++) {
    let r = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const resp = await postForm(
          `${BASE}/ArticleList.html?serial_no=al&page=${page}`,
          `serial_no=al&page=${page}`,
          `${BASE}/ArticleList.html?serial_no=al`,
        );
        if (resp.status === 200) { r = resp; break; }
      } catch { /* 重试 */ }
      await sleep(1500 * (attempt + 1));
    }
    if (!r) break;
    const links = [...r.text.matchAll(/<a[^>]+href="(\/Details\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)]
      .map((m) => ({ url: BASE + m[1], text: stripTags(m[2]).trim() }));
    if (links.length === 0) break;
    for (const it of links) {
      const cm = it.text.match(/^指导性案例(\d+)号[：:\s]+(.+)$/);
      if (cm && !caseMap.has(Number(cm[1]))) caseMap.set(Number(cm[1]), it.url);
    }
    if (links.length < 25) break;
    await sleep(600);
  }

  // QueryArticle 检索双关键词
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
          if (resp.status === 200) { r = resp; break; }
        } catch { /* 重试 */ }
        await sleep(1500 * (attempt + 1));
      }
      if (!r) break;
      const links = [...r.text.matchAll(/<a[^>]+href="(\/Details\/[^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/g)]
        .map((m) => ({ url: BASE + m[1].replace(/\?.*$/, ''), text: stripTags(m[2]).trim() }));
      if (links.length === 0) break;
      for (const it of links) {
        const cm = it.text.match(/^指导(?:性)?案例(\d+)号[：:\s]+(.+)$/);
        if (cm && !caseMap.has(Number(cm[1]))) caseMap.set(Number(cm[1]), it.url);
      }
      if (links.length < 20) break;
      await sleep(600);
    }
  }

  // court.gov.cn 栏目（全量索引）
  const COURT = 'https://www.court.gov.cn';
  for (let p = 1; p <= 20; p++) {
    const url = p === 1 ? `${COURT}/shenpan/gengduo/77.html` : `${COURT}/shenpan/gengduo/77_${p}.html`;
    let r = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await get(url);
        if (resp.status === 200) { r = resp; break; }
      } catch { /* 重试 */ }
      await sleep(1200 * (attempt + 1));
    }
    if (!r) break;
    const links = [...r.text.matchAll(/<a[^>]+href="([^"]*xiangqing[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/g)]
      .map((m) => ({ url: absUrl(COURT, m[1]), text: stripTags(m[2]).trim() }));
    if (links.length === 0) break;
    for (const it of links) {
      const cm = it.text.match(/^指导性?案例(\d+)号[：:\s]/);
      if (cm && !caseMap.has(Number(cm[1]))) caseMap.set(Number(cm[1]), it.url);
    }
    if (links.length < 20) break;
    await sleep(500);
  }
}

// ===== 2. 正文小节切分 =====
const FACT_HEAD = /^(基本案情|案情|诉讼经过|执行情况)$/;
const RESULT_HEAD = /^(裁判结果|执行结果|处理结果|审理结果)$/;
const AFTER_RESULT = /^(裁判理由|执行理由|检察理由|审理理由|相关法条|法律声明)/;
const FOOTER = /^(法律声明|联系我们|使用帮助|中华人民共和国最高人民法院\s*版权所有)/;

function sliceSections(lines) {
  const fi = lines.findIndex((l) => FACT_HEAD.test(l));
  if (fi === -1) return { factsText: '', outcomeText: '' };
  let ri = lines.findIndex((l, i) => i > fi && RESULT_HEAD.test(l));
  const factsEnd = ri === -1 ? lines.findIndex((l, i) => i > fi && AFTER_RESULT.test(l)) : ri;
  const factsText = lines.slice(fi + 1, factsEnd === -1 ? undefined : factsEnd).join('\n');
  let outcomeText = '';
  if (ri !== -1) {
    let ai = lines.findIndex((l, i) => i > ri && AFTER_RESULT.test(l));
    outcomeText = lines.slice(ri + 1, ai === -1 ? undefined : ai).join('\n');
  }
  return { factsText, outcomeText };
}

/** 通知页正文按编号头切出本案段落（三排版兼容，老批次全文在通知页） */
function sliceFromNotice(lines, num) {
  const headAt = (i) => {
    const m1 = lines[i].match(/^指导案例第?(\d+)号$/);
    if (m1) return Number(m1[1]);
    if (lines[i] === '指导案例' && /^\d{1,3}$/.test(lines[i + 1] ?? '') && lines[i + 2] === '号')
      return Number(lines[i + 1]);
    return null;
  };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headAt(i) === num) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (headAt(j) !== null || FOOTER.test(lines[j])) { end = j; break; }
  }
  return lines.slice(start, end);
}

// ===== 3. 主流程 =====
const feed = JSON.parse(readFileSync(feedPath, 'utf-8'));
const spcAll = feed.cases.filter((c) => c.source === 'spc');
console.log(`SPC 条目: ${spcAll.length}`);

// feed 自带 URL 先入库
for (const c of spcAll) {
  if (c.officialUrl) {
    const num = Number(c.id.replace('spc-', ''));
    if (!caseMap.has(num)) caseMap.set(num, c.officialUrl);
  }
}
console.log(`feed officialUrl 提供: ${caseMap.size}`);
await buildUrlMap();
console.log(`URL 映射重建后: ${caseMap.size}`);

const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf-8')) : {};
const out = { ...prev };
let done = 0;
let failed = [];
const targets = spcAll.slice(0, limit === Infinity ? undefined : limit);

for (const c of targets) {
  const num = Number(c.id.replace('spc-', ''));
  if (out[c.id]?.factsText && out[c.id].factsText.length > 50) { done++; continue; } // 增量：已就绪跳过
  const url = caseMap.get(num) ?? c.officialUrl;
  if (!url) { failed.push(`${c.id}(无URL)`); continue; }
  let lines = null;
  for (let attempt = 0; attempt < 3 && !lines; attempt++) {
    try {
      const r = await get(url);
      if (r.status === 200) lines = toLines(r.text);
    } catch { /* 重试 */ }
    if (!lines) await sleep(1200 * (attempt + 1));
  }
  if (!lines) { failed.push(`${c.id}(抓取失败)`); await sleep(400); continue; }

  // 通知页（多案同页）按编号切出本案；独页直接全页
  const isSharedNotice = spcAll.some((o) => o.id !== c.id && (caseMap.get(Number(o.id.replace('spc-', ''))) ?? o.officialUrl) === url);
  const body = isSharedNotice ? sliceFromNotice(lines, num) : lines;
  if (!body) { failed.push(`${c.id}(通知页未定位)`); await sleep(400); continue; }
  const { factsText, outcomeText } = sliceSections(body);
  const entry = { num, title: c.title, url, factsText, outcomeText };
  if (!factsText) entry.fullText = body.filter((l) => !FOOTER.test(l)).join('\n').slice(0, 12000);
  out[c.id] = entry;
  if (factsText || entry.fullText) done++;
  else failed.push(`${c.id}(无正文)`);
  await sleep(250);
}

writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
const total = Object.keys(out).length;
const ready = Object.values(out).filter((e) => e.factsText || e.fullText).length;
console.log(`\n完成: 本轮新就绪 ${done}，累计 ${ready}/${spcAll.length}（输出 ${OUT_FILE}）`);
if (failed.length) console.log(`未就绪 ${failed.length}: ${failed.slice(0, 20).join(', ')}${failed.length > 20 ? ' …' : ''}`);
if (ready < targets.length * 0.9) {
  console.error('自检失败：覆盖率 < 90%');
  process.exit(1);
}
