// kol-backfill: 存量帖作者 KOL/KOC 回填 + priority_score 补算 (v4)
// 一次性任务函数, 幂等可重复调用: 每批处理 25 个作者, 进度存 app_config.kol_backfill_status
// 触发: 手动 curl / pg_net 循环调用直到 finished=true
import { cors, env, json, sb } from "../_shared/glue.ts";
import { priorityScore } from "../_shared/logic/priority.ts";
import { authScore, classifyTier, DEFAULT_KOL_RULES, extractEmail } from "../_shared/logic/kol.ts";

const TIKHUB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BATCH = 25;

/** 从帖子 url 提取 X handle */
function handleFromUrl(url: string): string | null {
  const m = url.match(/(?:^https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,20})\//i);
  return m ? m[1].replace(/^@/, "") : null;
}

/** TikHub 用户档案 (仅 X 平台) */
async function tikhubProfile(handle: string): Promise<{ followers: number | null; bio: string | null } | null> {
  if (!env.tikhubKey) return null;
  const r = await fetch(`https://api.tikhub.io/api/v1/twitter/web/fetch_user_profile?screen_name=${encodeURIComponent(handle)}`, {
    headers: { Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": TIKHUB_UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`TikHub profile ${r.status}`);
  const j = await r.json();
  const d = j?.data ?? {};
  return {
    followers: Number(d.followers_count ?? d.followers ?? d.follower_count) || null,
    bio: String(d.description ?? d.bio ?? "") || null,
  };
}

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const client = sb();

  // ---------- 1. 取全部待处理帖 (kol_tier='none'), 客户端按作者分组 ----------
  const q = client.from("demand_posts")
    .select("id, platform, market, url, author_id, author_name, topic, demand_id, state, metrics_json, published_at, kol_tier, priority_score")
    .eq("kol_tier", "none")
    .limit(1000);
  const { data: posts, error: qErr } = await q;
  const all = posts ?? [];

  // 同话题计数 (聚合分用)
  const topicCount = new Map<string, number>();
  for (const p of all) if (p.topic) topicCount.set(p.topic, (topicCount.get(p.topic) ?? 0) + 1);

  // 作者分组: key = platform:handle (X 从 url 提取; 其他平台没有档案接口, 不拉档案只补分)
  const groups = new Map<string, { platform: string; handle: string | null; authorId: string | null; authorName: string | null; posts: typeof all }>();
  for (const p of all) {
    let handle: string | null = p.author_id ?? null;
    if (!handle && p.platform === "x") handle = handleFromUrl(p.url ?? "");
    const key = `${p.platform}:${handle ?? "—" + p.id}`;
    let g = groups.get(key);
    if (!g) { g = { platform: p.platform, handle, authorId: p.author_id, authorName: p.author_name, posts: [] }; groups.set(key, g); }
    g.posts.push(p);
  }

  // ---------- 2. 优先处理 X 平台作者 (要拉档案), 其余平台只补 priority_score ----------
  const xAuthors = [...groups.values()].filter((g) => g.platform === "x" && g.handle);
  const otherGroups = [...groups.values()].filter((g) => g.platform !== "x");

  // 读取进度
  const { data: statusCfg } = await client.from("app_config").select("value").eq("key", "kol_backfill_status").single();
  const status = (statusCfg?.value ?? { processed: [] }) as { processed?: string[]; kol?: number; koc?: number; none?: number; errors?: number };
  const processed = new Set(status.processed ?? []);

  const pendingX = xAuthors.filter((g) => !processed.has(g.handle!));
  let batch = pendingX.slice(0, BATCH);
  let kol = status.kol ?? 0, koc = status.koc ?? 0, none = status.none ?? 0, errors = status.errors ?? 0;

  // ---------- 3. 逐作者: authors 表聚合 → 档案拉取 → 打标 → 回写 demand_posts ----------
  for (const g of batch) {
    try {
      const engagement = g.posts.reduce((s, p) => s + (p.metrics_json?.likes ?? 0) + (p.metrics_json?.comments ?? 0), 0);
      const maxEng = Math.max(...g.posts.map((p) => (p.metrics_json?.likes ?? 0) + (p.metrics_json?.comments ?? 0)), 0);

      // authors 表聚合 (upsert)
      const { data: exist } = await client.from("authors").select("*").eq("platform", "x").eq("author_id", g.handle).single();
      let cur: Record<string, unknown> | null;
      if (exist) {
        const { data: upd } = await client.from("authors").update({
          total_hits: (exist.total_hits ?? 0) + g.posts.length,
          total_engagement: (exist.total_engagement ?? 0) + engagement,
          max_engagement: Math.max(exist.max_engagement ?? 0, maxEng),
          name: g.authorName || exist.name,
          last_seen_at: new Date().toISOString(),
        }).eq("id", exist.id).select("*").single();
        cur = upd ?? exist;
      } else {
        const { data: ins } = await client.from("authors").insert({
          platform: "x", author_id: g.handle, name: g.authorName ?? null,
          total_hits: g.posts.length, total_engagement: engagement, max_engagement: maxEng,
          last_seen_at: new Date().toISOString(),
        }).select("*").single();
        cur = ins;
      }

      let followers: number | null = (cur?.followers as number | null) ?? null;
      let bio: string | null = (cur?.bio as string | null) ?? null;
      const fetchedAt = (cur?.profile_fetched_at as string | null) ?? null;
      const cooledDown = fetchedAt && Date.now() - new Date(fetchedAt).getTime() < 7 * 86400000;

      if (!cooledDown) {
        try {
          const profile = await tikhubProfile(g.handle!);
          if (profile) {
            followers = profile.followers ?? followers;
            bio = profile.bio ?? bio;
            const { email, source } = extractEmail(bio);
            const { data: upd } = await client.from("authors").update({
              followers, bio,
              email: email ?? (cur?.email as string | null),
              email_source: source ? "bio:x" : (cur?.email_source as string | null),
              profile_fetched_at: new Date().toISOString(),
            }).eq("id", cur!.id as string).select("*").single();
            cur = upd ?? cur;
          }
        } catch (e) { errors++; /* 档案失败按粉丝未知处理 */ }
      }

      let tier: "kol" | "koc" | "none" = "none";
      if (followers != null) {
        const rules = DEFAULT_KOL_RULES;
        const sample = g.posts[0];
        const sLikes = sample?.metrics_json?.likes ?? 0, sComments = sample?.metrics_json?.comments ?? 0;
        const histHits = (cur?.total_hits as number) ?? g.posts.length;
        const histEng = (cur?.total_engagement as number) ?? engagement;
        const histAvg = histHits > 1 ? (histEng - (sLikes + sComments)) / Math.max(1, histHits - 1) : 0;
        if (engagement > 0) {
          // 有互动数据: 完整三路真实度评分
          const { score, signals } = authScore({ followers, likes: sLikes, comments: sComments, authorAvgEngagement: histAvg }, rules);
          tier = classifyTier({ followers, likes: sLikes, comments: sComments, score }, rules);
          await client.from("authors").update({
            tier, auth_score: score,
            auth_signals: { ...signals, followers },
            avg_engagement: histHits > 1 ? histEng / histHits : (sLikes + sComments),
          }).eq("id", cur!.id as string);
        } else {
          // 存量迁移帖无互动数据: 按粉丝量分级, 标记 unknown_engagement 供建联时参考
          tier = followers >= rules.kol_followers_min ? "kol" : followers >= rules.koc_followers_min ? "koc" : "none";
          await client.from("authors").update({
            tier, auth_score: null,
            auth_signals: { followers, unknown_engagement: true },
          }).eq("id", cur!.id as string);
        }
      } else {
        await client.from("authors").update({ tier: "none", auth_score: null }).eq("id", cur!.id as string);
      }
      if (tier === "kol") kol++; else if (tier === "koc") koc++; else none++;
      processed.add(g.handle!);

      // 回写该作者的帖子: author_id/author_name/kol_tier + priority_score
      for (const p of g.posts) {
        const likes = p.metrics_json?.likes ?? 0, comments = p.metrics_json?.comments ?? 0;
        const score = priorityScore({
          likes, comments, publishedAt: p.published_at,
          isKol: tier === "kol", highEngAuthor: tier === "koc",
          sameTopicCount: p.topic ? (topicCount.get(p.topic) ?? 0) : 0,
        });
        await client.from("demand_posts").update({
          author_id: g.handle, author_name: p.author_name ?? g.authorName ?? g.handle,
          kol_tier: tier, priority_score: score,
        }).eq("id", p.id);
      }
    } catch (e) {
      errors++;
      processed.add(g.handle!); // 失败也标记, 防死循环
    }
  }

  // ---------- 4. 非 X 平台帖子: 只补 priority_score (tier 保持 none) ----------
  let scoredOthers = 0;
  for (const g of otherGroups) {
    for (const p of g.posts) {
      if ((p.priority_score ?? 0) > 0) continue;
      const likes = p.metrics_json?.likes ?? 0, comments = p.metrics_json?.comments ?? 0;
      const score = priorityScore({
        likes, comments, publishedAt: p.published_at,
        isKol: false, highEngAuthor: false,
        sameTopicCount: p.topic ? (topicCount.get(p.topic) ?? 0) : 0,
      });
      await client.from("demand_posts").update({ priority_score: score }).eq("id", p.id);
      scoredOthers++;
    }
  }

  // X 平台里 handle 提取失败的孤儿帖 (url 非标准) 也补分
  for (const g of groups.values()) {
    if (g.platform === "x" && !g.handle) {
      for (const p of g.posts) {
        if ((p.priority_score ?? 0) > 0) continue;
        const score = priorityScore({
          likes: p.metrics_json?.likes ?? 0, comments: p.metrics_json?.comments ?? 0, publishedAt: p.published_at,
          isKol: false, highEngAuthor: false, sameTopicCount: p.topic ? (topicCount.get(p.topic) ?? 0) : 0,
        });
        await client.from("demand_posts").update({ priority_score: score }).eq("id", p.id);
        scoredOthers++;
      }
    }
  }

  // ---------- 5. 写进度 ----------
  const finished = pendingX.length <= batch.length;
  const value = {
    processed: [...processed], kol, koc, none, errors,
    authors_total: xAuthors.length, authors_done: processed.size,
    scored_no_profile: scoredOthers, finished,
    updated_at: new Date().toISOString(),
  };
  await client.from("app_config").upsert({ key: "kol_backfill_status", value }, { onConflict: "key" });

  return json({
    ok: true,
    debug_all: all.length,
    debug_qerr: qErr?.message ?? null,
    debug_groups: groups.size,
    batch_processed: batch.length,
    x_authors_total: xAuthors.length,
    x_authors_remaining: Math.max(0, pendingX.length - batch.length),
    scored_no_profile: scoredOthers,
    kol, koc, none, errors,
    finished,
  });
});
