// kol-backfill: 存量帖作者 KOL/KOC 回填 + priority_score 补算 (v4; v4.1 扩展微博/Reddit/小红书)
// 一次性任务函数, 幂等可重复调用: 每批处理 25 个作者, 进度存 app_config.kol_backfill_status
// 触发: 手动 curl / pg_net 循环调用直到 finished=true
import { cors, json, sb } from "../_shared/glue.ts";
import { tikhubProfile } from "../_shared/profile.ts";
import { priorityScore } from "../_shared/logic/priority.ts";
import { authScore, classifyTier, DEFAULT_KOL_RULES, extractEmail } from "../_shared/logic/kol.ts";

const BATCH = 25;
/** 有档案端点的平台; x=screen_name, weibo=显示名(search), reddit=username, xiaohongshu=user_id */
const PROFILED = new Set(["x", "weibo", "reddit", "xiaohongshu"]);

/** 从帖子 url 提取 X handle */
function handleFromUrl(url: string): string | null {
  const m = url.match(/(?:^https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/(@?[A-Za-z0-9_]{1,20})\//i);
  return m ? m[1].replace(/^@/, "") : null;
}

/** 各平台的作者查询键 (供档案端点与 authors 表主键使用) */
function authorKeyOf(p: { platform: string; url: string; author_id: string | null; author_name: string | null }): string | null {
  if (p.platform === "x") return handleFromUrl(p.url ?? "") ?? p.author_id;
  if (p.platform === "weibo") return p.author_id ?? p.author_name; // search 按名字查
  if (p.platform === "reddit") return (p.author_id ?? p.author_name)?.replace(/^\/?u\//, "") ?? null; // username 即显示名 (去 /u/ 前缀)
  if (p.platform === "xiaohongshu") return p.author_id; // 必须 user_id, 存量帖拿不到
  return p.author_id;
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

  // 作者分组: key = platform:handle
  const groups = new Map<string, { platform: string; handle: string | null; authorName: string | null; posts: typeof all }>();
  for (const p of all) {
    const handle = authorKeyOf(p as never);
    const key = `${p.platform}:${handle ?? "—" + p.id}`;
    let g = groups.get(key);
    if (!g) { g = { platform: p.platform, handle, authorName: p.author_name, posts: [] }; groups.set(key, g); }
    g.posts.push(p);
  }

  // ---------- 2. 有档案端点平台的作者 (x/weibo/reddit/xiaohongshu), 其余只补分 ----------
  const profiledAuthors = [...groups.values()].filter((g) => PROFILED.has(g.platform) && g.handle);
  const otherGroups = [...groups.values()].filter((g) => !PROFILED.has(g.platform) || !g.handle);

  // 读取进度
  const { data: statusCfg } = await client.from("app_config").select("value").eq("key", "kol_backfill_status").single();
  const status = (statusCfg?.value ?? { processed: [] }) as { processed?: string[]; kol?: number; koc?: number; none?: number; errors?: number };
  const processed = new Set(status.processed ?? []);

  const pending = profiledAuthors.filter((g) => !processed.has(`${g.platform}:${g.handle}`));
  let batch = pending.slice(0, BATCH);
  let kol = status.kol ?? 0, koc = status.koc ?? 0, none = status.none ?? 0, errors = status.errors ?? 0;

  // ---------- 3. 逐作者: authors 表聚合 → 档案拉取 → 打标 → 回写 demand_posts ----------
  for (const g of batch) {
    const pkey = `${g.platform}:${g.handle}`;
    try {
      const engagement = g.posts.reduce((s, p) => s + (p.metrics_json?.likes ?? 0) + (p.metrics_json?.comments ?? 0), 0);
      const maxEng = Math.max(...g.posts.map((p) => (p.metrics_json?.likes ?? 0) + (p.metrics_json?.comments ?? 0)), 0);

      // authors 表聚合 (upsert, 平台各自的键)
      const { data: exist } = await client.from("authors").select("*").eq("platform", g.platform).eq("author_id", g.handle).maybeSingle();
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
          platform: g.platform, author_id: g.handle, name: g.authorName ?? null,
          total_hits: g.posts.length, total_engagement: engagement, max_engagement: maxEng,
          last_seen_at: new Date().toISOString(),
        }).select("*").single();
        cur = ins;
      }

      let followers: number | null = (cur?.followers as number | null) ?? null;
      let bio: string | null = (cur?.bio as string | null) ?? null;
      let resolvedId: string | null = g.handle;
      let karma: number | null = null;
      const fetchedAt = (cur?.profile_fetched_at as string | null) ?? null;
      const cooledDown = fetchedAt && Date.now() - new Date(fetchedAt).getTime() < 7 * 86400000;

      if (!cooledDown) {
        try {
          const profile = await tikhubProfile(g.platform, g.handle!, g.authorName);
          if (profile) {
            followers = profile.followers ?? followers;
            bio = profile.bio ?? bio;
            karma = profile.karma ?? null;
            resolvedId = profile.resolvedId ?? g.handle; // 微博 search 中转后是真实 uid
            const { email, source } = extractEmail(bio);
            const { data: upd } = await client.from("authors").update({
              followers, bio,
              author_id: resolvedId,
              email: email ?? (cur?.email as string | null),
              email_source: source ? `bio:${g.platform}` : (cur?.email_source as string | null),
              profile_fetched_at: new Date().toISOString(),
            }).eq("id", cur!.id as string).select("*").single();
            cur = upd ?? cur;
          }
        } catch { errors++; /* 档案失败按粉丝未知处理 */ }
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
            auth_signals: { ...signals, followers, ...(karma != null ? { karma } : {}) },
            avg_engagement: histHits > 1 ? histEng / histHits : (sLikes + sComments),
          }).eq("id", cur!.id as string);
        } else {
          // 存量迁移帖无互动数据: 按粉丝量分级, 标记 unknown_engagement 供建联时参考
          tier = followers >= rules.kol_followers_min ? "kol" : followers >= rules.koc_followers_min ? "koc" : "none";
          // Reddit 无粉丝字段: 高 karma 用户兜底分级 (10万=kol, 1万=koc)
          if (tier === "none" && karma != null) {
            tier = karma >= 100000 ? "kol" : karma >= 10000 ? "koc" : "none";
          }
          await client.from("authors").update({
            tier, auth_score: null,
            auth_signals: { followers, unknown_engagement: true, ...(karma != null ? { karma } : {}) },
          }).eq("id", cur!.id as string);
        }
      } else if (karma != null) {
        // 无粉丝但有 karma (Reddit): 按 karma 兜底
        tier = karma >= 100000 ? "kol" : karma >= 10000 ? "koc" : "none";
        await client.from("authors").update({
          tier, auth_score: null,
          auth_signals: { karma, unknown_engagement: true },
        }).eq("id", cur!.id as string);
      } else {
        await client.from("authors").update({ tier: "none", auth_score: null }).eq("id", cur!.id as string);
      }
      if (tier === "kol") kol++; else if (tier === "koc") koc++; else none++;
      processed.add(pkey);

      // 回写该作者的帖子: author_id/author_name/kol_tier + priority_score
      for (const p of g.posts) {
        const likes = p.metrics_json?.likes ?? 0, comments = p.metrics_json?.comments ?? 0;
        const score = priorityScore({
          likes, comments, publishedAt: p.published_at,
          isKol: tier === "kol", highEngAuthor: tier === "koc",
          sameTopicCount: p.topic ? (topicCount.get(p.topic) ?? 0) : 0,
        });
        await client.from("demand_posts").update({
          author_id: resolvedId, author_name: p.author_name ?? g.authorName ?? g.handle,
          kol_tier: tier, priority_score: score,
        }).eq("id", p.id);
      }
    } catch (e) {
      errors++;
      processed.add(pkey); // 失败也标记, 防死循环
    }
  }

  // ---------- 4. 无档案端点平台的帖子: 只补 priority_score (tier 保持 none) ----------
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

  // ---------- 5. 写进度 ----------
  const finished = pending.length <= batch.length;
  const value = {
    processed: [...processed], kol, koc, none, errors,
    authors_total: profiledAuthors.length, authors_done: processed.size,
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
    authors_total: profiledAuthors.length,
    authors_remaining: Math.max(0, pending.length - batch.length),
    scored_no_profile: scoredOthers,
    kol, koc, none, errors,
    finished,
  });
});
