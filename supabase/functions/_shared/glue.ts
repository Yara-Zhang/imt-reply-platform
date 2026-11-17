// 平台胶水层: Supabase client / JWT 鉴权 / DeepSeek / TikHub / 飞书 —— 仅此层依赖平台环境
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
