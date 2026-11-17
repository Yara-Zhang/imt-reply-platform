-- 002: 存量迁移辅助函数 (migrate-v2.mjs 调用)
-- 一次调用完成: URL 规范化 → 采集池入库(幂等) → 需求帖入库(幂等) → quote 核验回填

-- 去空白/标点的辅助函数
create or replace function squash_text(t text) returns text language sql immutable as $$
  select lower(regexp_replace(coalesce(t, ''), '[[:space:][:punct:]]', '', 'g'));
$$;

create or replace function migrate_demand_post(
  p_url text, p_platform text, p_market text, p_published_at timestamptz,
  p_title text, p_content text, p_demand_id text, p_summary text,
  p_quote text, p_topic text, p_confidence numeric
) returns uuid language plpgsql as $$
declare
  v_hash text := encode(digest(normalize_url(p_url), 'sha256'), 'hex');
  v_item uuid; v_post uuid; v_verified boolean := false;
begin
  insert into crawl_items (platform, market, url, url_hash, published_at, raw_title, raw_content, ai_status, classified_type)
  values (p_platform, p_market, p_url, v_hash, p_published_at, p_title, p_content, 'done', 'demand')
  on conflict (url_hash) do nothing;

  select id into v_item from crawl_items where url_hash = v_hash;

  if p_quote is not null and length(squash_text(p_quote)) >= 4 then
    v_verified := position(squash_text(p_quote) in squash_text(p_content)) > 0;
  end if;

  insert into demand_posts (item_id, market, platform, url, published_at, title, content,
    demand_id, summary, quote, quote_verified, topic, confidence, state)
  values (v_item, p_market, p_platform, p_url, p_published_at, p_title, p_content,
    p_demand_id, p_summary, p_quote, v_verified, p_topic, p_confidence, 'open')
  on conflict (item_id) do nothing;

  select id into v_post from demand_posts where item_id = v_item;
  return v_post;
end $$;
