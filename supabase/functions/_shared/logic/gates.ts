// URL 规范化 (v2 §6.5 规则) + 引句核验 (v1 verifyQuote ⊕ v2 五项代码门槛)
import type { Market } from "./types.ts";

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
