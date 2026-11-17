#!/usr/bin/env node
// gen-migrate-sql.mjs — 把 /tmp/v2-open-posts.json 转成迁移 SQL (DO 块逐条容错)
import { readFileSync, writeFileSync } from "node:fs";

const posts = JSON.parse(readFileSync("/tmp/v2-open-posts.json", "utf8"));

// 平台名映射: v2 → 新平台
const PLATFORM = { twitter: "x", xiaohongshu: "xiaohongshu", reddit: "reddit", weibo: "weibo", youtube: "youtube", zhihu: "zhihu", bilibili: "bilibili" };

const esc = (v) => v == null ? "null" : "'" + String(v).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
const validDemand = (d) => (d && /^D(0[1-9]|1[0-4])$/.test(d)) ? d : null; // 只认 D01-D14, 其他(事件场景)置空

const rows = posts.map((p) => {
  const platform = PLATFORM[p.platform] ?? p.platform;
  const d = p.demandId ? validDemand(p.demandId) : null;
  return [
    esc(p.url), esc(platform), esc(p.market),
    esc(p.publishedAt), esc(p.title?.slice(0, 500) ?? null),
    esc(p.content?.slice(0, 8000) ?? null), esc(d),
    esc(p.summary?.slice(0, 300) ?? null), esc(null), // v2 无 quote
    esc(p.topic?.slice(0, 80) ?? null), esc(null),
    esc(p.author?.slice(0, 120) ?? null),
  ].join(", ");
});

// 分批生成 DO 块 (每批 60 条, 避免单条 SQL 过大)
const BATCH = 60;
const files = [];
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const sql = `do $mig$\ndeclare r record; ok int := 0; fail int := 0; errs text := '';\nbegin\nfor r in select * from (values\n${chunk.map((c) => `(${c})`).join(",\n")}\n) as t(p_url, p_platform, p_market, p_published_at, p_title, p_content, p_demand_id, p_summary, p_quote, p_topic, p_confidence, p_author_name)\nloop\nbegin\nperform migrate_demand_post(r.p_url, r.p_platform, r.p_market, r.p_published_at::timestamptz, r.p_title, r.p_content, r.p_demand_id, r.p_summary, r.p_quote, r.p_topic, r.p_confidence::numeric, r.p_author_name, null);\nok := ok + 1;\nexception when others then fail := fail + 1; errs := errs || r.p_url || ' => ' || sqlerrm || E'\\n';\nend;\nend loop;\ninsert into app_config (key, value) values ('migrate_log_' || '${String(i).padStart(4, "0")}', jsonb_build_object('ok', ok, 'fail', fail, 'errs', errs)) on conflict (key) do update set value = excluded.value;\nraise notice 'batch done ok=% fail=%', ok, fail;\nend $mig$;`;
  const f = `/tmp/migrate-sql-${files.length}.json`;
  writeFileSync(f, JSON.stringify({ query: sql }));
  files.push(f);
}
console.log(`共 ${posts.length} 条 → ${files.length} 个批次 SQL, 写入 /tmp/migrate-sql-*.json`);
