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

// ---------- 内联自 functions/_shared/logic/gates.ts ----------
// URL 规范化 (v2 §6.5 规则) + 引句核验 (v1 verifyQuote ⊕ v2 五项代码门槛)

const TRACK_PARAMS = /^(utm_[a-z_]+|refer_flag|xsec_[a-z_]+|spm|from|share|s|t|si)$/i;

/** URL 规范化: 去 # 锚点 → 去跟踪参数 → 统一 https → 去末尾斜杠 */
export function normalizeUrl(raw: string): string {
  let u = (raw || "").trim().toLowerCase();
  u = u.replace(/#.*$/, "");
  u = u.replace(/^[a-z]+:\/\//, "");
  // 移除跟踪参数
  const qi = u.indexOf("?");
  if (qi >= 0) {
    const base = u.slice(0, qi);
    const kept = u.slice(qi + 1).split("&").filter((kv) => {
      const k = kv.split("=")[0];
      return k && !TRACK_PARAMS.test(k);
    });
    u = kept.length ? `${base}?${kept.join("&")}` : base;
  }
  u = u.replace(/\/+$/, "");
  return `https://${u}`;
}

export function urlHash(raw: string): string {
  // Deno 内置 crypto; 返回前 32 位足够去重
  const data = new TextEncoder().encode(normalizeUrl(raw));
  return crypto.subtle.digest("SHA-256", data).then((b) =>
    [...new Uint8Array(b)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("")
  ) as unknown as string;
}

/** 同步版哈希(用于幂等测试可用简单串): 返回规范化 URL 本身做键也可 */
export async function hashUrl(raw: string): Promise<string> {
  const data = new TextEncoder().encode(normalizeUrl(raw));
  const b = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(b)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- 引句核验 (v1 verifyQuote 规则) ----------
function squash(s: string): string {
  return (s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** 引句是否出现在原帖: 完全包含 → 通过; 否则 3 字符滑窗 ≥60% 命中 → 通过 */
export function verifyQuote(quote: string | null, content: string): boolean {
  if (!quote) return false;
  const q = squash(quote), c = squash(content);
  if (q.length < 4) return false;
  if (c.includes(q)) return true;
  // 切成 3 字符片段
  const frags: string[] = [];
  for (let i = 0; i < q.length; i += 3) frags.push(q.slice(i, i + 3));
  const hits = frags.filter((f) => f && c.includes(f)).length;
  return frags.length > 0 && hits / frags.length >= 0.6;
}

// ---------- 需求帖五项代码门槛 (v2 §2.3) ----------
const HUMAN_TRANSLATION_SUBS = [
  "r/translator", "r/translate", "r/translation", "r/languagelearning",
  "r/learnjapanese", "r/korean", "r/french", "r/spanish", "r/german",
];

export interface GateResult {
  pass: boolean;
  reason?: string; // 不通过原因文案(入库备注)
}

export function demandGate(opts: {
  confidence: number | null;
  url: string;
  content: string;
  quote: string | null;
  quoteInPost: boolean;
}): GateResult {
  // 1 置信度 ≥ 0.7
  if (opts.confidence == null || opts.confidence < 0.7) {
    return { pass: false, reason: `置信度 ${opts.confidence} < 0.7` };
  }
  // 2 不在人工翻译求助版块
  const u = (opts.url || "").toLowerCase();
  if (HUMAN_TRANSLATION_SUBS.some((s) => u.includes(s)) || u.includes("translate—")) {
    return { pass: false, reason: "人工翻译求助版块" };
  }
  // 3 正文去噪后 ≥ 15 字符
  const stripped = (opts.content || "")
    .replace(/https?:\/\/\S+/g, "").replace(/#[^\s#]+/g, "")
    .replace(/@\w+/g, "").replace(/submitted by.*$/i, "");
  if (squash(stripped).length < 15) return { pass: false, reason: "正文过短" };
  // 4/5 引句存在且在原帖中
  if (!opts.quote || squash(opts.quote).length < 4) {
    return { pass: false, reason: "没有能说明卡点的原句" };
  }
  if (!opts.quoteInPost) return { pass: false, reason: "引用的原句不在帖子里" };
  return { pass: true };
}

// ---------- 市场判定 (v2 §7.1 顺序) ----------
export function marketOf(
  kwMarket: Market | null,
  lang: string | null,
  platform: string,
): Market {
  if (kwMarket) return kwMarket;
  if (lang === "ja" || platform === "hatena" || platform === "niconico") return "jp";
  if (lang === "ko") return "kr";
  if (lang === "zh" || ["weibo", "xiaohongshu", "zhihu", "bilibili", "douyin"].includes(platform)) return "cn";
  return "en";
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

// ---------- 内联自 functions/_shared/logic/prompts.ts ----------
// AI 提示词拼装 — v2 §2.2 / §5.2 逐字沿用 + brandMention 字段 + C6 模板注入段

export interface ScreenInput {
  platform: string;
  market: string;
  publishedAt: string;
  hintType?: string;
  hintCompetitor?: string;
  hitKeyword?: string;
  isDemandKeyword: boolean;
  title: string;
  content: string;
}

/** 初筛系统提示词 (v2 §2.2 原文 + 双通道分流新增 brandMention/competitors) */
export function screenSystemPrompt(sceneList: SceneRow[]): string {
  const scenes = sceneList
    .map((s) => `${s.id} ${s.name}（能力：${(s.capability || []).join("、")}）`)
    .join("\n");
  return `你是对运营初筛助手。对每条帖子输出 JSON：{isDemandPost, demandId, demandSummary, demandTopic, demandQuote, relevance, brandMention, competitors}。

需求帖判定（isDemandPost）：需求帖 = 一个具体用户本人此刻正在遭遇翻译 / 外语阅读障碍并表达出来的帖子（如"这部剧 Prime 上没有日语字幕""英语论文读不懂""Discord 海外服聊天跟不上""X 的翻译把意思翻反了"），它是常绿需求，没有时间窗，需要的是有人去回复它。判为需求帖时 isDemandPost=true、relevant=true、relevance 表示"确实是真实用户的翻译障碍"的置信度，demandId 填所属需求场景，demandSummary 用一句中文写清用户卡在哪（≤40 字），demandTopic 用 2–8 个中文字概括话题（如"K-Pop 幕后字幕"），同类帖子用相同话题。

以下情况不是需求帖、不判为需求帖：① 发布者是在"提供"翻译而不是"需要"翻译——字幕组 / 粉丝发布的中字视频、熟肉、翻译作品（常见"翻译：@某人""资源：@某人""中字""熟肉"）；② 成人、色情、NSFW、暴力血腥、政治敏感或涉及自残的内容；③ 与翻译无关的软件故障或使用问题；④ 只想要真人翻译一句话或一张图、且帖子本身就在专门的人工翻译求助版块里的请求——除非用户明确说机翻不行、想找工具或经常遇到这类问题；⑤ 正文过短看不出用户卡在哪；⑥ 用户的问题本身不是语言障碍；⑦ 讨论正在发生、有时间窗的事件（平台故障、涨价、新作上线）。

判为需求帖时必须填 demandQuote：从原帖逐字照抄一句（≤60 字）能直接看出"发帖人本人卡在外语上"的原话，如"韓国語全然わからん""no english subtitles"；找不到这样的原句就不是需求帖。需求帖的 relevance 低于 0.7 视为不是需求帖。命中词标注"需求词"的条目更可能是需求帖，但仍需按上述标准判断。非需求帖的 demandSummary、demandTopic 置 null，但请尽量填 demandId。

品牌提及（brandMention）：帖子是否提到"沉浸式翻译"或"Immersive Translate"（true/false）；提到竞品（DeepL、Google 翻译/Google翻訳、Trancy、腾讯翻译君、彩云小译、papago 等）时 competitors 填竞品名数组，否则空数组。

需求场景列表：
${scenes}`;
}

/** 单条帖子的用户提示词 (v2 §2.2 格式) */
export function screenUserPrompt(item: ScreenInput): string {
  const head = `#条目 [${item.platform}/${item.market}] 发布时间${item.publishedAt}` +
    (item.hintType ? ` 提示类型=${item.hintType}` : "") +
    (item.hintCompetitor ? ` 提示竞品=${item.hintCompetitor}` : "") +
    (item.hitKeyword ? ` 命中词=${item.hitKeyword}${item.isDemandKeyword ? "（需求词）" : ""}` : "");
  const body = `${item.title}\n${item.content}`.replace(/\s+/g, " ").slice(0, 500);
  return `${head}\n${body}`;
}

// ---------- 起草回复 (v2 §5.2 原文 + 模板注入 + 新功能注入) ----------
export function draftSystemPrompt(
  brandCn: string, brandEn: string, replyLangName: string,
  sceneFeature: string, sceneCapability: string[], site: string,
): string {
  return `你在帮沉浸式翻译（${brandCn} / ${brandEn}）的社区运营起草一条回复，回复会由运营本人从个人或官方账号手动发出。
要求：
1. 用${replyLangName}写，语气像热心的普通用户，口语、简短（中文 ≤120 字，英文 ≤60 词，日文 ≤150 字），符合该平台的回复习惯。
2. 先直接回应对方的问题或处境（给一个能马上用上的办法或理解），再自然地提一句可以用${brandCn}的「${sceneFeature}」（${sceneCapability.join("、")}）来解决，说清怎么用，一句即可。
3. 不硬广：不用感叹号堆砌、不说"最好 / 第一 / 唯一 / 永久免费 / No.1 / 日本一"等绝对化用语，不贬低其他工具，不承诺对方平台一定支持。
4. 不教人绕过付费墙、下载盗版字幕或资源。
5. 如需放链接，只能用 ${site}，最多一个；不确定就不放。
先判断这条帖子适不适合由品牌方回复（suitable）：发布者其实是在分享自己的翻译成果、内容涉及成人 / 敏感话题、用户的问题与翻译无关、或回复工具会显得突兀冒犯时，suitable=false，reason 用一句中文说明，reply 置空字符串。适合时 suitable=true，reason 写一句为什么适合，reply 为回复正文。
输出 JSON：{suitable, reason, reply}`;
}

export function draftUserPrompt(opts: {
  platform: string;
  sceneLabel: string;      // "D03 流媒体缺字幕" 或 "未归类"
  summary: string;
  postText: string;        // 标题+正文 前1500字
  newFeatures?: string[];  // 近30天同场景新功能 (v2 §3.3)
  templates?: string[];    // C6: 同场景 TOP3 模板
  userRequirement?: string; // 重新起草时的修改要求
}): string {
  let p = `平台：${opts.platform}\n需求场景：${opts.sceneLabel}\n用户卡点：${opts.summary}\n原帖：${opts.postText}`;
  if (opts.newFeatures && opts.newFeatures.length) {
    p += `\n\n近 30 天沉浸式翻译新功能（只有确实能解决这位用户的问题时才提，并说清楚用法）：\n- ${opts.newFeatures.join("\n- ")}`;
  }
  if (opts.templates && opts.templates.length) {
    p += `\n\n以下是同场景已验证的高质量回复范例，风格可参考，但必须针对本帖处境改写，禁止照抄：\n- ${opts.templates.join("\n- ")}`;
  }
  if (opts.userRequirement) {
    p += `\n\n运营的修改要求：${opts.userRequirement}`;
  }
  return p;
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
// crawl-tick: 每 5 分钟一轮 — 队列出队(优先级防饿死) → TikHub 抓取 → DeepSeek 批量初筛 → 双通道分流 → quote 门槛 → 入库
// 触发: pg_cron 通过 pg_net 调用本 function (v1 模式, DEPLOY.md 有配置步骤)






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

/** TikHub 用户详情 (followers + bio); P0 支持 X, 其他平台返回 null */
async function tikhubProfile(platform: string, authorId: string): Promise<{ followers: number | null; bio: string | null } | null> {
  const paths: Record<string, string> = {
    x: "/twitter/web/get_user_info",
    // 其他平台端点在 P1 按需补充
  };
  const path = paths[platform];
  if (!path || !env.tikhubKey) return null;
  const r = await fetch(`https://api.tikhub.io${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.tikhubKey}` },
    body: JSON.stringify({ user_id: authorId, screen_name: authorId }),
  });
  if (!r.ok) throw new Error(`TikHub profile ${platform} ${r.status}`);
  const j = await r.json();
  const d = j?.data ?? {};
  return {
    followers: Number(d.followers_count ?? d.followers ?? d.follower_count) || null,
    bio: String(d.description ?? d.bio ?? "") || null,
  };
}

// 平台 → TikHub 接口 (v2 §6.2)
const TIKHUB_ENDPOINTS: Record<string, { path: string; langOp?: boolean }> = {
  weibo: { path: "/weibo/web_v2/fetch_realtime_search" },
  xiaohongshu: { path: "/xiaohongshu/app_v2/search_notes" },
  douyin: { path: "/douyin/web/fetch_general_search" },
  zhihu: { path: "/zhihu/web/fetch_article_search_v3" },
  bilibili: { path: "/bilibili/web/fetch_general_search" },
  reddit: { path: "/reddit/app/fetch_dynamic_search" },
  x: { path: "/twitter/web/fetch_search_timeline", langOp: true },
  youtube: { path: "/youtube/web_v2/get_general_search_v2" },
  hatena: { path: "" },   // 免费公开接口
  niconico: { path: "" },  // 免费公开接口
};

async function tikhubSearch(platform: string, keyword: string, market: string) {
  const ep = TIKHUB_ENDPOINTS[platform];
  if (!ep || !ep.path) return []; // 免费源 P0 先跳过, P1 接入
  const q = ep.langOp && market === "jp" ? `${keyword} lang:ja` : ep.langOp && market === "kr" ? `${keyword} lang:ko` : keyword;
  const r = await fetch(`https://api.tikhub.io${ep.path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.tikhubKey}` },
    body: JSON.stringify({ keyword: q, sort: platform === "reddit" ? "NEW" : undefined, ...q !== keyword ? { query: q } : {} }),
  });
  if (!r.ok) throw new Error(`TikHub ${platform} ${r.status}`);
  const j = await r.json();
  const list = j?.data?.data ?? j?.data ?? [];
  return Array.isArray(list) ? list : [];
}

interface RawItem {
  url?: string; link?: string; title?: string; content?: string; text?: string;
  author?: string; screen_name?: string; nickname?: string;
  published_at?: string; publish_time?: string; created_at?: string;
  likes?: number; comment_count?: number; comments?: number; retweets?: number; favorite_count?: number;
  lang?: string;
}
const pick = (o: RawItem | undefined, ...keys: string[]) => {
  for (const k of keys) if (o && (o as Record<string, unknown>)[k] != null) return String((o as Record<string, unknown>)[k]);
  return "";
};

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
  const fresh: { kwId: string; kwMarket: string; platform: string; item: RawItem }[] = [];
  for (const { kw, platform } of batch) {
    // 平台每日调用硬上限 (spec §11.3)
    const usedCalls = usageMap.get(platform)?.calls ?? 0;
    const cap = caps[platform];
    if (cap && usedCalls >= cap) { notes.push(`${platform} 触达日上限 ${cap}, 跳过`); continue; }
    try {
      const results = await tikhubSearch(platform, kw.keyword, kw.market);
      for (const it of results) {
        const url = pick(it, "url", "link");
        const published = pick(it, "published_at", "publish_time", "created_at");
        const pubDate = published ? new Date(published) : null;
        // 时效过滤: 超 7 天丢弃; 解析不出/晚于当前 1h 的丢弃 (v2 §6.5)
        if (!url || !pubDate || isNaN(pubDate.getTime())) continue;
        if (Date.now() - pubDate.getTime() > 7 * 86400000) continue;
        if (pubDate.getTime() > Date.now() + 3600000) continue;
        fresh.push({ kwId: kw.id, kwMarket: kw.market, platform, item: it });
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
  const pooled: { kwId: string; kwMarket: string; platform: string; itemId: string; title: string; content: string; url: string; publishedAt: string; lang: string; likes: number; comments: number; authorId: string; authorName: string }[] = [];
  for (const f of fresh) {
    const urlHash = await hashUrl(pick(f.item, "url", "link"));
    const { error: dupErr } = await client.from("crawl_items").upsert({
      keyword_id: f.kwId, platform: f.platform, market: f.kwMarket,
      url: pick(f.item, "url", "link"), url_hash: urlHash,
      author_id: pick(f.item, "author", "screen_name"), author_name: pick(f.item, "nickname", "author", "screen_name"),
      published_at: pick(f.item, "published_at", "publish_time", "created_at"),
      raw_title: pick(f.item, "title").slice(0, 500),
      raw_content: pick(f.item, "content", "text").slice(0, 4000),
      metrics_json: {
        likes: Number(pick(f.item, "likes", "favorite_count")) || 0,
        comments: Number(pick(f.item, "comment_count", "comments")) || 0,
      },
      lang: f.item.lang ?? null,
      ai_status: "pending",
    }, { onConflict: "url_hash", ignoreDuplicates: true });
    if (!dupErr) {
      const { data: item } = await client.from("crawl_items").select("id").eq("url_hash", urlHash).single();
      if (item && item.ai_status === "pending") {
        pooled.push({
          kwId: f.kwId, kwMarket: f.kwMarket, platform: f.platform, itemId: item.id,
          title: pick(f.item, "title"), content: pick(f.item, "content", "text"),
          url: pick(f.item, "url", "link"), publishedAt: pick(f.item, "published_at", "publish_time", "created_at"),
          lang: f.item.lang ?? "",
          likes: Number(pick(f.item, "likes", "favorite_count")) || 0,
          comments: Number(pick(f.item, "comment_count", "comments")) || 0,
          authorId: pick(f.item, "author", "screen_name"), authorName: pick(f.item, "nickname", "author", "screen_name"),
        });
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
          platform: c.platform, market: c.kwMarket, publishedAt: c.publishedAt,
          isDemandKeyword: true, hitKeyword: "需求词", title: c.title, content: c.content,
        })).join("\n\n");
      const result = await deepSeekJson<Record<string, {
        isDemandPost: boolean; demandId: string | null; demandSummary: string | null;
        demandTopic: string | null; demandQuote: string | null; relevance: number;
        brandMention: boolean; competitors: string[];
      }>>(system, `以下 ${chunk.length} 条帖子, 返回 JSON: {results: {"0": {...}, "1": {...}}} 按编号。不相关的也返回编号键, 各字段置空。\n\n${userMsg}`, true);
      const results = (result as { results?: Record<string, typeof result[number]> }).results ?? result;

      for (let idx = 0; idx < chunk.length; idx++) {
        const c = chunk[idx];
        const r = results[String(idx)];
        if (!r) continue;
        const fullText = `${c.title}\n${c.content}`;
        const isDemand = r.isDemandPost &&
          demandGate({ confidence: r.relevance, url: c.url, content: fullText, quote: r.demandQuote, quoteInPost: verifyQuote(r.demandQuote, fullText) }).pass;
        const isBrand = !!r.brandMention;

        // 双通道分流 (spec §4.1)
        if (isDemand) {
          const market = marketOf(c.kwMarket as never, c.lang, c.platform);

          // ---- KOL/KOC 分层 (spec C2 增强版): 作者聚合 + 档案 + 真实度 ----
          let kolTier: "kol" | "koc" | "none" = "none";
          if (c.authorId) {
            kolTier = await classifyAuthor(c);
          }

          const { error } = await client.from("demand_posts").upsert({
            item_id: c.itemId, market, platform: c.platform, url: c.url,
            author_id: c.authorId || null, author_name: c.authorName || null, published_at: c.publishedAt,
            title: c.title.slice(0, 500), content: c.content.slice(0, 4000),
            demand_id: r.demandId && (scenes ?? []).some((s) => s.id === r.demandId) ? r.demandId : null,
            summary: (r.demandSummary ?? "").slice(0, 300), quote: (r.demandQuote ?? "").slice(0, 60),
            quote_verified: verifyQuote(r.demandQuote, fullText), topic: r.demandTopic ?? null,
            lang: c.lang || null, confidence: r.relevance ?? null,
            kol_tier: kolTier,
            priority_score: priorityScore({ likes: c.likes, comments: c.comments, publishedAt: c.publishedAt, isKol: kolTier === "kol", highEngAuthor: false, sameTopicCount: 0 }),
            stale: isStale(c.publishedAt), state: "open",
          }, { onConflict: "item_id", ignoreDuplicates: true });
          if (!error) demandIn++;
        }
        if (isBrand) {
          await client.from("brand_posts").upsert({
            item_id: c.itemId, market: c.kwMarket, platform: c.platform, url: c.url,
            published_at: c.publishedAt, content: fullText.slice(0, 4000),
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
