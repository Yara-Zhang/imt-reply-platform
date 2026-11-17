-- 003: KOL/KOC 分层 + 真实度 + 简介邮箱 (spec C2 增强版)
-- 依赖 001_init.sql

-- authors 表扩展
alter table authors
  add column if not exists tier text default 'none' check (tier in ('kol','koc','none')),
  add column if not exists auth_score smallint,
  add column if not exists auth_signals jsonb default '{}',
  add column if not exists bio text,
  add column if not exists email text,
  add column if not exists email_source text,
  add column if not exists profile_fetched_at timestamptz,
  add column if not exists avg_engagement numeric default 0;

-- demand_posts: kol_flag → kol_tier
alter table demand_posts
  add column if not exists kol_tier text default 'none' check (kol_tier in ('kol','koc','none'));
-- 存量转换: 已确认为 KOL 的旗标保留为 kol 层
update demand_posts set kol_tier = 'kol' where kol_flag = true and kol_tier = 'none';
alter table demand_posts drop column if exists kol_flag;
create index if not exists idx_demand_kol_tier on demand_posts (kol_tier);

-- 分层规则参数 (全部可改, 前端设置页后续可暴露)
insert into app_config (key, value) values
('kol_rules', '{
  "koc_followers_min": 500,
  "kol_followers_min": 10000,
  "koc_engagement_min": 50,
  "koc_engagement_rate_min": 0.01,
  "kol_engagement_min": 500,
  "kol_engagement_rate_min": 0.03,
  "auth_score_min": 60,
  "boost_ratio_suspect": 10,
  "profile_fetch_cooldown_days": 7,
  "engagement_trigger": 50
}'),
('auth_score_weights', '{
  "er_healthy": 40,
  "er_dead_penalty": -30,
  "comment_ratio_healthy": 30,
  "comment_ratio_dead_penalty": -30,
  "vs_avg_healthy": 30,
  "viral_er_threshold": 0.5
}')
on conflict (key) do nothing;
