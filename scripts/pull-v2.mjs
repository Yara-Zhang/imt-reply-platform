#!/usr/bin/env node
// pull-v2.mjs — 从机会卡牌 v2 拉取全量 open 需求帖 (tRPC 分页, cursor 方式)
// 用法: V2_COOKIE='...' node pull-v2.mjs
import { writeFileSync } from "node:fs";

const COOKIE = process.env.V2_COOKIE;
if (!COOKIE) { console.error("缺少 V2_COOKIE 环境变量"); process.exit(1); }
const BASE = "https://imtcard.manus.space/api/trpc/demand.list";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

async function fetchPage(cursor) {
  const input = { json: { state: "open", demandId: null, market: null, days: 90, ...(cursor ? { cursor } : {}) } };
  const url = `${BASE}?input=${encodeURIComponent(JSON.stringify(input))}`;
  const r = await fetch(url, { headers: { accept: "*/*", cookie: COOKIE, referer: "https://imtcard.manus.space/demand", "user-agent": UA } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  if (j.error) throw new Error(`tRPC error: ${JSON.stringify(j.error).slice(0, 300)}`);
  return j.result.data.json;
}

const all = [];
let cursor = null, pages = 0;
do {
  const page = await fetchPage(cursor);
  if (pages === 0) console.log("byState:", JSON.stringify(page.byState), "mine:", page.mine);
  all.push(...page.posts);
  pages++;
  console.log(`page ${pages}: +${page.posts.length} (total ${all.length}) nextCursor=${page.nextCursor}`);
  cursor = page.nextCursor;
  await new Promise((r) => setTimeout(r, 400)); // 温和限速
} while (cursor);

// 统计
const byMarket = {}, byPlatform = {};
for (const p of all) { byMarket[p.market] = (byMarket[p.market] ?? 0) + 1; byPlatform[p.platform] = (byPlatform[p.platform] ?? 0) + 1; }
const fresh = all.filter((p) => Date.now() - new Date(p.publishedAt).getTime() < 72 * 3600000).length;
console.log("\n=== 汇总 ===");
console.log("open 总数(90天内):", all.length);
console.log("按市场:", JSON.stringify(byMarket));
console.log("按平台:", JSON.stringify(byPlatform));
console.log(`新鲜(<72h): ${fresh} / 已冷却(>72h): ${all.length - fresh}`);

writeFileSync("/tmp/v2-open-posts.json", JSON.stringify(all, null, 1));
console.log("\n已保存 → /tmp/v2-open-posts.json");
