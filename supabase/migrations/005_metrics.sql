-- 005: v4 修复 — demand_posts 补互动数据列 (存量 bug: 互动数从未落库)
-- 依赖 001_init.sql

alter table demand_posts
  add column if not exists metrics_json jsonb default '{}'; -- {likes, comments}
