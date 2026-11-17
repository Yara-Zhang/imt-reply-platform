// API 封装 — Mock/真实双模式: VITE_API_BASE 未配置时自动走 Mock
const BASE = import.meta.env.VITE_API_BASE ?? "";
export const MOCK = !BASE;

const LS = {
  get token() { return localStorage.getItem("imt_token") ?? ""; },
  set token(v) { v ? localStorage.setItem("imt_token", v) : localStorage.removeItem("imt_token"); },
};

export function setToken(t) { LS.token = t; }
export function hasToken() { return !!LS.token; }

// 真实模式路径映射: 业务代码用短路径(/auth /posts /scenes /reply /stats /health),
// Supabase Edge Function 按函数名分发, 必须补上函数名前缀; Mock 引擎仍按短路径匹配, 不受影响
const PREFIX_MAP = [
  [/^\/auth\//, "/api-auth/"],
  [/^\/scenes\//, "/api-scenes/"],
  [/^\/reply\/?$/, "/api-reply/reply"],
  [/^\/posts\//, "/api-posts/"],
  [/^\/(stats|health)\b/, "/api-posts/$1"],
];
function realPath(path) {
  for (const [re, to] of PREFIX_MAP) { const s = path.replace(re, to); if (s !== path) return s; }
  return path;
}

async function real(path, opts = {}) {
  const r = await fetch(`${BASE}${realPath(path)}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LS.token}`, ...(opts.headers ?? {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

// ---------- Mock 引擎 (localStorage 持久化, 全链路可演示) ----------
const MOCK_SEED = [
  { id: "m1", market: "en", platform: "reddit", url: "https://reddit.com/r/anime/x1", published_at: new Date(Date.now() - 6 * 3600000).toISOString(), demand_id: "D03", summary: "Prime 新剧没有母语字幕，想外挂又不会弄", quote: "no english subtitles on prime, why is this even a thing", quote_verified: true, topic: "流媒体字幕", state: "open", priority_score: 88, content: "Just started watching this new series and there are literally no subtitle options in my language. I checked every setting, tried downloading SRT files but the timing is all wrong…", metrics_json: { likes: 128, comments: 34 }, confidence: 0.92 },
  { id: "m2", market: "jp", platform: "x", url: "https://x.com/a/2", published_at: new Date(Date.now() - 3 * 3600000).toISOString(), demand_id: "D09", summary: "Webtoon 整页机翻排版全乱，追更体验很差", quote: "翻訳もぐちゃぐちゃで毎回手直しするのがしんどい", quote_verified: true, topic: "漫画翻译", state: "open", priority_score: 95, kol_tier: "kol", author_id: "webtoon_sensei", author_name: "webtoon_sensei", content: "Webtoon の翻訳、毎回ぐちゃぐちゃ…", metrics_json: { likes: 2400, comments: 412 }, confidence: 0.9 },
  { id: "m4", market: "kr", platform: "x", url: "https://x.com/a/4", published_at: new Date(Date.now() - 20 * 3600000).toISOString(), demand_id: "D02", summary: "K-Pop 幕后直播没有韩语外字幕看不懂", quote: "韩综幕后全是韩语，直播根本没有字幕", quote_verified: true, topic: "K-Pop 幕后", state: "claimed", claimed_by_name: "张三", reply_draft: "혹시 몰랐다면, 몰입형 번역의 영상 자막 기능으로 이면 영상도 한국어 자막으로 볼 수 있어요.", priority_score: 70, kol_tier: "koc", author_id: "kpop_viewer99", author_name: "kpop_viewer99", content: "…", metrics_json: { likes: 89, comments: 21 }, confidence: 0.85 },
  { id: "m3", market: "cn", platform: "weibo", url: "https://weibo.com/a/3", published_at: new Date(Date.now() - 14 * 3600000).toISOString(), demand_id: "D05", summary: "英文论文 PDF 复制到翻译器来回切换太累", quote: "每次都要复制粘贴再切回来，表格全错位", quote_verified: true, topic: "论文翻译", state: "claimed", claimed_by_name: "李四", priority_score: 62, content: "读文献好痛苦…", metrics_json: { likes: 46, comments: 12 }, confidence: 0.88 },
  { id: "m5", market: "cn", platform: "zhihu", url: "https://zhihu.com/q/5", published_at: new Date(Date.now() - 10 * 3600000).toISOString(), demand_id: "D07", summary: "Switch 游戏没有汉化，攻略网站全是英文", quote: "这游戏怎么连个中文都没有，攻略只能硬啃英文", quote_verified: false, topic: "游戏攻略", state: "open", priority_score: 55, content: "…", metrics_json: { likes: 23, comments: 5 }, confidence: 0.75 },
  { id: "m6", market: "cn", platform: "xiaohongshu", url: "https://xhs.cn/a/6", published_at: new Date(Date.now() - 8 * 3600000).toISOString(), demand_id: "D01", summary: "追海外博主的 vlog 全是英文，求好用的翻译办法", quote: "有没有姐妹懂啊，他视频全是英文，字幕都找不到", quote_verified: true, topic: "视频字幕", state: "open", priority_score: 66, content: "…", metrics_json: { likes: 156, comments: 24 }, confidence: 0.9 },
  { id: "m7", market: "en", platform: "reddit", url: "https://reddit.com/r/x/7", published_at: new Date(Date.now() - 2 * 3600000).toISOString(), demand_id: "D12", summary: "X 内置翻译把否定句翻反了，误解了整条推文", quote: "built-in translation completely flipped the meaning", quote_verified: true, topic: "内置翻译", state: "open", priority_score: 72, content: "…", metrics_json: { likes: 57, comments: 18 }, confidence: 0.91 },
  { id: "m8", market: "jp", platform: "hatena", url: "https://b.hatena/x8", published_at: new Date(Date.now() - 4 * 86400000).toISOString(), demand_id: "D05", summary: "英語の論文が読めなくて卒論が進まない", quote: "英語論文、読めなさすぎて泣ける", quote_verified: false, topic: "论文翻译", state: "open", priority_score: 10, stale: true, content: "…", metrics_json: { likes: 3, comments: 0 }, confidence: 0.72 },
  { id: "m9", market: "cn", platform: "bilibili", url: "https://bilibili.com/x9", published_at: new Date(Date.now() - 5 * 86400000).toISOString(), demand_id: "D01", summary: "生肉看不懂，求个字幕", quote: "生肉 看不懂", quote_verified: true, topic: "视频字幕", state: "open", priority_score: 8, stale: true, content: "…", metrics_json: { likes: 5, comments: 1 }, confidence: 0.8 },
];

function mockDb() {
  let posts = localStorage.getItem("imt_mock_db");
  if (!posts) { posts = JSON.stringify(MOCK_SEED); localStorage.setItem("imt_mock_db", posts); }
  return JSON.parse(posts);
}
function saveDb(db) { localStorage.setItem("imt_mock_db", JSON.stringify(db)); }

async function mock(path, opts = {}) {
  const db = mockDb();
  const [purePath] = path.split("?");
  const qs = Object.fromEntries(new URLSearchParams(path.split("?")[1] ?? ""));
  const body = opts.body ? JSON.parse(opts.body) : {};
  await new Promise((r) => setTimeout(r, 120)); // 模拟网络延迟
  const [route, action] = purePath.replace(/^\//, "").split("/");

  if (route === "auth") { // 登录/注册 (Mock: 任意邮箱密码即可)
    const name = body.name || body.email?.split("@")[0] || "张三";
    const m = { id: "mock", name, role: "admin", duties: ["ja_review", "kr_review"] };
    localStorage.setItem("imt_member", JSON.stringify(m));
    return { token: "mock-token", member: m };
  }
  if (route === "posts" && action === "outreach") { // 建联卡片 (Mock: 两个作者档案)
    const key = qs.author ?? "";
    const profiles = {
      "x:webtoon_sensei": {
        author: { platform: "x", author_id: "webtoon_sensei", name: "webtoon_sensei", followers: 52000, tier: "kol", auth_score: 85,
          auth_signals: { er: 0.054, comment_ratio: 0.146, vs_avg: 1.4, suspect_boosted: false, viral: false, bought_followers: false, bought_likes: false, followers_known: true },
          email: "webtoon.biz@gmail.com", email_source: "bio:x", bio: "Webtoon翻訳レビュー | 商務 business@gmail.com",
          total_hits: 4, avg_engagement: 1980, max_engagement: 2812 },
        topics: ["漫画翻译", "条漫排版"], scene_feature: "漫画翻译",
        direction: "X 上该作者近期内容集中在「漫画翻译」「条漫排版」方向。建议以漫画翻译的真实使用体验为切入点，用 webtoon_sensei 本人发过的问题做开场最自然，避免硬广口吻。KOL 量级，建议走正式合作流程（产品体验 + 报价沟通），注意辨别其互动中的投流成分再谈价。",
      },
      "x:kpop_viewer99": {
        author: { platform: "x", author_id: "kpop_viewer99", name: "kpop_viewer99", followers: 3200, tier: "koc", auth_score: 70,
          auth_signals: { er: 0.034, comment_ratio: 0.233, vs_avg: 1, suspect_boosted: false, viral: false, bought_followers: false, bought_likes: false, followers_known: true },
          email: null, email_source: null, bio: "K팝 팬 | 아이돌 뒷이야기 좋아함",
          total_hits: 2, avg_engagement: 95, max_engagement: 110 },
        topics: ["K-Pop 幕后"], scene_feature: "视频双语字幕",
        direction: "X 上该作者近期内容集中在「K-Pop 幕后」方向。建议以视频双语字幕的真实使用体验为切入点，用 kpop_viewer99 本人发过的问题做开场最自然，避免硬广口吻。KOC 量级，建议以产品体验邀请/轻量合作切入，成本可控、真实感强。",
      },
    };
    const p = profiles[key];
    if (p) return p;
    return { author: { platform: key.split(":")[0], author_id: key.split(":")[1], name: key.split(":")[1], followers: null, tier: "none", auth_score: null, auth_signals: null, email: null, total_hits: 1, avg_engagement: 0 }, topics: [], scene_feature: null, direction: "" };
  }
  if (route === "stats") {
    const me = hasToken() ? JSON.parse(localStorage.getItem("imt_member") ?? "{}") : {};
    const tier = (s) => (s >= 70 ? "p0" : s >= 40 ? "p1" : "p2");
    const priority = { cn: { p0: 0, p1: 0, p2: 0 }, en: { p0: 0, p1: 0, p2: 0 }, jp: { p0: 0, p1: 0, p2: 0 }, kr: { p0: 0, p1: 0, p2: 0 } };
    for (const p of db) {
      if (p.state === "open" || p.state === "claimed") (priority[p.market] ??= { p0: 0, p1: 0, p2: 0 })[tier(p.priority_score ?? 0)]++;
    }
    return {
      open: db.filter((p) => p.state === "open").length,
      today_new: 12, mine: db.filter((p) => p.state === "claimed" && p.claimed_by_name === me.name).length,
      review: db.filter((p) => p.market === "kr" || p.market === "jp").filter((p) => p.state === "claimed" && p.reply_draft && !p.ja_reviewed_at).length,
      today_replied: 5, week_replied: 18,
      priority,
    };
  }
  if (route === "health") {
    return { last_round_at: new Date(Date.now() - 5 * 60000).toISOString(), today_fetched: 320, today_demand: 27, today_failed: 0, last_error: null, spend: [{ provider: "tikhub", cost: 1.8, calls: 63 }] };
  }
  if (route === "posts" && action === "report") { // 周报 (Mock: 演示数据 + list 实时状态混合)
    const offset = Number(qs.week_offset ?? 0);
    const monday = new Date(); monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - offset * 7);
    const next = new Date(monday.getTime() + 7 * 86400000);
    const wk = (base) => { const d = new Date(monday); d.setDate(d.getDate() + base); return d.toISOString(); };
    const inWeek = db.filter((p) => p.published_at >= wk(0) && p.published_at < wk(7));
    const demo = {
      0: { new_posts: 86, replied: 52, reply_rate: 60, avg_reply_hours: 6.3, brand_neg: 1 },
      1: { new_posts: 74, replied: 61, reply_rate: 82, avg_reply_hours: 5.1, brand_neg: 0 },
      2: { new_posts: 68, replied: 47, reply_rate: 69, avg_reply_hours: 7.8, brand_neg: 2 },
    }[offset] ?? { new_posts: 70, replied: 50, reply_rate: 71, avg_reply_hours: 6.5, brand_neg: 0 };
    const top = [...db].sort((a, b) => ((b.metrics_json?.likes ?? 0) + (b.metrics_json?.comments ?? 0)) - ((a.metrics_json?.likes ?? 0) + (a.metrics_json?.comments ?? 0))).slice(0, 5);
    return {
      week_start: monday.toISOString().slice(0, 10), week_end: next.toISOString().slice(0, 10),
      new_posts: demo.new_posts, replied: demo.replied, skipped: 9, open_left: demo.new_posts - demo.replied - 9,
      reply_rate: demo.reply_rate, avg_reply_hours: demo.avg_reply_hours,
      market_rows: [
        { market: "cn", total: Math.round(demo.new_posts * 0.34), replied: Math.round(demo.replied * 0.36) },
        { market: "en", total: Math.round(demo.new_posts * 0.24), replied: Math.round(demo.replied * 0.22) },
        { market: "jp", total: Math.round(demo.new_posts * 0.27), replied: Math.round(demo.replied * 0.28) },
        { market: "kr", total: Math.round(demo.new_posts * 0.15), replied: Math.round(demo.replied * 0.14) },
      ],
      platform_rows: [
        { platform: "x", total: Math.round(demo.new_posts * 0.31) }, { platform: "reddit", total: Math.round(demo.new_posts * 0.18) },
        { platform: "weibo", total: Math.round(demo.new_posts * 0.14) }, { platform: "xiaohongshu", total: Math.round(demo.new_posts * 0.12) },
        { platform: "bilibili", total: Math.round(demo.new_posts * 0.1) }, { platform: "douyin", total: Math.round(demo.new_posts * 0.08) },
        { platform: "youtube", total: Math.round(demo.new_posts * 0.07) },
      ],
      top_posts: top,
      leaderboard: [
        { name: "张三", replied: Math.round(demo.replied * 0.42) }, { name: "李四", replied: Math.round(demo.replied * 0.31) },
        { name: "王五", replied: Math.round(demo.replied * 0.18) }, { name: "赵六", replied: Math.round(demo.replied * 0.09) },
      ],
      kol_hits: 2, koc_hits: 3,
      kol_authors: [{ name: "webtoon_sensei", market: "jp", platform: "x", summary: "Webtoon 整页机翻排版全乱，追更体验很差" }],
      brand_neg: demo.brand_neg,
      _in_week: inWeek.length,
    };
  }
  if (route === "posts" && action === "claim") {
    const p = db.find((x) => x.id === body.id);
    if (p.state !== "open") throw new Error(`已被 ${p.claimed_by_name ?? "其他同事"} 认领，如需接管请先联系 TA`);
    p.state = "claimed"; p.claimed_by_name = JSON.parse(localStorage.getItem("imt_member") ?? "{}").name ?? "我";
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "draft") {
    const p = db.find((x) => x.id === body.id);
    p.reply_draft = body.draft ?? ""; p.brand_issues = [];
    if (body.market === "jp" || body.market === "kr") p.ja_reviewed_at = null;
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "replied") {
    const p = db.find((x) => x.id === body.id);
    if ((p.market === "jp" || p.market === "kr") && p.reply_draft && !p.ja_reviewed_at) {
      throw new Error("日本/韩国帖需母语审核人通过后才能标记已回复——找本周日审：@李四");
    }
    if (!body.reply_url || !/^https?:\/\//.test(String(body.reply_url))) {
      throw new Error("请登记回复链接（粘贴你发出的回复的 URL）");
    }
    p.state = "replied"; p.replied_at = new Date().toISOString(); p.reply_url = body.reply_url;
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "reply-url") {
    const p = db.find((x) => x.id === body.id);
    if (p.state !== "replied") throw new Error("只有已回复的帖子才能修改回复链接");
    if (!body.reply_url || !/^https?:\/\//.test(String(body.reply_url))) throw new Error("回复链接格式不对");
    p.reply_url = body.reply_url;
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "review") {
    const p = db.find((x) => x.id === body.id);
    if (body.approve !== false) { p.ja_reviewed_at = new Date().toISOString(); }
    else { p.ja_reviewed_at = null; }
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "skip") {
    const p = db.find((x) => x.id === body.id);
    p.state = "skipped"; p.skip_reason = body.reason;
    saveDb(db); return { post: p };
  }
  if (route === "posts" && action === "release") {
    const p = db.find((x) => x.id === body.id);
    p.state = "open"; p.claimed_by_name = null; p.claimed_at = null; p.skip_reason = null;
    saveDb(db); return { post: p };
  }
  if (route === "reply") { // 认领并起草 (mock: 生成一段示例草稿)
    const p = db.find((x) => x.id === body.id);
    if (p.claimed_by_name && p.state === "claimed" && !body.requirement) { /* 本人重复认领允许 */ }
    if (p.state === "open") {
      p.state = "claimed"; p.claimed_by_name = JSON.parse(localStorage.getItem("imt_member") ?? "{}").name ?? "我";
    }
    const en = p.market === "en";
    p.reply_draft = en
      ? "Totally relatable — Prime's subtitle options can be so random. If it helps, I use Immersive Translate's bilingual subtitle feature to watch stuff like this, it overlays subtitles right on the video: https://immersivetranslate.com/"
      : "太懂了，这种没有字幕的真的着急。可以试试沉浸式翻译的视频双语字幕，直接在视频上叠加双语字幕，不用来回下载字幕文件～";
    p.reply_draft_cn = en ? "太懂了，Prime 的字幕选项真是随缘。如果你需要，我用沉浸式翻译的双语字幕功能看这类内容，直接在视频上叠加字幕。" : null;
    p.brand_issues = [];
    p.draft_at = new Date().toISOString();
    saveDb(db); return { post: p };
  }
  if (route === "posts" && (action === "list" || !action)) { // list
    return { posts: db };
  }
  throw new Error("Mock: 未实现的接口 " + path);
}

export async function api(path, opts = {}) {
  const bodyStr = opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body;
  return MOCK ? mock(path, { ...opts, body: bodyStr }) : real(path, opts);
}
