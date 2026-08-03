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

## 安全机制

- 任一核心源本次抓取数低于上次 90% 时，脚本中止且不提交（防官网改版清空数据）；
- 平台端拉取失败时静默降级到上次缓存与内置数据，玩家无感知。
