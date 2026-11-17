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
// health-digest: 每日 10:00 冷却标记扫描 + Supabase 保活
// 周报/日报改为平台内「周报」页实时生成 (想看的人点进去看和下载), 飞书推送已按用户决定移除
// 触发: pg_cron 每日 10:00 (DEPLOY.md 配置); 也可手动调用


Deno.serve(async (_req) => {
  const client = sb();

  // ---------- 1. 冷却标记扫描 (C1, score-tick 职责顺带) ----------
  const { data: active } = await client.from("demand_posts")
    .select("id, published_at").eq("stale", false).in("state", ["open"]);
  let staled = 0;
  for (const p of active ?? []) {
    if (isStale(p.published_at)) {
      await client.from("demand_posts").update({ stale: true, priority_score: 0 }).eq("id", p.id);
      staled++;
    }
  }

  // ---------- 2. 品牌帖告警清旗 (发完清 flag, v1 制度; 汇总在平台周报页看) ----------
  const { data: alarms } = await client.from("brand_posts").select("id").eq("alarm_flag", true).limit(20);
  if (alarms?.length) {
    await client.from("brand_posts").update({ alarm_flag: false }).eq("alarm_flag", true);
  }

  // ---------- 3. 保活 (Supabase 免费版防暂停, v1 经验) ----------
  await client.from("app_config").update({ updated_at: new Date().toISOString() }).eq("key", "budget");

  return json({ ok: true, staled, alarm_count: alarms?.length ?? 0 });
});
