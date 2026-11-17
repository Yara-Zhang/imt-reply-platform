-- 004: v4 优化 — 回复草稿中文对照列
-- 依赖 001_init.sql

alter table demand_posts
  add column if not exists reply_draft_cn text;
