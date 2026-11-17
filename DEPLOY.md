# 部署与联调指引（DEPLOY.md）

> 面向非技术同事，全程点击级操作，预计 30 分钟。之后日常零运维——抓取、初筛、汇总全自动。

## 你需要准备的（都可复用 feedback-hub v1 的凭据）

| 项 | 去哪拿 | 花钱吗 |
|---|---|---|
| Supabase 账号 | supabase.com 注册（GitHub 登录即可） | 免费版够用 |
| TikHub API key | 复用 v1 的 key（TikHub 后台） | 按调用计费，$3/日预算已内置 |
| DeepSeek API key | 复用 v1 的 key（platform.deepseek.com） | 象征性 |

> 飞书相关（群机器人 Webhook、扫码登录）已改为**可选项**：周报/日报在平台内「周报」页实时生成，想看的人点进去看和下载，不再依赖飞书推送。需要时再按第 2 步末尾的可选说明配置。

---

## 第 1 步：建数据库（10 分钟）

1. 打开 supabase.com → New project，名字随意（如 `imt-reply`），选**免费版**，设一个数据库密码（记下来）
2. 项目创建后，左侧栏 **SQL Editor** → New query
3. 打开本仓库 `supabase/migrations/001_init.sql`，全选复制 → 粘贴进编辑器 → 点 **Run**，底部显示 "Success"
4. 同样方式再执行 `supabase/migrations/002_migrate_rpc.sql`
5. 左侧 **Database → Extensions**，确认 `pg_cron` 和 `pg_net` 显示为 Enabled（默认已启用；没有就点开关启用）

## 第 2 步：部署后端函数（8 分钟）

> **控制台粘贴用合并版单文件**（Supabase 控制台的函数是单文件，不支持多文件 import）：粘贴 `supabase/bundled/` 目录下的文件，**不要**粘贴 `functions/` 目录里的（那是 CLI 部署用的源码结构）。

1. 左侧栏 **Edge Functions** → **Create a function**，名字填 `api-auth`，把 `supabase/bundled/api-auth.ts` 的内容全选复制 → 粘贴进去覆盖 → Save
2. 同样方式创建并粘贴其余 5 个：`api-posts`、`api-scenes`、`api-reply`、`crawl-tick`、`health-digest`（文件名和函数名一一对应）
3. **Edge Functions → Secrets**（或项目 Settings → Edge Functions）添加环境变量：

   | 变量名 | 值 |
   |---|---|
   | SUPABASE_URL | 项目 Settings → API 里的 Project URL |
   | SUPABASE_SERVICE_ROLE_KEY | 同页的 service_role key（保密，勿外传） |
   | SESSION_SECRET | 随便一串长字符（如键盘乱敲 32 位） |
   | DEEPSEEK_API_KEY | DeepSeek 的 key |
   | TIKHUB_API_KEY | TikHub 的 key |

   **可选（不配不影响任何功能）**：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` —— 飞书扫码登录。不配则登录页只显示邮箱密码登录，照样够用。

## 第 3 步：设定时任务（2 分钟）

左侧 **SQL Editor** 执行（把 `functions/crawl-tick` 等 URL 替换成第 2 步列表页显示的实际 URL）：

```sql
select cron.schedule('crawl-tick', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://<项目ref>.supabase.co/functions/v1/crawl-tick',
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
$$);

select cron.schedule('health-digest', '0 10 * * *', $$
  select net.http_post(
    url := 'https://<项目ref>.supabase.co/functions/v1/health-digest',
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
$$);
```

## 第 4 步：部署前端（5 分钟）

1. 本目录 `web/` 下建文件 `.env`，写一行：
   `VITE_API_BASE=https://<项目ref>.supabase.co/functions/v1`
2. 终端执行 `npm install && npm run build`（或把 web/ 推到 GitHub，Cloudflare Pages 连接该仓库，构建命令 `npm run build`，输出目录 `dist`）
3. Cloudflare Pages（pages.cloudflare.com，免费）→ Create project → 连 GitHub 仓库 → 部署完成后得到 `xxx.pages.dev` 网址
4. 团队成员用该网址访问，**第一个注册的账号自动成为 admin**；注册开放，输入未注册的邮箱即自动注册（团队内部工具，无需邀请码）

## 第 5 步：存量迁移（机会卡牌数据搬过来）

1. 从机会卡牌导出需求帖 CSV（约 500 条）
2. 终端执行：

```bash
cd scripts
SUPABASE_URL=https://<项目ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service key> \
node migrate-v2.mjs ~/Downloads/demand-export.csv
```

脚本只迁移 **open 状态且发布 72 小时内**的帖子（重点捞回日本市场的回复机会池），已冷却的老帖跳过。

## 验收清单

- [ ] 打开 `xxx.pages.dev`，注册首个账号（自动 admin）
- [ ] 首页出现统计带与管道健康条（5 分钟内 "最近一轮" 时间会刷新）
- [ ] 点一张卡片 → 按 Enter → 出现 AI 草稿（需 DeepSeek key 正确）
- [ ] 按日韩帖 → 提示"需母语审核"（阶段 0 时起草被拦截，可在设置页把市场阶段调为 1 测试）
- [ ] 打开「周报」页 → 出现本周数据看板 → 点「下载报告」能得到 HTML 文件

## 常见问题

- **页面空、抓不到帖** → 看 Edge Functions → Logs 里 `crawl-tick` 的报错；九成是 TikHub key 或预算问题
- **改了表结构前端不生效** → SQL Editor 执行 `NOTIFY pgrst, 'reload schema'`，等 10 秒
- **Supabase 免费版 7 天没访问会暂停** → `health-digest` 的每日 10:00 定时任务自带保活，无需处理
- **想本地先玩** → 不配 `.env` 直接 `npm run dev`，走内置 Mock 演示模式，无需任何 key
