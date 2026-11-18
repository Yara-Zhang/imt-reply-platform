// reply-check: 回复效果追踪 (C3) — 已回复帖按 +24h/72h/7d 三轮回访, 抓取回复本身的赞评数
// 支持 X 平台 (fetch_tweet_detail); 其他平台该轮跳过不占坑, 端点后续按需补
// 触发: pg_cron 每 2 小时 (管理 API 注册); 也可手动调用, 幂等可重复
import { env, json, sb } from "../_shared/glue.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ROUNDS = [
  { round: 1, hours: 24 },
  { round: 2, hours: 72 },
  { round: 3, hours: 168 },
] as const;

/** 从回复链接提取 X tweet_id */
function tweetIdFromUrl(url: string): string | null {
  const m = url.match(/(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/i);
  return m ? m[1] : null;
}

/** 抓一条推文的赞/评数 (2026-11 实测结构: data.likes / data.replies / data.retweets) */
async function fetchTweetMetrics(tweetId: string): Promise<{ likes: number; comments: number; alive: boolean } | null> {
  if (!env.tikhubKey) return null;
  const r = await fetch(`https://api.tikhub.io/api/v1/twitter/web/fetch_tweet_detail?tweet_id=${encodeURIComponent(tweetId)}`, {
    headers: { Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 404) return { likes: 0, comments: 0, alive: false };
  if (!r.ok) throw new Error(`tweet_detail ${r.status}`);
  const j = await r.json();
  const d = j?.data ?? {};
  if (!d || Object.keys(d).length === 0) return { likes: 0, comments: 0, alive: false }; // 已删除
  return { likes: Number(d.likes ?? d.favorites) || 0, comments: Number(d.replies) || 0, alive: true };
}

Deno.serve(async () => {
  const client = sb();

  // 8 天内已回复且登记了链接的帖子
  const since = new Date(Date.now() - 8 * 86400000).toISOString();
  const { data: replied } = await client.from("demand_posts")
    .select("id, platform, reply_url, replied_at")
    .eq("state", "replied")
    .not("reply_url", "is", null)
    .gte("replied_at", since)
    .limit(200);

  // 已做过的轮次
  const { data: done } = await client.from("reply_outcomes").select("post_id, check_round");
  const doneSet = new Set((done ?? []).map((o) => `${o.post_id}:${o.check_round}`));

  let checked = 0, skippedPlatform = 0, failed = 0;
  for (const p of replied ?? []) {
    const hrs = (Date.now() - new Date(p.replied_at).getTime()) / 3600000;
    const tid = p.platform === "x" ? tweetIdFromUrl(p.reply_url ?? "") : null;
    if (!tid) { if (hrs >= 24) skippedPlatform++; continue; } // 非 X 平台暂不支持回访

    for (const { round, hours } of ROUNDS) {
      if (hrs < hours) break;
      if (doneSet.has(`${p.id}:${round}`)) continue;
      try {
        const m = await fetchTweetMetrics(tid);
        if (!m) { failed++; continue; }
        await client.from("reply_outcomes").insert({
          post_id: p.id, check_round: round,
          delta_likes: m.likes, delta_comments: m.comments,
          post_alive: m.alive,
          note: round === 1 ? "发出后 24h" : round === 2 ? "发出后 72h" : "发出后 7d",
        });
        checked++;
        doneSet.add(`${p.id}:${round}`);
      } catch { failed++; }
    }
  }

  return json({ ok: true, posts_scanned: replied?.length ?? 0, rounds_recorded: checked, skipped_platform: skippedPlatform, failed });
});
