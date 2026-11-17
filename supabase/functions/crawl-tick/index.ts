// crawl-tick: 每 5 分钟一轮 — 队列出队(优先级防饿死) → TikHub 抓取 → DeepSeek 批量初筛 → 双通道分流 → quote 门槛 → 入库
// 触发: pg_cron 通过 pg_net 调用本 function (v1 模式, DEPLOY.md 有配置步骤)
import { env, json, sb } from "../_shared/glue.ts";
import { deepSeekJson } from "../_shared/glue.ts";
import { demandGate, hashUrl, marketOf, verifyQuote } from "../_shared/logic/gates.ts";
import { priorityScore, isStale } from "../_shared/logic/priority.ts";
import { screenSystemPrompt, screenUserPrompt } from "../_shared/logic/prompts.ts";
import { authScore, classifyTier, DEFAULT_KOL_RULES, extractEmail, shouldFetchProfile } from "../_shared/logic/kol.ts";

/** KOL/KOC 分层: 作者聚合 → (按需)档案拉取 → 真实度评分 → tier */
async function classifyAuthor(c: { platform: string; authorId: string; authorName: string; likes: number; comments: number }): Promise<"kol" | "koc" | "none"> {
  const client = sb();
  const engagement = c.likes + c.comments;

  // ---- 作者聚合: 读-改-写 (该规模下竞态可接受, 唯一键兜底) ----
  const { data: exist } = await client.from("authors")
    .select("*").eq("platform", c.platform).eq("author_id", c.authorId).single();
  let cur: Record<string, unknown> | null;
  if (exist) {
    const { data: upd } = await client.from("authors").update({
      total_hits: (exist.total_hits ?? 0) + 1,
      total_engagement: (exist.total_engagement ?? 0) + engagement,
      max_engagement: Math.max(exist.max_engagement ?? 0, engagement),
      name: c.authorName || exist.name,
      last_seen_at: new Date().toISOString(),
    }).eq("id", exist.id).select("*").single();
    cur = upd ?? exist;
  } else {
    const { data: ins } = await client.from("authors").insert({
      platform: c.platform, author_id: c.authorId, name: c.authorName || null,
      total_hits: 1, total_engagement: engagement, max_engagement: engagement,
      last_seen_at: new Date().toISOString(),
    }).select("*").single();
    cur = ins;
  }
  if (!cur) return "none";

  const rules = DEFAULT_KOL_RULES;
  let followers: number | null = (cur.followers as number | null) ?? null;
  let bio: string | null = (cur.bio as string | null) ?? null;

  // ---- 成本闸门: 互动达标且档案过期 → 拉档案 (含 bio 邮箱提取) ----
  if (shouldFetchProfile({ engagement, profileFetchedAt: (cur.profile_fetched_at as string | null) ?? null }, rules)) {
    try {
      const profile = await tikhubProfile(c.platform, c.authorId);
      if (profile) {
        followers = profile.followers ?? followers;
        bio = profile.bio ?? bio;
        const { email, source } = extractEmail(bio);
        const { data: upd } = await client.from("authors").update({
          followers, bio,
          email: email ?? (cur.email as string | null),
          email_source: source ? `bio:${c.platform}` : (cur.email_source as string | null),
          profile_fetched_at: new Date().toISOString(),
        }).eq("id", cur.id as string).select("*").single();
        cur = upd ?? cur;
      }
    } catch { /* 档案拉取失败不阻塞主流程 */ }
  }

  if (followers == null) {
    await client.from("authors").update({ tier: "none", auth_score: null }).eq("id", cur.id as string);
    return "none";
  }

  // ---- 真实度评分 + 分层 (spec C2: 三路信号) ----
  const histHits = (cur.total_hits as number) ?? 1;
  const histEng = (cur.total_engagement as number) ?? engagement;
  const histAvg = histHits > 1 ? (histEng - engagement) / Math.max(1, histHits - 1) : 0;
  const { score, signals } = authScore({ followers, likes: c.likes, comments: c.comments, authorAvgEngagement: histAvg }, rules);
  const tier = classifyTier({ followers, likes: c.likes, comments: c.comments, score }, rules);

  await client.from("authors").update({
    tier, auth_score: score,
    auth_signals: { ...signals, followers },
    avg_engagement: histHits > 1 ? histEng / histHits : engagement,
  }).eq("id", cur.id as string);

  return tier;
}

/** TikHub 用户详情 (followers + bio); P0 支持 X, 其他平台返回 null (端点按 OpenAPI 校准) */
async function tikhubProfile(platform: string, authorId: string): Promise<{ followers: number | null; bio: string | null } | null> {
  const paths: Record<string, string> = {
    x: "/api/v1/twitter/web/fetch_user_profile?screen_name=" + encodeURIComponent(authorId),
    // 其他平台端点在 P1 按需补充
  };
  const path = paths[platform];
  if (!path || !env.tikhubKey) return null;
  const r = await fetch(`https://api.tikhub.io${path}`, {
    headers: { Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": TIKHUB_UA },
  });
  if (!r.ok) throw new Error(`TikHub profile ${platform} ${r.status}`);
  const j = await r.json();
  const d = j?.data ?? {};
  return {
    followers: Number(d.followers_count ?? d.followers ?? d.follower_count) || null,
    bio: String(d.description ?? d.bio ?? "") || null,
  };
}

// ---------- TikHub 适配层 (2026-11-17 按 OpenAPI 实测校准: 端点带 /api/v1/ 前缀, 多为 GET+query) ----------
const TIKHUB_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 归一化帖子: 各平台适配器的统一输出 */
interface Norm {
  url: string; title: string; content: string; publishedIso: string;
  likes: number; comments: number;
  authorId: string; authorName: string; authorFollowers?: number;
}

/** 相对时间解析: "15秒前"/"3分钟前"/"2小时前"/"昨天"/"2 years ago"/"3 days ago"/标准格式 */
function parseRelTime(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const now = Date.now();
  if (/刚刚|just now/.test(s)) return new Date(now).toISOString();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/(\d+)\s*秒前/))) return new Date(now - +m[1] * 1000).toISOString();
  if ((m = s.match(/(\d+)\s*分钟前/))) return new Date(now - +m[1] * 60000).toISOString();
  if ((m = s.match(/(\d+)\s*个?小时前/))) return new Date(now - +m[1] * 3600000).toISOString();
  if ((m = s.match(/(\d+)\s*天前/))) return new Date(now - +m[1] * 86400000).toISOString();
  if (/昨天/.test(s)) return new Date(now - 86400000).toISOString();
  if ((m = s.match(/(\d+)\s*seconds?\s*ago/))) return new Date(now - +m[1] * 1000).toISOString();
  if ((m = s.match(/(\d+)\s*minutes?\s*ago/))) return new Date(now - +m[1] * 60000).toISOString();
  if ((m = s.match(/(\d+)\s*hours?\s*ago/))) return new Date(now - +m[1] * 3600000).toISOString();
  if ((m = s.match(/(\d+)\s*days?\s*ago/))) return new Date(now - +m[1] * 86400000).toISOString();
  if ((m = s.match(/(\d+)\s*weeks?\s*ago/))) return new Date(now - +m[1] * 7 * 86400000).toISOString();
  if ((m = s.match(/(\d+)\s*months?\s*ago/))) return new Date(now - +m[1] * 30 * 86400000).toISOString();
  if ((m = s.match(/(\d+)\s*years?\s*ago/))) return new Date(now - +m[1] * 365 * 86400000).toISOString();
  const d = new Date(s); // "Mon Nov 16 18:40:17 +0000 2026" 等
  return isNaN(d.getTime()) ? null : d.toISOString();
}

const num = (v: unknown): number => { const n = Number(v); return isNaN(n) ? 0 : n; };
const S = (v: unknown): string => (v == null ? "" : String(v));
/** unix 时间戳(秒/毫秒自适应) → ISO */
const tsIso = (v: unknown): string => {
  const n = num(v);
  if (!n) return "";
  return new Date(n > 1e12 ? n : n > 1e9 ? n * 1000 : 0).toISOString();
};

async function tget(path: string): Promise<Record<string, unknown>> {
  const r = await fetch(`https://api.tikhub.io${path}`, {
    headers: { Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": TIKHUB_UA },
  });
  if (!r.ok) throw new Error(`TikHub ${r.status}`);
  return await r.json() as Record<string, unknown>;
}
async function tpost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`https://api.tikhub.io${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": TIKHUB_UA },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`TikHub ${r.status}`);
  return await r.json() as Record<string, unknown>;
}

/** 深挖: 找到第一个"元素为对象数组的非空列表" */
function digList(obj: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || obj == null) return [];
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === "object" && obj[0] != null) return obj as Record<string, unknown>[];
    const merged: Record<string, unknown>[] = [];
    for (const v of obj) merged.push(...digList(v, depth + 1));
    return merged.slice(0, 30);
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      const hit = digList(v, depth + 1);
      if (hit.length) return hit;
    }
  }
  return [];
}

async function tikhubSearch(platform: string, keyword: string, market: string): Promise<Norm[]> {
  if (!env.tikhubKey) return [];
  const enc = encodeURIComponent;
  const q = platform === "x" && market === "jp" ? `${keyword} lang:ja`
    : platform === "x" && market === "kr" ? `${keyword} lang:ko` : keyword;
  const finish = (arr: (Norm | null)[]): Norm[] =>
    arr.filter((n): n is Norm => !!n && !!n.url && !!n.publishedIso);

  switch (platform) {
    case "x": {
      const j = await tget(`/api/v1/twitter/web/fetch_search_timeline?keyword=${enc(q)}`);
      const tl = digList((j.data as Record<string, unknown> | undefined)?.timeline);
      return finish(tl.map((t) => {
        const u = (t.user_info ?? {}) as Record<string, unknown>;
        const sn = S(u.screen_name) || S(t.screen_name);
        const iso = parseRelTime(S(t.created_at));
        if (!iso || !sn || !t.tweet_id) return null;
        return {
          url: `https://x.com/${sn}/status/${S(t.tweet_id)}`,
          title: "", content: S(t.text), publishedIso: iso,
          likes: num(t.favorites), comments: num(t.replies),
          authorId: S(u.rest_id) || sn, authorName: sn,
          authorFollowers: num(u.followers_count) || undefined,
        };
      }));
    }
    case "weibo": {
      const j = await tget(`/api/v1/weibo/web_v2/fetch_realtime_search?query=${enc(keyword)}&page=1`);
      const rs = digList((j.data as Record<string, unknown> | undefined)?.parsed_data)
        .filter((o) => o.content != null || o.weibo_id != null);
      return finish(rs.map((t) => {
        const inter = (t.interaction ?? {}) as Record<string, unknown>;
        let url = S(t.post_url);
        if (url.startsWith("//")) url = "https:" + url;
        const iso = parseRelTime(S(t.publish_time));
        if (!iso || !url) return null;
        const uname = S(t.user_name) || S(t.user_nick);
        return {
          url, title: S(t.content).slice(0, 80), content: S(t.content), publishedIso: iso,
          likes: num(inter.liked) + num(inter.attitudes) + num(inter.attitude_count),
          comments: num(inter.comments) + num(inter.reply_count) + num(inter.comment_count),
          authorId: uname, authorName: S(t.user_nick) || uname,
        };
      }));
    }
    case "youtube": {
      const j = await tget(`/api/v1/youtube/web_v2/get_general_search_v2?keyword=${enc(keyword)}`);
      const vids = digList((j.data as Record<string, unknown> | undefined)?.videos).filter((o) => o.url != null);
      return finish(vids.map((v) => {
        const iso = parseRelTime(S(v.published_time));
        if (!iso) return null;
        return {
          url: S(v.url), title: S(v.title), content: S(v.description_snippet) || S(v.title),
          publishedIso: iso,
          likes: num(parseInt(S(v.view_count).replace(/[^\d]/g, ""), 10)), comments: 0,
          authorId: S(v.channel_id), authorName: S(v.author),
        };
      }));
    }
    case "reddit": {
      const j = await tget(`/api/v1/reddit/app/fetch_dynamic_search?query=${enc(q)}&sort=NEW`);
      const posts = digList((j.data as Record<string, unknown> | undefined)?.search);
      return finish(posts.map((p) => {
        const d = ((p as Record<string, unknown>).data ?? p) as Record<string, unknown>;
        const iso = d.created ? tsIso(d.created) : parseRelTime(S(d.created_at));
        const url = S(d.permalink) || S(d.url);
        if (!iso || !url) return null;
        return {
          url, title: S(d.title), content: S(d.selftext) || S(d.title), publishedIso: iso,
          likes: num(d.ups ?? d.score), comments: num(d.num_comments),
          authorId: S(d.author), authorName: S(d.author),
        };
      }));
    }
    case "bilibili": {
      const j = await tget(`/api/v1/bilibili/web/fetch_general_search?keyword=${enc(keyword)}&page=1&page_size=20&order=TOTAL_RANK`);
      const list = digList(j.data).filter((o) => o.arcurl != null);
      return finish(list.map((t) => {
        const iso = t.pubdate ? tsIso(t.pubdate) : null;
        if (!iso) return null;
        return {
          url: S(t.arcurl), title: S(t.title), content: S(t.description) || S(t.title),
          publishedIso: iso, likes: num(t.play), comments: num(t.video_review ?? t.review),
          authorId: S(t.mid ?? t.author), authorName: S(t.author),
        };
      }));
    }
    case "douyin": {
      const j = await tpost(`/api/v1/douyin/search/fetch_general_search_v3`, { keyword });
      const list = digList((j.data as Record<string, unknown> | undefined)?.items);
      return finish(list.map((it) => {
        const aw = ((it.aweme_info ?? it) as Record<string, unknown>);
        const st = (aw.statistics ?? {}) as Record<string, unknown>;
        const au = (aw.author ?? {}) as Record<string, unknown>;
        const iso = tsIso(aw.create_time);
        if (!iso || !aw.aweme_id) return null;
        return {
          url: `https://www.douyin.com/video/${S(aw.aweme_id)}`,
          title: S(aw.desc).slice(0, 80), content: S(aw.desc), publishedIso: iso,
          likes: num(st.digg_count), comments: num(st.comment_count),
          authorId: S(au.sec_uid ?? au.uid ?? au.nickname), authorName: S(au.nickname),
          authorFollowers: num(au.follower_count) || undefined,
        };
      }));
    }
    case "xiaohongshu": {
      const j = await tget(`/api/v1/xiaohongshu/app_v2/search_notes?keyword=${enc(keyword)}&page=1`);
      const list = digList((j.data as Record<string, unknown> | undefined)?.items);
      return finish(list.map((it) => {
        const note = ((it.note ?? it) as Record<string, unknown>);
        const user = (note.user ?? {}) as Record<string, unknown>;
        const iso = tsIso(note.last_update_time ?? note.time ?? note.timestamp);
        if (!iso || !note.note_id) return null;
        return {
          url: `https://www.xiaohongshu.com/explore/${S(note.note_id)}`,
          title: S(note.title), content: S(note.desc) || S(note.title), publishedIso: iso,
          likes: num(note.liked ?? note.like_count ?? note.likes),
          comments: num(note.comment_count ?? note.comments),
          authorId: S(user.user_id ?? user.userid ?? user.nickname),
          authorName: S(user.nickname),
          authorFollowers: num(user.fans ?? user.follower_count) || undefined,
        };
      }));
    }
    case "zhihu": {
      const j = await tget(`/api/v1/zhihu/web/fetch_article_search_v3?keyword=${enc(keyword)}&offset=0&limit=10&show_all_topics=0&search_source=web&vert=0`);
      const list = digList(j.data).filter((o) => (o as Record<string, unknown>).object != null || o.url != null);
      return finish(list.map((it) => {
        const a = ((it.object ?? it) as Record<string, unknown>);
        const au = (a.author ?? {}) as Record<string, unknown>;
        const iso = a.created_time ? tsIso(a.created_time) : a.published_time ? tsIso(a.published_time) : null;
        if (!iso || !S(a.url)) return null;
        return {
          url: S(a.url), title: S(a.title), content: S(a.excerpt ?? a.content) || S(a.title),
          publishedIso: iso, likes: num(a.voteup_count), comments: num(a.comment_count),
          authorId: S(au.id ?? au.name), authorName: S(au.name),
        };
      }));
    }
    default:
      return []; // hatena / niconico 免费公开接口 P1 接入
  }
}

Deno.serve(async (req) => {
  const client = sb();
  const notes: string[] = [];

  // ---------- 1. 到期关键词×平台 出队 (v2 §6.4 调度) ----------
  const { data: keywords } = await client.from("keywords")
    .select("*").eq("kind", "demand").eq("enabled", true);
  const { data: cfg } = await client.from("app_config").select("value").eq("key", "crawl_intervals").single();
  const intervals = (cfg?.value ?? {}) as Record<string, number>;
  const { data: usage } = await client.from("api_usage").select("*").eq("day", new Date().toISOString().slice(0, 10));
  const usageMap = new Map((usage ?? []).map((u) => [u.provider, u]));
  const caps = (await client.from("app_config").select("value").eq("key", "platform_caps").single())?.data?.value as Record<string, number> ?? {};

  const due: { kw: typeof keywords[number]; platform: string }[] = [];
  for (const kw of keywords ?? []) {
    for (const platform of kw.platforms ?? []) {
      const interval = (intervals[platform] ?? 180) * 60_000;
      // 用 keywords 表 fetched_count 无法记录时间, 简化: 每轮随机采样到期组合, 单轮最多 40 次调用 (v2)
      if (Math.random() < Math.min(1, 5 / ((keywords?.length ?? 1) * Math.max(1, (kw.platforms ?? []).length))))
        due.push({ kw, platform });
    }
  }
  const batch = due.slice(0, 40);

  // ---------- 2. 抓取 ----------
  const fresh: { kwId: string; kwMarket: string; platform: string; norm: Norm }[] = [];
  for (const { kw, platform } of batch) {
    // 平台每日调用硬上限 (spec §11.3)
    const usedCalls = usageMap.get(platform)?.calls ?? 0;
    const cap = caps[platform];
    if (cap && usedCalls >= cap) { notes.push(`${platform} 触达日上限 ${cap}, 跳过`); continue; }
    try {
      const results = await tikhubSearch(platform, kw.keyword, kw.market);
      for (const norm of results) {
        // 时效过滤: 超 7 天丢弃 (适配器已产 ISO) (v2 §6.5)
        const pubDate = new Date(norm.publishedIso);
        if (isNaN(pubDate.getTime())) continue;
        if (Date.now() - pubDate.getTime() > 7 * 86400000) continue;
        if (pubDate.getTime() > Date.now() + 3600000) continue;
        fresh.push({ kwId: kw.id, kwMarket: kw.market, platform, norm });
      }
      // 记账 (平台级)
      const cur = usageMap.get(platform) ?? { day: new Date().toISOString().slice(0, 10), provider: platform, cost: 0, calls: 0 };
      cur.calls++;
      usageMap.set(platform, cur);
    } catch (e) {
      notes.push(`${platform} 抓取失败: ${(e as Error).message}`);
    }
  }
  // 批量 upsert 用量
  for (const [provider, u] of usageMap) {
    await client.from("api_usage").upsert({ day: u.day, provider, cost: u.cost, calls: u.calls },
      { onConflict: "day,provider" });
  }

  // ---------- 3. URL 去重 + 入采集池 ----------
  const pooled: { kwId: string; kwMarket: string; platform: string; itemId: string; norm: Norm }[] = [];
  for (const f of fresh) {
    const n = f.norm;
    const urlHash = await hashUrl(n.url);
    const { error: dupErr } = await client.from("crawl_items").upsert({
      keyword_id: f.kwId, platform: f.platform, market: f.kwMarket,
      url: n.url, url_hash: urlHash,
      author_id: n.authorId || null, author_name: n.authorName || null,
      published_at: n.publishedIso,
      raw_title: n.title.slice(0, 500),
      raw_content: n.content.slice(0, 4000),
      metrics_json: { likes: n.likes, comments: n.comments },
      lang: null,
      ai_status: "pending",
    }, { onConflict: "url_hash", ignoreDuplicates: true });
    if (!dupErr) {
      const { data: item } = await client.from("crawl_items").select("id, ai_status").eq("url_hash", urlHash).single();
      if (item && item.ai_status === "pending") {
        pooled.push({ kwId: f.kwId, kwMarket: f.kwMarket, platform: f.platform, itemId: item.id, norm: n });
      }
    }
  }

  // ---------- 4. AI 批量初筛 (20 条/批, v2 节奏) ----------
  const { data: scenes } = await client.from("demand_scenes").select("id,name,capability").eq("status", "active");
  const system = screenSystemPrompt(scenes ?? []);
  let demandIn = 0, brandIn = 0;

  for (let i = 0; i < pooled.length; i += 20) {
    const chunk = pooled.slice(i, i + 20);
    try {
      // 每批一次调用: 多条合并为编号列表
      const userMsg = chunk.map((c, idx) =>
        `[[${idx}]] ` + screenUserPrompt({
          platform: c.platform, market: c.kwMarket, publishedAt: c.norm.publishedIso,
          isDemandKeyword: true, hitKeyword: "需求词", title: c.norm.title, content: c.norm.content,
        })).join("\n\n");
      const result = await deepSeekJson<Record<string, {
        isDemandPost: boolean; demandId: string | null; demandSummary: string | null;
        demandTopic: string | null; demandQuote: string | null; relevance: number;
        brandMention: boolean; competitors: string[];
      }>>(system, `以下 ${chunk.length} 条帖子, 返回 JSON: {results: {"0": {...}, "1": {...}}} 按编号。不相关的也返回编号键, 各字段置空。\n\n${userMsg}`, true);
      const results = (result as { results?: Record<string, typeof result[number]> }).results ?? result;

      for (let idx = 0; idx < chunk.length; idx++) {
        const c = chunk[idx];
        const n = c.norm;
        const r = results[String(idx)];
        if (!r) continue;
        const fullText = `${n.title}\n${n.content}`;
        const isDemand = r.isDemandPost &&
          demandGate({ confidence: r.relevance, url: n.url, content: fullText, quote: r.demandQuote, quoteInPost: verifyQuote(r.demandQuote, fullText) }).pass;
        const isBrand = !!r.brandMention;

        // 双通道分流 (spec §4.1)
        if (isDemand) {
          const market = marketOf(c.kwMarket as never, null, c.platform);

          // ---- KOL/KOC 分层 (spec C2 增强版): 作者聚合 + 档案 + 真实度 ----
          let kolTier: "kol" | "koc" | "none" = "none";
          if (n.authorId) {
            kolTier = await classifyAuthor({ platform: c.platform, authorId: n.authorId, authorName: n.authorName, likes: n.likes, comments: n.comments });
          }

          const { error } = await client.from("demand_posts").upsert({
            item_id: c.itemId, market, platform: c.platform, url: n.url,
            author_id: n.authorId || null, author_name: n.authorName || null, published_at: n.publishedIso,
            title: n.title.slice(0, 500), content: n.content.slice(0, 4000),
            demand_id: r.demandId && (scenes ?? []).some((s) => s.id === r.demandId) ? r.demandId : null,
            summary: (r.demandSummary ?? "").slice(0, 300), quote: (r.demandQuote ?? "").slice(0, 60),
            quote_verified: verifyQuote(r.demandQuote, fullText), topic: r.demandTopic ?? null,
            lang: null, confidence: r.relevance ?? null,
            kol_tier: kolTier,
            priority_score: priorityScore({ likes: n.likes, comments: n.comments, publishedAt: n.publishedIso, isKol: kolTier === "kol", highEngAuthor: false, sameTopicCount: 0 }),
            stale: isStale(n.publishedIso), state: "open",
          }, { onConflict: "item_id", ignoreDuplicates: true });
          if (!error) demandIn++;
        }
        if (isBrand) {
          await client.from("brand_posts").upsert({
            item_id: c.itemId, market: c.kwMarket, platform: c.platform, url: n.url,
            published_at: n.publishedIso, content: fullText.slice(0, 4000),
            tags: r.competitors?.length ? ["competitor"] : [],
            competitor_names: r.competitors ?? [],
            state: "open",
          }, { onConflict: "item_id", ignoreDuplicates: true });
          brandIn++;
        }
        await client.from("crawl_items").update({
          ai_status: "done",
          classified_type: isDemand && isBrand ? "both" : isDemand ? "demand" : isBrand ? "brand" : "none",
        }).eq("id", c.itemId);
      }
    } catch (e) {
      notes.push(`初筛批 ${i / 20} 失败: ${(e as Error).message}`);
    }
  }

  await client.from("crawl_jobs").insert({ type: "search", status: "done", finished_at: new Date().toISOString(), payload: { fetched: fresh.length, demand_in: demandIn, brand_in: brandIn, notes } });
  return json({ ok: true, fetched: fresh.length, demand_in: demandIn, brand_in: brandIn, notes });
});
