// api-posts: 需求帖全生命周期 — 列表/详情/认领(条件更新)/保存草稿/母语审核/标记已回复/跳过/释放
import { cors, json, requireMember, sb } from "../_shared/glue.ts";
import { checkMarkReplied, claimConflictMessage, replyLang, canReview } from "../_shared/logic/state-machine.ts";
import { brandCheck } from "../_shared/logic/priority.ts";
import { outreachDirection } from "../_shared/logic/kol.ts";
import type { BrandIssue } from "../_shared/logic/types.ts";

async function brandIssuesFor(draft: string) {
  const client = sb();
  const [{ data: rules }, { data: brand }] = await Promise.all([
    client.from("app_config").select("value").eq("key", "brand_rules").single(),
    client.from("app_config").select("value").eq("key", "brand").single(),
  ]);
  const r = (rules?.value ?? { must: [], warn: [] }) as { must: never[]; warn: never[] };
  const site = ((brand?.value ?? {}) as { site?: string }).site ?? "https://immersivetranslate.com/";
  return brandCheck(draft, r, site);
}

async function stage(market: string) {
  const { data } = await sb().from("app_config").select("value").eq("key", "market_stage").single();
  return ((data?.value ?? {}) as Record<string, number>)[market] ?? 2;
}

async function currentReviewerName(market: string) {
  const client = sb();
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const ws = monday.toISOString().slice(0, 10);
  const { data: shift } = await client.from("weekly_shifts").select("reviewer_id").eq("week_start", ws).eq("market", market).single();
  if (shift?.reviewer_id) {
    const { data: m } = await client.from("members").select("name").eq("id", shift.reviewer_id).single();
    if (m?.name) return m.name;
  }
  const { data: r } = await client.from("members").select("name").contains("duties", [market === "jp" ? "ja_review" : "kr_review"]).limit(1);
  return r?.[0]?.name ?? "";
}

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const member = await requireMember(req);
  if (!member) return json({ error: "未登录或会话过期" }, 401);

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop() ?? "";
  const client = sb();
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  // ---------- GET list: 筛选/排序/分页 ----------
  if (req.method === "GET" && path === "list") {
    const p = url.searchParams;
    let q = client.from("demand_posts").select("*");
    if (p.get("state") && p.get("state") !== "all") q = q.eq("state", p.get("state")!);
    if (p.get("state") === "mine") q = q.eq("claimed_by", member.id).in("state", ["open", "claimed"]);
    if (p.get("market") && p.get("market") !== "all") q = q.eq("market", p.get("market")!);
    if (p.get("platform") && p.get("platform") !== "全部") q = q.eq("platform", p.get("platform")!);
    if (p.get("demand_id")) {
      q = p.get("demand_id") === "none" ? q.is("demand_id", null) : q.eq("demand_id", p.get("demand_id")!);
    }
    if (p.get("stale")) q = q.eq("stale", p.get("stale") === "1");
    else q = q.eq("stale", false);
    if (p.get("review") === "1") q = q.eq("state", "claimed").not("reply_draft", "is", null).is("ja_reviewed_at", null).in("market", ["jp", "kr"]);
    if (p.get("q")) q = q.or(`summary.ilike.%${p.get("q")}%,content.ilike.%${p.get("q")}%,quote.ilike.%${p.get("q")}%`);
    const days = Number(p.get("days") ?? 3);
    if (days > 0) q = q.gte("published_at", new Date(Date.now() - days * 86400000).toISOString());
    const sort = p.get("sort") ?? "score";
    q = sort === "time" ? q.order("published_at", { ascending: false }) : sort === "eng" ? q.order("metrics_json->>likes", { ascending: false }) : q.order("priority_score", { ascending: false });
    const page = Number(p.get("page") ?? 1);
    const { data, error } = await q.range((page - 1) * 40, page * 40 - 1);
    if (error) return json({ error: error.message }, 500);
    return json({ posts: data });
  }

  // ---------- GET stats: 统计带 ----------
  if (req.method === "GET" && path === "stats") {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - 7);
    const open = await client.from("demand_posts").select("id", { count: "exact", head: true }).eq("state", "open").eq("stale", false);
    const todayNew = await client.from("demand_posts").select("id", { count: "exact", head: true }).gte("created_at", todayStart.toISOString());
    const mine = await client.from("demand_posts").select("id", { count: "exact", head: true }).eq("claimed_by", member.id).eq("state", "claimed");
    const review = await client.from("demand_posts").select("id", { count: "exact", head: true }).eq("state", "claimed").not("reply_draft", "is", null).is("ja_reviewed_at", null).in("market", ["jp", "kr"]);
    const todayReplied = await client.from("demand_posts").select("id", { count: "exact", head: true }).eq("replied_by", member.id).gte("replied_at", todayStart.toISOString());
    const weekReplied = await client.from("demand_posts").select("id", { count: "exact", head: true }).eq("replied_by", member.id).gte("replied_at", weekStart.toISOString());
    return json({
      open: open.count ?? 0, today_new: todayNew.count ?? 0, mine: mine.count ?? 0,
      review: review.count ?? 0, today_replied: todayReplied.count ?? 0, week_replied: weekReplied.count ?? 0,
    });
  }

  // ---------- GET health: 管道健康 (P0 关键组件) ----------
  if (req.method === "GET" && path === "health") {
    const [{ data: jobs }, { data: usage }] = await Promise.all([
      client.from("crawl_jobs").select("*").order("created_at", { ascending: false }).limit(20),
      client.from("api_usage").select("*").eq("day", new Date().toISOString().slice(0, 10)),
    ]);
    const lastDone = jobs?.find((j) => j.status === "done");
    const lastFailed = jobs?.filter((j) => j.status === "failed") ?? [];
    const todayCount = await client.from("crawl_items").select("id", { count: "exact", head: true }).gte("created_at", new Date().toISOString().slice(0, 10));
    const demandToday = await client.from("demand_posts").select("id", { count: "exact", head: true }).gte("created_at", new Date().toISOString().slice(0, 10));
    return json({
      last_round_at: lastDone?.finished_at ?? null,
      today_fetched: todayCount.count ?? 0,
      today_demand: demandToday.count ?? 0,
      today_failed: lastFailed.length,
      last_error: lastFailed[0]?.error ?? null,
      spend: usage?.map((u) => ({ provider: u.provider, cost: u.cost, calls: u.calls })) ?? [],
    });
  }

  // ---------- GET report: 周报聚合 (平台内查看+下载, 飞书推送已移除) ----------
  // 参数 week_offset: 0=本周(周一至今), 1=上周, 2=前周…
  if (req.method === "GET" && path === "report") {
    const offset = Math.max(0, Number(url.searchParams.get("week_offset") ?? 0));
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - offset * 7);
    const nextMonday = new Date(monday.getTime() + 7 * 86400000);
    const from = monday.toISOString(), to = nextMonday.toISOString();

    // 本周入库的需求帖 (含已冷却, 反映抓取全貌)
    const { data: weekPosts } = await client.from("demand_posts")
      .select("id, market, platform, state, demand_id, topic, summary, quote, quote_verified, metrics_json, kol_tier, author_id, author_name, published_at, created_at, claimed_at, replied_at, skip_reason")
      .gte("created_at", from).lt("created_at", to);
    const wp = weekPosts ?? [];

    const mk = (m) => wp.filter((p) => p.market === m);
    const marketRows = ["cn", "en", "jp", "kr"].map((m) => {
      const arr = mk(m);
      return { market: m, total: arr.length, replied: arr.filter((p) => p.state === "replied").length };
    });
    const platCount = new Map<string, number>();
    for (const p of wp) platCount.set(p.platform, (platCount.get(p.platform) ?? 0) + 1);
    const platformRows = [...platCount.entries()].map(([platform, total]) => ({ platform, total })).sort((a, b) => b.total - a.total);

    // Top 互动帖 (按赞+评排序, 展示卡点原话)
    const top = [...wp].sort((a, b) =>
      ((b.metrics_json?.likes ?? 0) + (b.metrics_json?.comments ?? 0)) - ((a.metrics_json?.likes ?? 0) + (a.metrics_json?.comments ?? 0)))
      .slice(0, 5);

    // 同事回复排行 (按 replied_at 落在本周)
    const { data: repliers } = await client.from("demand_posts").select("replied_by").gte("replied_at", from).lt("replied_at", to).not("replied_by", "is", null);
    const names = new Map<string, number>();
    for (const r of repliers ?? []) names.set(r.replied_by, (names.get(r.replied_by) ?? 0) + 1);
    const { data: memberRows } = await client.from("members").select("id, name").in("id", [...names.keys()].length ? [...names.keys()] : ["00000000-0000-0000-0000-000000000000"]);
    const leaderboard = memberRows?.map((m) => ({ name: m.name, replied: names.get(m.id) ?? 0 })).sort((a, b) => b.replied - a.replied) ?? [];

    // 平均响应时长 (发布→标记回复, 小时)
    const lat = wp.filter((p) => p.state === "replied" && p.published_at && p.replied_at)
      .map((p) => (new Date(p.replied_at).getTime() - new Date(p.published_at).getTime()) / 3600000);
    const avgHours = lat.length ? Math.round(lat.reduce((s, x) => s + x, 0) / lat.length * 10) / 10 : null;

    // KOL/KOC 命中 (本周帖子上打了标的)
    const kolHits = wp.filter((p) => p.kol_tier === "kol");
    const kocHits = wp.filter((p) => p.kol_tier === "koc");

    // 品牌负面告警 (本周入库 brand_posts 的负面)
    const { count: brandNeg } = await client.from("brand_posts").select("id", { count: "exact", head: true })
      .gte("created_at", from).lt("created_at", to).eq("sentiment", "neg");

    const replied = wp.filter((p) => p.state === "replied").length;
    return json({
      week_start: from.slice(0, 10), week_end: to.slice(0, 10),
      new_posts: wp.length, replied, skipped: wp.filter((p) => p.state === "skipped").length,
      open_left: wp.filter((p) => p.state === "open").length,
      reply_rate: wp.length ? Math.round((replied / wp.length) * 100) : 0,
      avg_reply_hours: avgHours,
      market_rows: marketRows, platform_rows: platformRows,
      top_posts: top, leaderboard,
      kol_hits: kolHits.length, koc_hits: kocHits.length,
      kol_authors: kolHits.slice(0, 5).map((p) => ({ name: p.author_name ?? p.author_id, market: p.market, platform: p.platform, summary: p.summary })),
      brand_neg: brandNeg ?? 0,
    });
  }

  // ---------- GET outreach: 建联卡片数据 (spec C2 增强版) ----------
  if (req.method === "GET" && path === "outreach") {
    const key = url.searchParams.get("author") ?? ""; // 格式 platform:author_id
    const [platform, authorId] = key.split(":");
    if (!platform || !authorId) return json({ error: "缺少 author 参数" }, 400);
    const { data: author } = await client.from("authors")
      .select("*").eq("platform", platform).eq("author_id", authorId).single();
    if (!author) return json({ error: "作者档案不存在" }, 404);

    // 近 30 天该作者的帖子话题 top3 + 主导场景
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: theirPosts } = await client.from("demand_posts")
      .select("topic, demand_id, summary").eq("platform", platform).eq("author_id", authorId)
      .gte("published_at", since).order("published_at", { ascending: false }).limit(20);
    const topicCount = new Map<string, number>();
    for (const p of theirPosts ?? []) if (p.topic) topicCount.set(p.topic, (topicCount.get(p.topic) ?? 0) + 1);
    const topics = [...topicCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
    const mainDemandId = theirPosts?.find((p) => p.demand_id)?.demand_id ?? null;
    let feature: string | undefined;
    if (mainDemandId) {
      const { data: scene } = await client.from("demand_scenes").select("feature").eq("id", mainDemandId).single();
      feature = scene?.feature ?? undefined;
    }

    const tier = (author.tier === "kol" || author.tier === "koc") ? author.tier : "none";
    const direction = tier === "none"
      ? ""
      : outreachDirection({
          platform, authorName: author.name ?? authorId, topics, sceneFeature: feature,
          market: "cn", tier,
        });

    return json({
      author: {
        platform, author_id: authorId, name: author.name, followers: author.followers,
        tier: author.tier, auth_score: author.auth_score, auth_signals: author.auth_signals,
        email: author.email, email_source: author.email_source, bio: author.bio,
        total_hits: author.total_hits, avg_engagement: author.avg_engagement,
        max_engagement: author.max_engagement,
      },
      topics, scene_feature: feature ?? null, direction,
    });
  }

  // ---------- POST 动作 ----------
  if (req.method === "POST") {
    const id = body.id as string | undefined;
    if (!id) return json({ error: "缺少帖子 id" }, 400);
    const { data: post } = await client.from("demand_posts").select("*").eq("id", id).single();
    if (!post) return json({ error: "帖子不存在" }, 404);

    switch (path) {
      // 认领: 条件更新 (v1 防并发方案)
      case "claim": {
        const { data: updated, count } = await client.from("demand_posts")
          .update({ state: "claimed", claimed_by: member.id, claimed_at: new Date().toISOString() })
          .eq("id", id).eq("state", "open")
          .select("*");
        if (!count) {
          const claimer = post.claimed_by
            ? (await client.from("members").select("name").eq("id", post.claimed_by).single())?.data?.name ?? "其他同事"
            : "其他同事";
          return json({ error: claimConflictMessage(claimer, post.claimed_at ?? new Date().toISOString()) }, 409);
        }
        return json({ post: updated?.[0] });
      }

      // 保存草稿: 重新品牌检查; 有改动清空母语审核 (v2 规则)
      case "draft": {
        const draft = (body.ddraft ?? body.draft) as string;
        const patch: Record<string, unknown> = {
          reply_draft: draft?.slice(0, 4000) ?? "",
          draft_at: new Date().toISOString(),
          brand_issues: await brandIssuesFor(draft ?? ""),
        };
        if (draft !== post.reply_draft) {
          patch.ja_reviewed_by = null;
          patch.ja_reviewed_at = null;
        }
        const { data: updated } = await client.from("demand_posts").update(patch).eq("id", id).select("*").single();
        return json({ post: updated });
      }

      // 母语审核通过 (职责校验)
      case "review": {
        const approve = body.approve !== false;
        if (approve && !canReview(post.market, member)) {
          return json({ error: `需要${post.market === "jp" ? "日语" : "韩语"}审核职责的成员才能通过` }, 403);
        }
        const patch = approve
          ? { ja_reviewed_by: member.id, ja_reviewed_at: new Date().toISOString() }
          : { ja_reviewed_by: null, ja_reviewed_at: null, note: `审核驳回(${member.name}): ${body.reason ?? ""}` };
        const { data: updated } = await client.from("demand_posts").update(patch).eq("id", id).select("*").single();
        return json({ post: updated });
      }

      // 标记已回复 (拦截规则全接入)
      case "replied": {
        const issues = (post.brand_issues ?? []) as BrandIssue[];
        const block = checkMarkReplied({ ...post, brand_issues: issues }, await currentReviewerName(post.market));
        if (block.blocked) return json({ error: block.message }, 400);
        const patch: Record<string, unknown> = {
          state: "replied", replied_by: member.id, replied_at: new Date().toISOString(),
          reply_url: body.reply_url ?? null, reply_account: body.reply_account ?? null,
          metrics_before: post.metrics_json ?? {},
        };
        if (!post.claimed_by) patch.claimed_by = member.id;
        const { data: updated } = await client.from("demand_posts").update(patch).eq("id", id).select("*").single();
        return json({ post: updated });
      }

      // 跳过 (原因必填)
      case "skip": {
        const reason = (body.reason as string | undefined) || "跳过";
        const { data: updated } = await client.from("demand_posts").update({
          state: "skipped",
          skip_reason: `${reason}（${member.email ?? member.name}）`,
        }).eq("id", id).select("*").single();
        return json({ post: updated });
      }

      // 释放 / 重新打开 (软确认由前端弹, 服务端记录操作人)
      case "release": {
        const patch: Record<string, unknown> = { state: "open", claimed_by: null, claimed_at: null, claim_deadline: null };
        if (body.reopen) {
          patch.replied_by = null; patch.replied_at = null; patch.reply_url = null;
          patch.reply_draft = null; patch.ja_reviewed_by = null; patch.ja_reviewed_at = null;
        }
        await client.from("op_log").insert({ table_name: "demand_posts", row_id: id, action: body.reopen ? "reopen" : "release", operator: member.id, detail: { prev_owner: post.claimed_by } });
        const { data: updated } = await client.from("demand_posts").update(patch).eq("id", id).select("*").single();
        return json({ post: updated });
      }

      // 改归需求场景
      case "redemand": {
        if (body.demand_id) {
          const { data: scene } = await client.from("demand_scenes").select("id").eq("id", body.demand_id).single();
          if (!scene) return json({ error: "场景编号不存在" }, 400);
        }
        const { data: updated } = await client.from("demand_posts").update({ demand_id: body.demand_id ?? null }).eq("id", id).select("*").single();
        return json({ post: updated });
      }
    }
  }

  return json({ error: "not found" }, 404);
});
