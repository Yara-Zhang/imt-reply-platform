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

// ---------- 函数主体 ----------
// api-reply: 认领并起草 / 重新起草 — v2 §5.2 提示词 + 母语审核拦截 + 品牌检查两级 + C6 模板注入





const LANG_NAME: Record<string, string> = { ja: "日本語", ko: "한국어", en: "English", zh: "简体中文" };

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const member = await requireMember(req);
  if (!member) return json({ error: "未登录" }, 401);
  if (req.method !== "POST") return json({ error: "not found" }, 404);

  const body = await req.json().catch(() => ({}));
  const { id, requirement } = body as { id?: string; requirement?: string };
  if (!id) return json({ error: "缺少帖子 id" }, 400);
  const client = sb();
  const { data: post } = await client.from("demand_posts").select("*").eq("id", id).single();
  if (!post) return json({ error: "帖子不存在" }, 404);

  // 并发: 他人已认领则拦截
  if (post.claimed_by && post.claimed_by !== member.id) {
    const { data: other } = await client.from("members").select("name").eq("id", post.claimed_by).single();
    return json({ error: `已被 ${other?.name ?? "其他同事"} 认领, 不能代为起草` }, 409);
  }

  // 阶段拦截: 日/韩阶段 0
  const { data: stageCfg } = await client.from("app_config").select("value").eq("key", "market_stage").single();
  const stage = ((stageCfg?.value ?? {}) as Record<string, number>)[post.market] ?? 2;
  const block = checkDraftAllowed(post.market, stage);
  if (block.blocked) return json({ error: block.message }, 400);

  // 若是 open → 条件更新认领 (一键合并, v2)
  if (post.state === "open") {
    const { count } = await client.from("demand_posts")
      .update({ state: "claimed", claimed_by: member.id, claimed_at: new Date().toISOString() })
      .eq("id", id).eq("state", "open").select("id", { count: "exact", head: true });
    if (!count) return json({ error: "认领冲突: 已被他人抢先" }, 409);
  }

  // 场景与品牌信息
  const [{ data: scene }, { data: brandCfg }, { data: rulesCfg }] = await Promise.all([
    post.demand_id
      ? client.from("demand_scenes").select("*").eq("id", post.demand_id).single()
      : Promise.resolve({ data: null }),
    client.from("app_config").select("value").eq("key", "brand").single(),
    client.from("app_config").select("value").eq("key", "brand_rules").single(),
  ]);
  const brand = (brandCfg?.value ?? {}) as { name_cn: string; name_en: string; site: string };
  const rules = (rulesCfg?.value ?? { must: [], warn: [] }) as { must: never[]; warn: never[] };

  // C6: 同场景 TOP3 模板注入 (P0: 有表就用, 无则跳过)
  const { data: templates } = await client.from("reply_templates")
    .select("content").eq("demand_id", post.demand_id).eq("market", post.market)
    .eq("status", "active").order("avg_outcome", { ascending: false }).limit(3);
  const tpl = (templates ?? []).map((t) => t.content);

  const lang = replyLang(post.market, post.lang);
  const system = draftSystemPrompt(
    brand.name_cn ?? "沉浸式翻译", brand.name_en ?? "Immersive Translate", LANG_NAME[lang],
    scene?.feature ?? "双语对照翻译", scene?.capability ?? ["双语对照翻译"], brand.site ?? "https://immersivetranslate.com/",
  );
  const user = draftUserPrompt({
    platform: post.platform,
    sceneLabel: scene ? `${scene.id} ${scene.name}` : "未归类",
    summary: post.summary ?? "",
    postText: `${post.title ?? ""}\n${post.content ?? ""}`.slice(0, 1500),
    templates: tpl.length ? tpl : undefined,
    userRequirement: requirement?.slice(0, 300),
  });

  // 起草 (高质量模型)
  let draft = "", suitableNote = "";
  try {
    const result = await deepSeekJson<{ suitable: boolean; reason: string; reply: string }>(system, user, false);
    if (!result.suitable) {
      suitableNote = result.reason ?? "AI 判断不适合回复";
    } else {
      draft = (result.reply ?? "").slice(0, 4000);
    }
  } catch (e) {
    return json({ error: `AI 起草失败: ${(e as Error).message}` }, 502);
  }

  const issues = draft ? brandCheck(draft, rules, brand.site ?? "https://immersivetranslate.com/")
    : ([{ level: "must", rule: "ai_unsuitable", label: `AI 判断不适合回复——${suitableNote}。如确认要回复，请手动撰写，或直接跳过这条。` }] as never[]);

  const { data: updated } = await client.from("demand_posts").update({
    reply_draft: draft, draft_at: new Date().toISOString(),
    brand_issues: issues, suitable_note: suitableNote || null,
    // 重新起草清空母语审核 (v2 规则)
    ja_reviewed_by: null, ja_reviewed_at: null,
  }).eq("id", id).select("*").single();

  return json({ post: updated });
});
