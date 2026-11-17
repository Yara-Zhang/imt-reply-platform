-- ============================================================
-- 沉浸式翻译社区回复平台 v1 初始 schema
-- 依据: platform-spec/docs/spec.md §8 数据模型
-- 说明: pg_cron / pg_net 需在 Supabase 控制台启用(Dashboard → Database → Extensions)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 工具: URL 规范化 (v2 §6.5 规则) ----------
create or replace function normalize_url(raw text) returns text language sql immutable as $$
  with s0 as (select lower(trim(raw)) u),
       s1 as (select regexp_replace(u, '#.*$', '') u from s0),
       s2 as (select regexp_replace(u, '(utm_[a-z_]+|refer_flag|xsec_[a-z_]+|spm|from|share|s|t|si)=[^&]*(&|$)', '', 'g') u from s1),
       s3 as (select regexp_replace(u, '\?$', '') u from s2),
       s4 as (select regexp_replace(u, 'https?://', '') u from s3),
       s5 as (select rtrim(u, '/') u from s4)
  select 'https://' || u from s5;
$$;

create or replace function url_hash(raw text) returns text language sql immutable as $$
  select encode(digest(normalize_url(raw), 'sha256'), 'hex');
$$;

-- ---------- 成员 ----------
create table members (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid,                       -- Supabase auth.users 引用(登录后绑定)
  feishu_open_id text unique,
  email text unique,
  password_hash text,                      -- PBKDF2, 登录在 Edge Function 内完成
  name text not null,
  role text not null default 'member' check (role in ('admin','member','observer')),
  duties text[] default '{}',              -- ja_review / kr_review
  claim_limit smallint default 10,
  timeout_count_week smallint default 0,
  notify_prefs jsonb default '{}',
  created_at timestamptz default now()
);

-- ---------- 关键词 (四类词 + 词效统计, spec C9) ----------
create table keywords (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('demand','event','brand','exclude')),
  keyword text not null,
  market text not null check (market in ('cn','en','jp','kr')),
  platforms text[] not null default '{}',
  demand_id text,                          -- 关键词登记的 D 编号(可空)
  enabled boolean default true,
  exclude_words text[] default '{}',
  trial_until timestamptz,                 -- 扩词试用期(C9)
  fetched_count int default 0,
  relevant_count int default 0,
  demand_count int default 0,
  p0_count int default 0,
  created_at timestamptz default now(),
  unique (kind, keyword, market)
);

-- ---------- 需求场景 D01-D14 (v2 体系原样) ----------
create table demand_scenes (
  id text primary key check (id ~ '^D[0-9]{2}$'),
  name text not null,
  definition text,
  capability text[],
  feature text,
  markets text[] default '{}',             -- 空 = 全市场适用
  status text default 'active' check (status in ('active','candidate','disabled')),
  confirmed_by text,
  posts_30d int default 0,
  replied_rate numeric default 0,
  updated_by text default '需求场景 v1',
  updated_at timestamptz default now()
);

-- ---------- 共用采集条目池 (双通道母表) ----------
create table crawl_items (
  id uuid primary key default gen_random_uuid(),
  keyword_id uuid references keywords(id),
  platform text not null,
  market text not null check (market in ('cn','en','jp','kr')),
  url text not null,
  url_hash text not null unique,           -- normalize_url 后哈希, 精确去重
  author_id text,
  author_name text,
  published_at timestamptz not null,
  raw_title text,
  raw_content text,                        -- 截断 4000 字
  metrics_json jsonb default '{}',
  lang text,
  classified_type text check (classified_type in ('demand','brand','both','none')),
  ai_status text default 'pending' check (ai_status in ('pending','done','skipped')),
  created_at timestamptz default now()
);
create index on crawl_items (platform, published_at desc);
create index on crawl_items (classified_type);

-- ---------- 需求帖 (v2 demand_posts 扩展, spec §8) ----------
create table demand_posts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid unique references crawl_items(id) on delete cascade,
  market text not null check (market in ('cn','en','jp','kr')),
  platform text not null,
  url text not null,
  author_id text,
  author_name text,
  published_at timestamptz not null,
  title text,
  content text,
  demand_id text references demand_scenes(id),  -- 空 = 未归类
  summary text,                                 -- ≤40 字中文摘要(卡片标题)
  quote text,                                   -- ≤60 字卡点原话, 入库! (补 v2 缺口)
  quote_verified boolean default false,
  topic text,                                   -- 2-8 字话题标签
  lang text,
  confidence numeric,
  priority_score smallint default 0,            -- C1
  stale boolean default false,                  -- C1 冷却
  kol_flag boolean default false,               -- C2 (P0 只存字段)
  state text not null default 'open' check (state in ('open','claimed','replied','skipped')),
  claimed_by uuid references members(id),
  claimed_at timestamptz,
  claim_deadline timestamptz,                   -- C4 (P0 只存字段)
  reply_draft text,
  draft_at timestamptz,
  brand_issues jsonb default '[]',              -- [{level:'must'|'warn',rule,hit_text}]
  suitable_note text,                           -- AI 判不适合的原因
  ja_reviewed_by uuid references members(id),  -- 母语审核(日韩共用, v2 命名保留)
  ja_reviewed_at timestamptz,
  replied_by uuid references members(id),
  replied_at timestamptz,
  reply_url text,
  reply_account text,                           -- C11 (P0 只存字段)
  metrics_before jsonb default '{}',
  skip_reason text,
  note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on demand_posts (state, priority_score desc);
create index on demand_posts (market, published_at desc);
create index on demand_posts (topic);

-- ---------- 品牌口碑帖 (v1 Part A 独立成表) ----------
create table brand_posts (
  id uuid primary key default gen_random_uuid(),
  item_id uuid unique references crawl_items(id) on delete cascade,
  market text not null,
  platform text not null,
  url text not null,
  author_id text, author_name text,
  published_at timestamptz not null,
  content text,
  metrics_json jsonb default '{}',
  sentiment text check (sentiment in ('正','中','负')),
  tags jsonb default '[]',                      -- pr_material/complaint/kol/competitor/positive
  competitor_names text[] default '{}',
  alarm_flag boolean default false,             -- P0 汇总告警标记
  priority_score smallint default 0,
  kol_flag boolean default false,
  state text not null default 'open' check (state in ('open','noted','replied','skipped')),
  handled_by uuid references members(id),
  handle_note text,
  reply_url text,
  is_material boolean default false,            -- 宣发素材收藏
  material_by uuid references members(id),
  material_at timestamptz,
  created_at timestamptz default now()
);
create index on brand_posts (state, priority_score desc);

-- ---------- 作者聚合 (C2, P0 建表积累数据) ----------
create table authors (
  id uuid primary key default gen_random_uuid(),
  platform text not null,
  author_id text not null,
  name text,
  followers int,
  total_hits int default 0,
  total_engagement int default 0,
  max_engagement int default 0,
  kol_candidate boolean default false,
  is_kol boolean default false,
  kol_confirmed_by uuid references members(id),
  last_seen_at timestamptz,
  unique (platform, author_id)
);

-- ---------- 话术模板 (C6, P0 建表) ----------
create table reply_templates (
  id uuid primary key default gen_random_uuid(),
  demand_id text references demand_scenes(id),
  market text,
  platform text,
  content text not null,
  source_post_id uuid references demand_posts(id),
  created_by uuid references members(id),
  usage_count int default 0,
  avg_outcome numeric,
  status text default 'active' check (status in ('active','pinned','disabled')),
  created_at timestamptz default now()
);

-- ---------- 回复效果 (C3, P0 建表) ----------
create table reply_outcomes (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references demand_posts(id) on delete cascade,
  check_round smallint check (check_round in (1,2,3)),   -- 1=+24h 2=+72h 3=+7d
  checked_at timestamptz default now(),
  delta_likes int, delta_comments int,
  author_replied boolean,
  post_alive boolean default true,
  note text
);

-- ---------- 值班表 (C5, P0 建表) ----------
create table weekly_shifts (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  market text not null check (market in ('cn','en','jp','kr')),
  owner_id uuid references members(id),
  reviewer_id uuid references members(id),
  unique (week_start, market)
);

-- ---------- 通知日志 (C8, P0 建表) ----------
create table notifications_log (
  id uuid primary key default gen_random_uuid(),
  type text not null,                        -- kol_alert/p0_digest/review_todo/weekly/timeout
  target_user_id uuid references members(id),
  post_id uuid,
  dedup_key text,
  sent_at timestamptz default now()
);

-- ---------- 任务队列 (v1 队列模式, 优先级防饿死) ----------
create table crawl_jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('search','enrich','recheck')),
  payload jsonb default '{}',
  status text default 'queued' check (status in ('queued','running','done','failed')),
  error text,
  created_at timestamptz default now(),
  run_at timestamptz default now(),
  finished_at timestamptz
);
create index on crawl_jobs (status, run_at);

-- ---------- 运行参数 ----------
create table app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

-- ---------- 周报存档 ----------
create table weekly_reports (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  content jsonb not null,
  created_at timestamptz default now()
);

-- ---------- API 用量记账 ----------
create table api_usage (
  id uuid primary key default gen_random_uuid(),
  day date not null default current_date,
  provider text not null,                     -- tikhub / deepseek
  cost numeric default 0,
  calls int default 0,
  unique (day, provider)
);

-- ---------- 操作日志 (所有写操作留痕, spec 议题2) ----------
create table op_log (
  id uuid primary key default gen_random_uuid(),
  table_name text not null,
  row_id uuid not null,
  action text not null,
  operator uuid references members(id),
  detail jsonb default '{}',
  created_at timestamptz default now()
);

-- ---------- 触发器: demand_posts 写操作留痕 + updated_at ----------
create or replace function log_demand_op() returns trigger as $$
begin
  new.updated_at = now();
  insert into op_log (table_name, row_id, action, operator, detail)
  values ('demand_posts', new.id, 'update:' || new.state, new.claimed_by,
          jsonb_build_object('prev_state', old.state, 'by', coalesce(new.claimed_by, new.replied_by)));
  return new;
end $$ language plpgsql;

create trigger trg_demand_op after update on demand_posts
for each row execute procedure log_demand_op();

-- ---------- RLS: 全表启用, 无公开 policy, 一切经 Edge Functions(service key) ----------
alter table demand_posts enable row level security;
alter table brand_posts enable row level security;
alter table crawl_items enable row level security;
alter table members enable row level security;
alter table keywords enable row level security;
alter table demand_scenes enable row level security;
alter table reply_templates enable row level security;
alter table reply_outcomes enable row level security;
alter table weekly_shifts enable row level security;
alter table crawl_jobs enable row level security;
alter table app_config enable row level security;
alter table op_log enable row level security;

-- ============================================================
-- 种子数据
-- ============================================================

-- D01-D14 需求场景 (v2 §1.2 原样)
insert into demand_scenes (id, name, definition, capability, feature) values
('D01','外语视频追更','想看的外语视频没有母语字幕，或机翻字幕难读','{视频双语字幕}','视频双语字幕'),
('D02','偶像 / K-Pop 幕后与直播','幕后花絮、直播、综艺全外语无字幕','{视频双语字幕}','视频双语字幕'),
('D03','流媒体平台缺字幕','Prime / Netflix 等片源缺母语字幕，只能外挂','{视频双语字幕,字幕文件翻译}','流媒体双语字幕'),
('D04','双语对照学语言','看视频练听力、跟读，只看外文字幕焦虑、只看机翻又失真','{双语字幕,网页对照}','双语字幕'),
('D05','论文与学术 PDF 精读','读英文论文吃力，复制到翻译器再切回','{PDF 保版式翻译,对照阅读}','PDF 对照翻译'),
('D06','外刊、长文与电子书','外刊、长文、电子书原文阅读','{网页对照,EPUB 翻译}','网页双语对照'),
('D07','游戏攻略与未本地化的游戏','海外攻略、无本地化游戏卡关','{网页对照,图片翻译}','网页对照与图片翻译'),
('D08','桌游 / TRPG 规则书','规则书无本地版，截图拼凑、关键规则被翻反','{PDF 翻译,图片翻译}','PDF 对照翻译'),
('D09','漫画与 Webtoon','条漫、漫画原版阅读，整页机翻破坏排版','{漫画翻译}','漫画翻译'),
('D10','海外小说与同人连载','追海外个人站、AO3 等连载，来回复制翻译','{网页对照}','网页双语对照'),
('D11','海外社群实时聊天','Discord 等跨国社群滚屏，复制翻译跟不上','{网页对照,输入框翻译}','输入框翻译'),
('D12','社交平台内置翻译不可靠','X / Grok / Chrome / YouTube 内置翻译失效、意译翻车、否定句翻反','{X 定制适配,原文译文并排核对}','原文译文并排'),
('D13','海外购物与规格页','海外通贩参数页、结算页全外文','{网页对照,图片翻译}','网页对照与图片翻译'),
('D14','跨国会议与工作','跨国会议、工作文档、说明书','{会议翻译（Meet、Zoom、Teams）,文档翻译}','会议字幕翻译');

-- 28 个需求词 (v2 §6.3 原样: 中文4 / 英文4 / 日本20 / 韩国0)
insert into keywords (kind, keyword, market, platforms, demand_id) values
('demand','求双语字幕','cn','{bilibili,weibo}','D01'),
('demand','生肉 看不懂','cn','{bilibili,weibo}','D01'),
('demand','英文论文 看不懂','cn','{zhihu,weibo}','D05'),
('demand','游戏 没有汉化','cn','{bilibili,weibo}','D07'),
('demand','no English subtitles','en','{reddit,x}','D01'),
('demand','translate pdf keep formatting','en','{reddit}','D05'),
('demand','manga translation extension','en','{reddit}','D09'),
('demand','discord translate messages','en','{reddit}','D11'),
('demand','DeepL 文字数 制限','jp','{x,hatena}',null),
('demand','Google翻訳 おかしい','jp','{x}',null),
('demand','DeepL 有料','jp','{x}',null),
('demand','韓国語 わからない 配信','jp','{x}','D01'),
('demand','英語字幕 読めない','jp','{x}','D01'),
('demand','日本語字幕 ない','jp','{x,youtube}','D01'),
('demand','字幕なし ビハインド','jp','{x}','D02'),
('demand','ネトフリ 日本語字幕 ない','jp','{x}','D03'),
('demand','プライム 日本語字幕 ない','jp','{x}','D03'),
('demand','英語 論文 読めない','jp','{x}','D05'),
('demand','論文 翻訳 PDF','jp','{x,hatena}','D05'),
('demand','海外 攻略 翻訳','jp','{x,youtube}','D07'),
('demand','日本語化 されてない','jp','{x,niconico}','D07'),
('demand','ルールブック 翻訳','jp','{x,hatena}','D08'),
('demand','Webtoon 翻訳','jp','{x}','D09'),
('demand','Discord 翻訳','jp','{x}','D11'),
('demand','Grok 翻訳','jp','{x}','D12'),
('demand','ポストを翻訳 できない','jp','{x}','D12'),
('demand','翻訳がおかしい','jp','{x}','D12'),
('demand','海外通販 翻訳','jp','{x}','D13');

-- 运行参数 (spec 定稿值)
insert into app_config (key, value) values
('brand', '{"name_cn":"沉浸式翻译","name_en":"Immersive Translate","site":"https://immersivetranslate.com/"}'),
('budget', '{"daily_usd":3}'),
('market_stage', '{"jp":0,"kr":0}'),                       -- 0 只监测 / 1 出稿 / 2 完整运营
('stale_hours', '72'),
('kol_alert', '{"engagement_threshold":1000,"daily_limit_per_user":5}'),
('claim_timeout', '{"no_draft_hours":24,"with_draft_hours":72}'),
('platform_caps', '{"xiaohongshu":8,"douyin":12}'),        -- 每日调用硬上限 (spec §11.3)
('brand_rules', '{"must":[
  {"id":"banned_words","label":"禁用词","words":["终于等到","活该","幸灾乐祸","破解","盗版","绕过付费墙","bypass paywall","网盘","百度云","资源打包","文包下载","全文搬运","熟肉下载","字幕文件下载","倒闭","垃圾"]},
  {"id":"product_name","label":"产品名写错","words":["沉浸翻译","沉浸式翻譯","浸入式翻译","Immersive Translator","Immersive-Translate","immersive translation"]},
  {"id":"jp_absolute","label":"日文绝对化用语","words":["No.1","ナンバーワン","日本一","業界初","業界No","最高品質","唯一","完全無料","永久無料","絶対"]},
  {"id":"kr_absolute","label":"韩文绝对化用语","words":["No.1","넘버원","업계 1위","업계 최초","국내 1위","세계 최초","유일한","완전 무료","평생 무료","최고의"]}
 ],"warn":[
  {"id":"cn_absolute","label":"绝对化用语提醒","words":["最好","第一","唯一","最强","100%","永久免费","完全免费","best ever","the only"]},
  {"id":"link_check","label":"链接提醒","words":[]}
 ]}'),
('crawl_intervals', '{"weibo":30,"x":30,"reddit":60,"xiaohongshu":180,"zhihu":180,"bilibili":240,"youtube":360,"hatena":120,"niconico":360,"douyin":240}'),
('enrich_batch', '20'),
('digest', '{"p0_hour":10,"review_hours":[10,18],"weekly_wday":1,"weekly_hour":9}');
