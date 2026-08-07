# fatu-feed —— 法途内容自动更新 feed 仓库

本仓库是法途平台的内容分发通道：GitHub Actions 每日抓取官方发布页
（最高人民法院公报网 / 最高人民检察院 / 最高人民法院司法解释栏目 / 司法部），
生成 feed JSON 提交回本仓库；平台端经 jsdelivr CDN 拉取并与内置数据合并，
实现「不重新发版也能更新指导案例与法律更新」。

## 产物

| 文件 | 内容 |
| --- | --- |
| `guiding-cases-feed.json` | 指导案例全量（SPC/SPP/MOJ），新条目为「要旨整理中」占位 |
| `legal-updates-feed.json` | 法律更新（司法解释等），自动收录条目带官方原文链接 |
| `seeds/enriched-snapshot.json` | 人工富化数据快照（由主项目生成后提交，可选） |

## 部署（一次性，三步）

1. 在 GitHub 新建仓库（如 `你的用户名/fatu-feed`，Public），把本目录全部文件提交进去。
2. 仓库页 → Actions → 启用 workflow「update-content-feed」；
   点「Run workflow」手动跑第一次，确认产出两个 feed JSON。
3. 回到法途主项目，二选一配置仓库地址：
   - 改 `fatu/src/engine/contentSyncConfig.ts` 的 `DEFAULT_FEED_OWNER` / `DEFAULT_FEED_REPO`；或
   - 浏览器控制台执行
     `localStorage.setItem('fatu-feed-override', '{"owner":"你的用户名","repo":"fatu-feed"}')`

之后每天自动更新；平台端启动即同步 + 每 24 小时后台检查。

## 手动富化新案例（可选）

自动抓取的条目 `stub: true`（要旨整理中）。要补写要旨：

1. 在主项目 `fatu/src/data/guidingCases/` 对应年份文件中补写完整条目
   （gist / practicePoints / relatedArticleIds）；
2. 运行 `npm run sync:content` 重新生成 `seeds/enriched-snapshot.json` 并提交本仓库；
   或直接编辑本仓库 `guiding-cases-feed.json` 中对应条目并去掉 `stub` 标记。

合并规则保证：富化条目永远不会被自动抓取覆盖。

## 整理规范（每件案例必须经过整理，不是简单贴链接）

### 指导案例整理模板

| 字段 | 要求 |
| --- | --- |
| `facts` | 案件事实 200-400 字：只述事实（行为主线 / 关键时间 / 涉案金额与证据 / 程序进展），不作法律评价 |
| `outcome` | 裁判结果 ≤80 字：判决主文概括（罪名 / 刑期 / 民事责任承担） |
| `gist` | 要旨：官方「裁判要旨 / 要旨」的准确概括，保留规范要点 |
| `practicePoints` | 实务要点 3-5 条：对备考与实务的可操作提炼 |
| `keywords` | 官方关键词为准 |
| `relatedArticleIds` | 关联法条 ID，写入前必须用主项目法条库 grep 验证存在（如 `criminal-20`） |

### 精读作者层（随仓库分发，重抓不丢）

| 文件 | 结构 | 说明 |
| --- | --- | --- |
| `seeds/spc-fulltext.json` | `{ "spc-61": { factsText, outcomeText, ... } }` | SPC 官方全文提取（精读素材库），由 `extract-spc-fulltext.mjs` 生成 |
| `seeds/spc-facts.json` | `{ "spc-61": { facts, outcome } }` | SPC 人工精读 overlay，scrape 时按 id attach |
| `seeds/spp-fulltext.json` | `{ "spp-1": { gistText, factsText, processText, significanceText, ... } }` | SPP 检例官方全文提取（精读素材库），由 `extract-spp-fulltext.mjs` 生成 |
| `seeds/spp-facts.json` | `{ "spp-1": { facts, outcome, gist?, practicePoints?, keywords?, relatedArticleIds? } }` | SPP 人工精读 overlay；含 `gist` 时自动解除 stub |

### 法律更新整理模板（精编条目）

- `keyChanges`：关键变更要点 3-5 条；`affectedSubjects`：影响科目（法考八大科口径）
- `studyNotes` 五段式：`background` 背景说明 / `oldRule` 旧规要点 / `newRule` 新规要点 / `comparison` 新旧对比与实务影响 / `examFocus` 考点精析
- 自动收录条目由管线按标题关键词自动标注科目与相关性分级（high/medium/low），低相关条目在平台端默认折叠

## 安全机制

- 任一核心源本次抓取数低于上次 90% 时，该源回退沿用上次 feed 条目（按源降级，不中止整轮）；
- 仅当所有核心源均无数据且无上次 feed 时才中止（防官网改版清空数据）；
- 平台端拉取失败时静默降级到上次缓存与内置数据，玩家无感知。
