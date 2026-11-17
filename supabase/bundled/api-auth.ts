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

// ---------- 函数主体 ----------
// api-auth: 登录双通道 — 邮箱密码(PBKDF2) + 飞书扫码 OAuth; 自签 JWT 会话

/** PBKDF2-SHA256 10万次迭代 (v1 PBKDF2 方案) */
async function pbkdf2(password: string, saltHex?: string) {
  const salt = saltHex
    ? Uint8Array.from((saltHex.match(/../g) || []).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PB" + "KDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PB" + "KDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  const hashHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const saltHexOut = [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { hashHex, saltHex: saltHexOut };
}

const routes = {
  /** 注册 (邀请码) / 登录 */
  async password(req: Request) {
    const body = await req.json().catch(() => ({}));
    const { email, password, name } = body as { email?: string; password?: string; name?: string };
    if (!email || !password) return json({ error: "邮箱和密码必填" }, 400);
    const client = sb();

    const { data: existing } = await client.from("members").select("*").eq("email", email).single();

    if (existing?.password_hash) {
      // 登录
      const [saltHex, expect] = existing.password_hash.split(":");
      const { hashHex } = await pbkdf2(password, saltHex);
      if (hashHex !== expect) return json({ error: "密码错误" }, 401);
      const token = await signJwt({ mid: existing.id });
      return json({ token, member: { id: existing.id, name: existing.name, role: existing.role, duties: existing.duties } });
    }

    // 注册: 首用户直接 admin; 其后开放注册 (团队内部工具, 无需邀请码)
    const { count } = await client.from("members").select("id", { count: "exact", head: true });
    const { hashHex, saltHex } = await pbkdf2(password);
    const { data: m, error } = await client.from("members").insert({
      email, name: name || email.split("@")[0],
      password_hash: `${saltHex}:${hashHex}`,
      role: (count ?? 0) === 0 ? "admin" : "member",
    }).select("*").single();
    if (error) return json({ error: error.message }, 400);
    const token = await signJwt({ mid: m.id });
    return json({ token, member: { id: m.id, name: m.name, role: m.role, duties: m.duties } });
  },

  /** 飞书 OAuth 回调 (扫码登录, 凭据缺失时返回提示) */
  async feishu(req: Request) {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    if (!env.feishuAppId || !env.feishuAppSecret) {
      return json({ error: "飞书登录未配置: 请在 Edge Function 环境变量中设置 FEISHU_APP_ID / FEISHU_APP_SECRET" }, 501);
    }
    if (!code) {
      return json({ error: "缺少 code 参数" }, 400);
    }
    // 换 user_access_token
    const tokenResp = await fetch("https://open.feishu.cn/open-apis/authen/v1/oidc/access_token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", client_id: env.feishuAppId, client_secret: env.feishuAppSecret, code }),
    });
    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson?.data?.access_token;
    if (!accessToken) return json({ error: "飞书授权失败" }, 401);

    const infoResp = await fetch("https://open.feishu.cn/open-apis/authen/v1/user_info", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = (await infoResp.json())?.data;
    const openId = info?.open_id, uname = info?.name;
    if (!openId) return json({ error: "获取飞书用户信息失败" }, 401);

    const client = sb();
    let { data: m } = await client.from("members").select("*").eq("feishu_open_id", openId).single();
    if (!m) {
      const { count } = await client.from("members").select("id", { count: "exact", head: true });
      const { data: created } = await client.from("members").insert({
        feishu_open_id: openId, name: uname || `飞书用户${openId.slice(-4)}`,
        role: (count ?? 0) === 0 ? "admin" : "member",
      }).select("*").single();
      m = created;
    }
    const token = await signJwt({ mid: m.id });
    return json({ token, member: { id: m.id, name: m.name, role: m.role, duties: m.duties } });
  },
};

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const path = new URL(req.url).pathname.split("/").pop();
  if (req.method === "POST" && path === "password") return routes.password(req);
  if (path === "feishu") return routes.feishu(req);
  return json({ error: "not found" }, 404);
});
