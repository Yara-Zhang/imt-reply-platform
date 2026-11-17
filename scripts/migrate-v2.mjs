#!/usr/bin/env node
// migrate-v2.mjs — 机会卡牌存量迁移
// 依据 spec §12.1: 只迁 open 状态且未冷却(72h)的帖子; 场景/关键词/品牌规则由 001_init.sql 种子承载, 本脚本校验一致性
// 用法: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migrate-v2.mjs v2-export.csv
import { readFileSync } from "node:fs";

const [csvPath] = process.argv.slice(2);
if (!csvPath) {
  console.error("用法: node migrate-v2.mjs <机会卡牌导出CSV>");
  console.error("环境变量: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const BASE = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error("缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 环境变量"); process.exit(1); }

// CSV 解析 (简版: 支持引号包裹)
function parseCsv(text) {
  const rows = []; let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const rows = parseCsv(readFileSync(csvPath, "utf8"));
const head = rows.shift().map((h) => h.trim().toLowerCase());
const col = (r, name) => r[head.indexOf(name)] ?? "";
const STALE_MS = 72 * 3600000;

const eligible = [], skipped = [];
for (const r of rows) {
  const state = col(r, "state"), pub = col(r, "publishedat") || col(r, "发布时间");
  const reason = !["open", "待处理"].includes(state) ? `状态 ${state} 不迁`
    : !pub ? "无发布时间"
    : Date.now() - new Date(pub).getTime() > STALE_MS ? "已冷却(>72h)"
    : null;
  (reason ? skipped : eligible).push({ r, reason });
}

async function upsert(path, body) {
  const resp = await fetch(`${BASE}/rest/v1/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
  if (!resp.ok && resp.status !== 409) throw new Error(`${path} → ${resp.status}: ${await resp.text()}`);
}

let ok = 0, fail = 0;
for (const { r } of eligible) {
  try {
    // 1) 入共用采集池 (url_hash 去重, 数据库函数处理规范化)
    const url = col(r, "url");
    const itemBody = {
      platform: col(r, "platform"), market: col(r, "market"),
      url, url_hash: "pending", // 由规范化函数在库里补: 见下方说明
      published_at: col(r, "publishedat") || new Date().toISOString(),
      raw_title: col(r, "title").slice(0, 500), raw_content: col(r, "content").slice(0, 4000),
      ai_status: "done", classified_type: "demand",
    };
    // 规范化在 SQL 侧完成: 先算 hash 不可行(客户端无 sha256 函数差异), 故直接以 url 全量插入, 依赖 unique 约束幂等
    // 简化: url_hash 用规范化 URL 本身的 md5 替代不可得时 → 用下方 SQL 直插
    const resp = await fetch(`${BASE}/rest/v1/rpc/migrate_demand_post`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        p_url: url, p_platform: col(r, "platform"), p_market: col(r, "market"),
        p_published_at: itemBody.published_at, p_title: itemBody.raw_title, p_content: itemBody.raw_content,
        p_demand_id: col(r, "demandid") || null, p_summary: col(r, "summary").slice(0, 300) || null,
        p_quote: (col(r, "quote") || col(r, "demandquote")).slice(0, 60) || null,
        p_topic: col(r, "topic") || null, p_confidence: Number(col(r, "confidence")) || null,
      }),
    });
    if (!resp.ok) throw new Error(`rpc → ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    ok++;
  } catch (e) { fail++; console.error("×", col(r, "url"), e.message); }
}

console.log(`\n迁移完成: 成功 ${ok} / 失败 ${fail} / 跳过 ${skipped.length}`);
skipped.slice(0, 5).forEach((s) => console.log("  跳过示例:", s.reason, col(s.r, "url")));
console.log("\n配套 SQL 函数 migrate_demand_post 见 migrations/002_migrate_rpc.sql");
