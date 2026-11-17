import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";


// ---------- 内联自 functions/_shared/glue.ts ----------
// 平台胶水层: Supabase client / JWT 鉴权 / DeepSeek / TikHub / 飞书 —— 仅此层依赖平台环境

export const env = {
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  sessionSecret: Deno.env.get("SESSION_SECRET") ?? "dev-secret-change-me",
  deepseekKey: Deno.env.get("DEEPSEEK_API_KEY") ?? "",
  tikhubKey: Deno.env.get("TIKHUB_API_KEY") ?? "",
  feishuWebhook: Deno.env.get("FEISHU_WEBHOOK_URL") ?? "",
  feishuAppId: Deno.env.get("FEISHU_APP_ID") ?? "",
  feishuAppSecret: Deno.env.get("FEISHU_APP_SECRET") ?? "",
};

export function sb(): SupabaseClient {
  return createClient(env.supabaseUrl, env.serviceKey, { auth: { persistSession: false } });
}

// ---------- JWT (HS256, WebCrypto) ----------
function b64url(b: ArrayBuffer | Uint8Array): string {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  return btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signJwt(payload: Record<string, unknown>, ttlHours = 24 * 14): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(new TextEncoder().encode(JSON.stringify({
    ...payload, exp: Math.floor(Date.now() / 1000) + ttlHours * 3600,
  })));
  const data = `${header}.${body}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env.sessionSecret), new TextEncoder().encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt(token: string): Promise<Record<string, unknown> | null> {
  try {
    const [h, b, s] = token.split(".");
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(env.sessionSecret),
      Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")).split("").map((c) => c.charCodeAt(0))),
      new TextEncoder().encode(`${h}.${b}`));
    if (!ok) return null;
    const payload = JSON.parse(b64urlDecode(b));
    if (payload.exp && payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 从请求头解析当前成员 (返回 null = 未登录) */
export async function requireMember(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = token ? await verifyJwt(token) : null;
  if (!payload?.mid) return null;
  const { data } = await sb().from("members").select("*").eq("id", payload.mid).single();
  return data ?? null;
}

// ---------- DeepSeek ----------
export async function deepSeekChat(messages: { role: string; content: string }[], opts: { fast?: boolean; json?: boolean } = {}) {
  const model = opts.fast ? "deepseek-chat" : "deepseek-reasoner";
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.deepseekKey}` },
    body: JSON.stringify({
      model, messages,
      response_format: opts.json ? { type: "json_object" } : undefined,
      ...(opts.fast ? {} : { max_tokens: 1024 }),
    }),
  });
  if (!r.ok) throw new Error(`DeepSeek ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content ?? "";
}

export async function deepSeekJson<T>(system: string, user: string, fast = true): Promise<T> {
  const raw = await deepSeekChat([{ role: "system", content: system }, { role: "user", content: user }], { fast, json: true });
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 模型偶尔包裹 markdown 代码块
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("AI 返回无法解析为 JSON");
  }
}

// ---------- 飞书 ----------
export async function feishuCard(card: Record<string, unknown>) {
  if (!env.feishuWebhook) return;
  await fetch(env.feishuWebhook, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
}

// ---------- 工具 ----------
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });

export function cors(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    }});
  }
  return null;
}

// ---------- 内联自 functions/_shared/logic/types.ts ----------
// 纯业务逻辑层 — 无平台依赖, 可单测, 可平移 (spec 分层约定)
// 类型定义

export type Market = "cn" | "en" | "jp" | "kr";
export type PostState = "open" | "claimed" | "replied" | "skipped";
export type ClassifiedType = "demand" | "brand" | "both" | "none";

export interface DemandPost {
  id: string;
  market: Market;
  platform: string;
  url: string;
  published_at: string;
  demand_id: string | null;
  summary: string | null;
  quote: string | null;
  quote_verified: boolean;
  topic: string | null;
  confidence: number | null;
  state: PostState;
  claimed_by: string | null;
  reply_draft: string | null;
  brand_issues: BrandIssue[];
  ja_reviewed_at: string | null;
  replied_at: string | null;
  metrics: { likes?: number; comments?: number };
}

export interface BrandIssue {
  level: "must" | "warn";
  rule: string;
  label?: string;
  hit_text?: string;
}

export interface Member {
  id: string;
  name: string;
  role: "admin" | "member" | "observer";
  duties: string[]; // ja_review / kr_review
}

export interface SceneRow {
  id: string; // D01..D14
  name: string;
  capability: string[];
  feature: string;
}

// ---------- 内联自 functions/_shared/logic/state-machine.ts ----------
// 状态机拦截规则 — 教学式文案 (spec §9)

export interface BlockResult {
  blocked: boolean;
  message: string; // 教学式提示文案
}

export function replyLang(market: string, lang: string | null): "ja" | "ko" | "en" | "zh" {
  if (market === "jp" || lang === "ja") return "ja";
  if (market === "kr" || lang === "ko") return "ko";
  if (market === "en" || lang === "en") return "en";
  return "zh";
}

/** 标记已回复前检查 (spec §9 拦截规则表) */
export function checkMarkReplied(
  post: Pick<DemandPost, "brand_issues" | "ja_reviewed_at" | "market" | "reply_draft" | "state">,
  reviewerName: string,
): BlockResult {
  if (post.state === "replied") return { blocked: true, message: "这条已标记过已回复。" };
  // 品牌检查 must 未清
  const must = (post.brand_issues || []).filter((b: BrandIssue) => b.level === "must");
  if (must.length > 0) {
    return {
      blocked: true,
      message: `草稿有必须修改的问题：${must.map((m) => m.label || m.rule).join("、")}。改完才能标记已回复。`,
    };
  }
  // 日韩帖有草稿但未经母语审核
  const needReview = post.market === "jp" || post.market === "kr";
  if (needReview && post.reply_draft && !post.ja_reviewed_at) {
    return {
      blocked: true,
      message: `日本/韩国帖需母语审核人通过后才能标记已回复——找本周${post.market === "jp" ? "日" : "韩"}审：@${reviewerName || "待排班"}`,
    };
  }
  return { blocked: false, message: "" };
}

/** 起草拦截: 日/韩阶段 0 */
export function checkDraftAllowed(market: string, stage: number): BlockResult {
  if ((market === "jp" || market === "kr") && stage < 1) {
    return {
      blocked: true,
      message: "日本/韩国市场处于阶段 0（只监测），暂不生成回复草稿。可在「设置」中调整市场阶段。",
    };
  }
  return { blocked: false, message: "" };
}

/** 母语审核人职责校验 */
export function canReview(market: string, m: Member): boolean {
  if (m.role === "admin") return true;
  const duty = market === "jp" ? "ja_review" : market === "kr" ? "kr_review" : "";
  return !!duty && m.duties.includes(duty);
}

/** 认领冲突文案 */
export function claimConflictMessage(claimerName: string, claimedAt: string): string {
  const hrs = Math.max(1, Math.round((Date.now() - new Date(claimedAt).getTime()) / 3600000));
  return `已被 ${claimerName} 认领（认领于 ${hrs} 小时前）。如需接管请先联系 TA，或请管理员释放。`;
}

// ---------- 内联自 functions/_shared/logic/priority.ts ----------
// priority_score 计算 (spec C1) + 品牌检查两级 (v2 §5.3) + 冷却判定

export const STALE_HOURS = 72;

/** priority_score: 互动40 + 时效30 + 作者20 + 聚合10 */
export function priorityScore(opts: {
  likes: number; comments: number;
  publishedAt: string;
  isKol: boolean; highEngAuthor: boolean;
  sameTopicCount: number;
  shiftMarketBonus?: number; // 值班市场 +5 (C5, P0 可传 0)
}): number {
  // 互动分 0-40
  const eng = opts.likes + opts.comments + 1;
  const eScore = Math.min(40, Math.round(Math.log10(eng) * 20));
  // 时效分 0-30 (按发布时间)
  const hrs = (Date.now() - new Date(opts.publishedAt).getTime()) / 3600000;
  const tScore = hrs < 12 ? 30 : hrs < 24 ? 25 : hrs < 48 ? 15 : hrs < 72 ? 8 : 0;
  // 作者分 0-20
  const aScore = opts.isKol ? 20 : opts.highEngAuthor ? 12 : 5;
  // 聚合分 0-10
  const gScore = opts.sameTopicCount >= 3 ? 10 : 0;
  return Math.min(100, eScore + tScore + aScore + gScore + (opts.shiftMarketBonus || 0));
}

/** 是否已冷却 (>72h) */
export function isStale(publishedAt: string): boolean {
  return Date.now() - new Date(publishedAt).getTime() > STALE_HOURS * 3600000;
}

// ---------- 品牌检查 (v2 §5.3 两级规则, 规则存 app_config.brand_rules) ----------
export interface BrandRule {
  id: string;
  label: string;
  words: string[];
}

export function brandCheck(
  draft: string,
  rules: { must: BrandRule[]; warn: BrandRule[] },
  site: string,
): BrandIssue[] {
  const issues: BrandIssue[] = [];
  if (!draft) return issues;
  for (const r of rules.must || []) {
    for (const w of r.words) {
      if (w && draft.includes(w)) {
        issues.push({ level: "must", rule: r.id, label: r.label, hit_text: w });
        break; // 每规则记一条
      }
    }
  }
  for (const r of rules.warn || []) {
    for (const w of r.words) {
      if (w && draft.includes(w)) {
        issues.push({ level: "warn", rule: r.id, label: r.label, hit_text: w });
        break;
      }
    }
  }
  // 链接检查: 非官网链接 / 官网无 UTM → 提醒
  const links = draft.match(/https?:\/\/[^\s)]+/g) || [];
  for (const l of links) {
    if (!l.startsWith(site)) {
      issues.push({ level: "warn", rule: "link_check", label: "非官网链接", hit_text: l.slice(0, 60) });
    } else if (!l.includes("utm_")) {
      issues.push({ level: "warn", rule: "link_check", label: "官网链接未带 UTM 参数", hit_text: "" });
    }
  }
  return issues;
}

// ---------- 内联自 functions/_shared/logic/kol.ts ----------
// KOL/KOC 分层判定 + 真实度评分 + 简介邮箱提取 + 建联卡文案 — 纯逻辑, 无平台依赖
// 规则依据: spec C2 增强版 + kol_rules/app_config 默认阈值

export interface KolRules {
  koc_followers_min: number;   // 500
  kol_followers_min: number;   // 10000
  koc_engagement_min: number;  // 50
  koc_engagement_rate_min: number; // 0.01
  kol_engagement_min: number;  // 500
  kol_engagement_rate_min: number; // 0.03
  auth_score_min: number;      // 60
  boost_ratio_suspect: number; // 10
  profile_fetch_cooldown_days: number; // 7
  engagement_trigger: number;  // 50
}

export const DEFAULT_KOL_RULES: KolRules = {
  koc_followers_min: 500, kol_followers_min: 10000,
  koc_engagement_min: 50, koc_engagement_rate_min: 0.01,
  kol_engagement_min: 500, kol_engagement_rate_min: 0.03,
  auth_score_min: 60, boost_ratio_suspect: 10,
  profile_fetch_cooldown_days: 7, engagement_trigger: 50,
};

export interface AuthSignals {
  er: number;               // 互动率 = 互动/粉丝
  comment_ratio: number;    // 评论/点赞
  vs_avg: number;           // 本帖互动率 / 作者历史均值 (无历史 = 1)
  suspect_boosted: boolean; // 疑似投流
  viral: boolean;            // 单帖爆款 (ER > 50%)
  bought_followers: boolean; // 疑似买粉
  bought_likes: boolean;     // 疑似刷赞
  followers_known: boolean;
}

/** 真实度评分 0-100 (spec C2: 三路信号) */
export function authScore(opts: {
  followers: number | null;
  likes: number;
  comments: number;
  authorAvgEngagement: number; // 作者历史单帖均互动 (0 = 无历史)
}, rules: KolRules = DEFAULT_KOL_RULES): { score: number; signals: AuthSignals } {
  const engagement = opts.likes + opts.comments;
  const signals: AuthSignals = {
    er: 0, comment_ratio: opts.likes > 0 ? opts.comments / (opts.likes + 1) : 0,
    vs_avg: 1, suspect_boosted: false, viral: false,
    bought_followers: false, bought_likes: false,
    followers_known: opts.followers != null && opts.followers > 0,
  };
  if (!signals.followers_known || opts.followers === 0) {
    return { score: 0, signals }; // 粉丝未知 → 待验证
  }
  const f = opts.followers as number;
  signals.er = engagement / f;
  signals.viral = signals.er > 0.5;

  let score = 0;
  // 信号 1: 互动率健康带 0.5%–30% → +40; <0.5% 且粉丝过万 → 疑似买粉 -30
  if (signals.er >= 0.005 && signals.er <= 0.3) score += 40;
  else if (signals.er < 0.005 && f >= 10000) { score -= 30; signals.bought_followers = true; }
  else if (signals.er > 0.3 && signals.er <= 0.5) score += 20; // 偏高但可解释

  // 信号 2: 评论/点赞比 1%–15% → +30; <0.5% → 疑似刷赞 -30
  if (signals.comment_ratio >= 0.01 && signals.comment_ratio <= 0.15) score += 30;
  else if (signals.comment_ratio > 0.15) score += 15; // 讨论极热, 不扣
  else if (signals.comment_ratio < 0.005) { score -= 30; signals.bought_likes = true; }

  // 信号 3: 投流检测 — 本帖 vs 作者历史均值
  if (opts.authorAvgEngagement > 0) {
    const avgEr = opts.authorAvgEngagement / f;
    signals.vs_avg = avgEr > 0 ? +(signals.er / avgEr).toFixed(1) : 1;
    if (signals.vs_avg > rules.boost_ratio_suspect) signals.suspect_boosted = true;
    else score += 30;
  } else {
    score += 15; // 无历史数据, 折中
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), signals };
}

/** KOL/KOC 分层判定 (spec C2 规则表) */
export function classifyTier(opts: {
  followers: number | null;
  likes: number;
  comments: number;
  score: number; // authScore 输出
}, rules: KolRules = DEFAULT_KOL_RULES): "kol" | "koc" | "none" {
  if (opts.followers == null || opts.followers <= 0 || opts.score < rules.auth_score_min) return "none";
  const f = opts.followers, engagement = opts.likes + opts.comments;
  if (f >= rules.kol_followers_min &&
      (engagement >= rules.kol_engagement_min || engagement >= f * rules.kol_engagement_rate_min)) {
    return "kol";
  }
  if (f >= rules.koc_followers_min &&
      engagement >= rules.koc_engagement_min &&
      engagement >= f * rules.koc_engagement_rate_min) {
    return "koc";
  }
  return "none";
}

/** 是否值得拉取作者档案 (成本闸门) */
export function shouldFetchProfile(opts: {
  engagement: number;
  profileFetchedAt: string | null;
}, rules: KolRules = DEFAULT_KOL_RULES): boolean {
  if (opts.engagement < rules.engagement_trigger) return false;
  if (!opts.profileFetchedAt) return true;
  return Date.now() - new Date(opts.profileFetchedAt).getTime() > rules.profile_fetch_cooldown_days * 86400000;
}

/** 从公开简介提取商务邮箱 (作者主动公开的) */
export function extractEmail(bio: string | null | undefined): { email: string | null; source: string | null } {
  if (!bio) return { email: null, source: null };
  // 排除明显占位 (example.com / test)
  const m = bio.match(/[\w.+-]+@([\w-]+\.[\w.]{2,})/g);
  if (!m) return { email: null, source: null };
  const valid = m.find((e) => {
    const domain = e.split("@")[1]?.toLowerCase() ?? "";
    return !/^(example|test|yourdomain|domain|email)/.test(domain) && !domain.endsWith(".png") && !domain.endsWith(".jpg");
  });
  return valid ? { email: valid, source: "bio" } : { email: null, source: null };
}

/** 建联方向文案 (P0 确定性模板, 免费) */
export function outreachDirection(opts: {
  platform: string;
  authorName: string;
  topics: string[];        // 近期主题 top (来自已抓帖子)
  sceneFeature?: string;    // 主导场景点名的功能
  market: string;
  tier: "kol" | "koc";
}): string {
  const platName: Record<string, string> = {
    x: "X", reddit: "Reddit", youtube: "YouTube", weibo: "微博",
    xiaohongshu: "小红书", douyin: "抖音", bilibili: "B站", zhihu: "知乎",
    hatena: "はてな", niconico: "niconico",
  };
  const topicPart = opts.topics.length
    ? `近期内容集中在「${opts.topics.slice(0, 2).join("」「")}」方向`
    : "近期有真实的翻译障碍表达";
  const featurePart = opts.sceneFeature
    ? `建议以${opts.sceneFeature}的真实使用体验为切入点`
    : "建议以解决其真实痛点的方式自然切入";
  const tierPart = opts.tier === "kol"
    ? "KOL 量级，建议走正式合作流程（产品体验 + 报价沟通），注意辨别其互动中的投流成分再谈价"
    : "KOC 量级，建议以产品体验邀请/轻量合作切入，成本可控、真实感强";
  return `${platName[opts.platform] ?? opts.platform} 上该作者${topicPart}。${featurePart}，用 ${opts.authorName} 本人发过的问题做开场最自然，避免硬广口吻。${tierPart}。`;
}

// ---------- 函数主体 ----------
// api-posts: 需求帖全生命周期 — 列表/详情/认领(条件更新)/保存草稿/母语审核/标记已回复/跳过/释放





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
