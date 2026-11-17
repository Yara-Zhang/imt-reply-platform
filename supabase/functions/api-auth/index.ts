// api-auth: 登录双通道 — 邮箱密码(PBKDF2) + 飞书扫码 OAuth; 自签 JWT 会话
import { cors, env, json, sb, signJwt } from "../_shared/glue.ts";

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
