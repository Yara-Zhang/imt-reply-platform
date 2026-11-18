# 沉浸式翻译 · 社区回复工作平台 — 项目全景文档

> 运营团队用它及时发现并回复各平台上与「沉浸式翻译」相关的用户需求/吐槽帖。
> 本文档是项目的单一信息源：架构、部署状态、版本历史、运维要点、后续方向。

---

## 1. 项目定位

运营同事每天在 X / Reddit / 微博 / 小红书 / B站 / 知乎 / YouTube / はてな 等平台上，
寻找"想看外语视频字幕 / 论文翻译 / 网页翻译"等目标用户的帖子并回复种草。
本平台把这件事流水线化：

```
定时抓取(TikHub) → AI 初筛+摘要+中文翻译(DeepSeek) → 优先级排序(P0/P1/P2)
→ 运营认领 → AI 起草口语化回复(+中文对照) → 母语审核 → 发出后登记回复链接
→ +24h/72h/7d 自动回访统计效果 → 好话术沉淀为模板
```

## 2. 系统架构

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | Vue 3 + Vite，纯静态构建 | 部署在 GitHub Pages（也可部署到任何静态托管） |
| 后端 | Supabase Edge Functions（Deno）×8 | 无服务器，免运维 |
| 数据库 | Supabase PostgreSQL | 单一数据源，全团队/全部署共享 |
| 定时任务 | pg_cron + pg_net（库内触发函数） | 无外部调度依赖 |
| 外部 API | TikHub（抓取/档案）、DeepSeek（AI 起草/初筛） | 密钥存 Supabase Secrets |

**关键设计**：前端是纯静态文件，不持有任何业务状态；所有数据都在 Supabase。
因此**换任何静态托管都不影响数据**——两个不同域名打开的界面操作的是同一份数据。

### 2.1 八个 Edge Functions

| 函数 | 职责 | 触发方式 |
|---|---|---|
| `api-auth` | 注册/登录，JWT 会话 | 前端调用 |
| `api-posts` | 帖子列表/统计/认领/回复登记/模板/效果查询 | 前端调用 |
| `api-scenes` | 场景库与关键词管理 | 前端调用 |
| `api-reply` | AI 起草回复（DeepSeek，输出主语言+中文对照） | 前端调用 |
| `crawl-tick` | 各平台抓取 → AI 初筛 → 入库 → KOL 识别 | cron 每 5 分钟 |
| `health-digest` | 管道健康巡检 + 每日报告数据 | cron 每日 10:00 |
| `reply-check` | 已回复帖效果回访（+24h/72h/7d 三轮） | cron 每 2 小时 |
| `kol-backfill` | 存量帖作者档案回填打标（一次性任务函数） | 手动触发 |

### 2.2 核心数据表

| 表 | 内容 |
|---|---|
| `demand_posts` | 需求帖主表（446 条自 v2 机会卡牌迁移 + 管道新帖），含状态机、优先级分、回复草稿、中文对照、回复链接、互动数据 |
| `authors` | 作者档案（粉丝数、KOL/KOC 分层、真实度评分、简介、邮箱线索） |
| `reply_outcomes` | 回复效果三轮回访数据（赞/评增量、原帖存活） |
| `reply_templates` | 回复模板库（按市场/平台分类，供起草参考） |
| `members` / `op_log` | 团队成员与操作审计 |
| `app_config` | 配置中心（市场阶段、KOL 规则、预算、回填进度等） |
| `crawl_sources` / `scenes` / `keywords` | 抓取源与场景关键词 |

## 3. 当前部署状态（2026-11-18）

| 项 | 值 |
|---|---|
| Supabase 项目 | `imt-reply`（ref: `uvmqazhqdisiiygawoeg`） |
| 线上前端 | https://yara-zhang.github.io/imt-reply-platform/ |
| 代码仓库 | https://github.com/Yara-Zhang/imt-reply-platform （公开） |
| 前端 API 地址 | `web/.env` → `VITE_API_BASE=https://uvmqazhqdisiiygawoeg.supabase.co/functions/v1`（已提交仓库） |
| 数据规模 | 446 条迁移帖 + 管道新帖；3 个市场激活（jp/en/cn，kr 部分） |

### 3.1 定时任务（pg_cron）

```sql
-- job 1: 抓取，每 5 分钟
select cron.schedule('crawl-tick', '*/5 * * * *', $$ select net.http_post(url := 'https://uvmqazhqdisiiygawoeg.supabase.co/functions/v1/crawl-tick', headers := '{"Content-Type":"application/json"}'::jsonb); $$);
-- job 2: 健康报告，每日 10:00
select cron.schedule('health-digest', '0 10 * * *', $$ ... /functions/v1/health-digest ... $$);
-- job 3: 回复效果回访，每 2 小时
select cron.schedule('reply-check', '0 */2 * * *', $$ select net.http_post(url := 'https://uvmqazhqdisiiygawoeg.supabase.co/functions/v1/reply-check', body := '{}'::jsonb); $$);
```

### 3.2 函数 Secrets（Supabase → Edge Functions → Secrets）

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SESSION_SECRET` / `DEEPSEEK_API_KEY` / `TIKHUB_API_KEY`
（可选：`FEISHU_WEBHOOK_URL` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET`）

## 4. 在 Manus 上部署前端镜像

**前提认知**：Manus space 是静态站点托管，不能承载本项目的后端/数据库/定时任务。
正确的平移方式是**只部署前端**（后端留在 Supabase，两边数据互通）。

已验证的可行性依据：
1. 仓库公开，Manus 可直接 clone；
2. `web/.env` 已提交，构建产物自动指向 Supabase 后端；
3. 所有后端接口 CORS 为 `*`，manus.space 域名可直接调用，后端零改动。

把下面这段话发给 Manus 即可：

> 从 GitHub 拉取公开仓库 https://github.com/Yara-Zhang/imt-reply-platform ，进入 `platform/web` 目录，执行 `npm install && npm run build`（.env 里的 VITE_API_BASE 不要改动），然后把 `dist` 目录作为静态网站部署上线。这是一个 Vue 3 构建的静态前端，会通过配置好的 API 地址连接远程后端。

注意：Manus 上的版本只做**访问镜像**（例如方便国内直连）；发布回复、抓取、
效果统计都发生在共享的 Supabase 数据库里，不需要在镜像上做任何同步。

## 5. 版本历史

| 版本 | 内容 |
|---|---|
| P0 | Supabase 后端 + Vue3 前端 + KOL/KOC 分层 + 周报页，6 个函数 |
| v2 迁移 | 机会卡牌（imtcard.manus.space）446 条 open 帖零失败迁移（tRPC 拉取 + SQL DO 块分批） |
| v4（9 项） | ①全量展示不折叠 ②回复链接必填登记+可修改 ③起草 prompt 重写（口语化/去AI味/平台屏蔽规避）④非简中中文对照 ⑤放回（含误跳过恢复）⑥存量 KOL 回填 ⑦真实界面 ⑧优化方向清单 ⑨P0/P1/P2 数字化（按市场统计，回复完成实时递减） |
| v4.1（3 项） | ①回复效果自动追踪（reply-check，+24h/72h/7d）②非 X 平台 KOL 档案（微博/Reddit/小红书）③回复模板库（存为模板 + 场景页展示复制） |

v4/v4.1 期间顺带修复的存量 bug：
- `demand_posts` 缺 `metrics_json` 列（互动数从未落库）
- X 作者档案用数字 rest_id 查询（需 screen_name），KOL 识别自上线起未生效
- 前端分页 bug（列表只显示 40 条）
- kol-backfill 重复代码块导致 BOOT_ERROR
- Reddit 档案解析：TikHub 响应为 GraphQL 风格 `data.redditorInfoByName`，无粉丝字段（用 subscribersCount + karma 兜底）

## 6. 作者打标现状

| 平台 | KOL | KOC | 无分层 | 备注 |
|---|---|---|---|---|
| X | 5 | 74 | 194 | 粉丝数全部拿到 |
| 微博 | 0 | 14 | 42 | 按名搜索中转拿 uid+粉丝 |
| Reddit | 0 | 3 | 69 | 无粉丝字段，按 karma 兜底（≥10万=KOL / ≥1万=KOC） |
| 小红书 | — | — | — | 端点已接，存量帖缺 user_id，新管道帖生效 |

分级规则（无互动数据的迁移帖）：粉丝 ≥1万 = KOL、≥500 = KOC；
有互动数据的走三路真实度评分（auth_score）。`auth_signals.unknown_engagement` 标记供建联参考。

## 7. 后续优化方向（剩余）

| # | 方向 | 说明 | 建议优先级 |
|---|---|---|---|
| 1 | 品牌口碑页 + 洞察分析页 | 导航里的两个占位页做成真页面（口碑聚合、话术效果分析） | P1 |
| 2 | 批量操作 + 移动端 | 键盘流提速（30 分钟 40 条）；手机查看 | P1 |
| 3 | 值班轮换 | 日/韩母语审核每周值班人自动排班提醒 | P2 |
| 4 | 小红书存量档案 | 存量帖 author_id 为空，需帖子重抓或 URL 提取 user_id | P2 |
| 5 | 知乎抓取修复 | TikHub 端点参数仍 400，待端点确认 | P2 |
| 6 | 回复模板自动注入 | 起草时自动参考同场景高分模板（模板库已就绪，差注入环节） | P1 |

## 8. 运维要点备忘

- **改表结构后前端不生效**：SQL Editor 执行 `NOTIFY pgrst, 'reload schema'`
- **部署函数**（须从 `platform/` 目录跑）：
  ```bash
  cd platform && HOME=/tmp/sbhome SUPABASE_ACCESS_TOKEN=<token> \
    npx -y supabase functions deploy <函数名...> --project-ref uvmqazhqdisiiygawoeg --no-verify-jwt --yes
  ```
- **本机到 *.supabase.co TLS 不稳时的兜底**：用 Supabase 管理 API
  `POST https://api.supabase.com/v1/projects/<ref>/database/query` 直接跑 SQL；
  函数触发用 pg_net `net.http_post()`（注意 pg_net 响应捕获有 5 秒超时，
  长任务读 `app_config` 里的进度即可）
- **git 推送**需走代理 `http.proxy=http://127.0.0.1:1235`
- **前端发布**：`web/` 构建 → dist 推 gh-pages 分支
- **Supabase 免费版 7 天无访问会暂停**：`health-digest` 每日任务自带保活
- **本地演示**：不配 `.env` 直接 `npm run dev` 走内置 Mock 模式，无需任何密钥

## 9. 风险与待办

- [ ] **尽快 Revoke 部署用的 sbp_ 访问令牌**（Supabase 控制台 → Account → Access Tokens）
- [ ] v2 机会卡牌（imtcard.manus.space）数据已全部迁出，原站可下线
- [ ] 日本市场阶段当前为 1（可起草）；如需只监测模式，设置页改回 0
