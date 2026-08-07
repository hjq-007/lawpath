#!/usr/bin/env node
/**
 * extract-spp-fulltext.mjs —— SPP 检例官方全文提取
 *
 * 输出：seeds/spp-fulltext.json
 *   { "spp-1": { num, title, url, batch, gistText, factsText, processText, significanceText, fullText } }
 *
 * 机制：
 *   1. 抓取检例栏目分页（index[_N].shtml）收集全部批次链接
 *      —— 注意：栏目第 2 页（index_1）为空页，历史批次（第 1-33 批）在第 3-4 页，
 *         必须容忍空页继续翻页（与 scrape.mjs scrapeSpp 同一逻辑）
 *   2. 逐批次抓详情页，按「标题 + （检例第N号）」切分案例块
 *   3. 块内按官方小节标题归入：【要旨】→ gistText、【基本案情】→ factsText、
 *      【诉讼过程/检察机关履职情况(过程)】→ processText、【指导意义】→ significanceText
 *   4. 覆盖率 < 85% 退出码 1（站点抖动时保护已有输出）
 *
 * 用法：node extract-spp-fulltext.mjs [--limit N] [--only 131,132,...]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..');
const OUT_FILE = join(REPO_ROOT, 'seeds', 'spp-fulltext.json');

const args = process.argv.slice(2);
let limit = Infinity;
let onlyNums = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
  if (args[i] === '--only' && args[i + 1]) onlyNums = new Set(args[++i].split(',').map(Number));
}

const UA = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
};
const SLEEP_MS = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, timeout = 20000) {
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

const toLines = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
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

// ===== 1. 收集批次链接（容忍空页） =====
const BASE = 'https://www.spp.gov.cn';
async function collectBatches() {
  const batches = []; // {label,url,date}
  const seen = new Set();
  let emptyStreak = 0;
  for (let p = 0; p < 8; p++) {
    const url = p === 0 ? `${BASE}/spp/jczdal/index.shtml` : `${BASE}/spp/jczdal/index_${p}.shtml`;
    let r;
    try {
      r = await get(url);
    } catch {
      emptyStreak++;
      if (emptyStreak >= 2) break;
      continue;
    }
    if (r.status !== 200) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
      continue;
    }
    const items = [
      ...r.text.matchAll(
        /<li><a href="([^"]+)"[^>]*>(第[0-9零一二两三四五六七八九十百]+批指导性案例)<\/a><span>(\d{4}-\d{2}-\d{2})<\/span><\/li>/g,
      ),
    ];
    if (items.length === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) break;
      continue;
    }
    emptyStreak = 0;
    for (const m of items) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      batches.push({ label: m[2], url: absUrl(url, m[1]), date: m[3] });
    }
    await sleep(SLEEP_MS);
  }
  return batches;
}

// ===== 2. 批次页切块 =====
const SECTION_MAP = [
  { re: /^【要旨】/, key: 'gistText' },
  { re: /^【基本案情】/, key: 'factsText' },
  { re: /^【诉讼过程】/, key: 'processText' },
  { re: /^【检察机关履职(情况|过程)】/, key: 'processText' },
  { re: /^【指导意义】/, key: 'significanceText' },
  { re: /^【关键词】/, key: 'keywordsLine' },
  { re: /^【相关规定】/, key: 'rulesText' },
];

function parseBatchPage(lines, batchUrl, batchLabel) {
  // 定位案例头：「（检例第N号）」独立行，其上一行为标题
  const heads = []; // {num, titleLineIdx}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^[（(]检例第(\d+)号[)）]\s*$/);
    if (m && i > 0) {
      const title = lines[i - 1];
      // 标题不应是小节标题或导航残留
      if (title.length >= 4 && title.length <= 80 && !title.startsWith('【')) {
        heads.push({ num: Number(m[1]), titleIdx: i - 1, title });
      }
    }
  }
  const cases = [];
  for (let h = 0; h < heads.length; h++) {
    const start = heads[h].titleIdx;
    const end = h + 1 < heads.length ? heads[h + 1].titleIdx : lines.length;
    const block = lines.slice(start, end);
    const out = {
      num: heads[h].num,
      title: heads[h].title,
      url: batchUrl,
      batch: batchLabel,
      gistText: '',
      factsText: '',
      processText: '',
      significanceText: '',
      fullText: '',
    };
    const buckets = { gistText: [], factsText: [], processText: [], significanceText: [], rulesText: [] };
    let current = null;
    // 跳过前两行（标题 + 编号行）
    for (const line of block.slice(2)) {
      if (/^\[责任编辑/.test(line) || /^相关新闻/.test(line) || /^相关链接/.test(line)) break;
      const sec = SECTION_MAP.find((s) => s.re.test(line));
      if (sec) {
        current = sec.key === 'keywordsLine' ? null : sec.key;
        // 小节头同行可能带内容
        const rest = line.replace(/^【[^】]+】/, '').trim();
        if (current && rest) buckets[current].push(rest);
        continue;
      }
      if (current && buckets[current]) buckets[current].push(line);
    }
    out.gistText = buckets.gistText.join('\n');
    out.factsText = buckets.factsText.join('\n');
    out.processText = buckets.processText.join('\n');
    out.significanceText = buckets.significanceText.join('\n');
    out.fullText = block.slice(2).join('\n').slice(0, 6000);
    cases.push(out);
  }
  return cases;
}

// ===== 3. 主流程 =====
console.log('== SPP 检例全文提取 ==');
const batches = await collectBatches();
console.log(`批次链接: ${batches.length} 个`);

// 断点续跑：已有输出先加载
let result = {};
if (existsSync(OUT_FILE)) {
  try {
    result = JSON.parse(readFileSync(OUT_FILE, 'utf-8'));
    console.log(`已有输出: ${Object.keys(result).length} 件（增量合并）`);
  } catch {
    result = {};
  }
}

let fetched = 0;
let parsed = 0;
for (const b of batches) {
  if (fetched >= limit) break;
  let r = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await get(b.url);
      if (r.status === 200) break;
    } catch {
      // 重试
    }
    await sleep(1000);
  }
  if (!r || r.status !== 200) {
    console.warn(`  批次抓取失败: ${b.label}`);
    continue;
  }
  fetched++;
  const lines = toLines(r.text);
  const cases = parseBatchPage(lines, b.url, `${b.label}（${b.date.slice(0, 4)}）`);
  for (const c of cases) {
    if (onlyNums && !onlyNums.has(c.num)) continue;
    result[`spp-${c.num}`] = c;
    parsed++;
  }
  console.log(`  ${b.label}: 解析 ${cases.length} 件`);
  await sleep(SLEEP_MS);
}

// 覆盖率自检：已有 + 新增应覆盖 feed 中 SPP 条目数的 85%
let expected = 0;
const feedPath = join(REPO_ROOT, 'guiding-cases-feed.json');
if (existsSync(feedPath)) {
  try {
    const feed = JSON.parse(readFileSync(feedPath, 'utf-8'));
    expected = (feed.cases ?? []).filter((c) => c.source === 'spp').length;
  } catch {
    expected = 0;
  }
}
const total = Object.keys(result).length;
console.log(`\n合计: ${total} 件（本次新解析 ${parsed} 件）`);
mkdirSync(join(REPO_ROOT, 'seeds'), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(result, null, 2));
console.log(`已写入 ${OUT_FILE}`);

if (expected > 0 && total < expected * 0.85) {
  console.error(`覆盖率不足: ${total}/${expected} < 85%`);
  process.exit(1);
}
console.log('完成。');
