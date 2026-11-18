// 多平台用户档案拉取 (TikHub, 2026-11 openapi + pg_net 实测校准)
// 支持: x / weibo / reddit / xiaohongshu; 其他平台返回 null (无档案端点)
import { env } from "./glue.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface AuthorProfile {
  followers: number | null;
  bio: string | null;
  /** 归一化后的作者键 (微博 search 结果的 uid, 与传入不同时供回填) */
  resolvedId: string | null;
  /** Reddit 专属: karma 总分 (无粉丝字段, 作影响力参考) */
  karma?: number | null;
}

async function tget(path: string): Promise<Record<string, unknown> | null> {
  if (!env.tikhubKey) return null;
  const r = await fetch(`https://api.tikhub.io${path}`, {
    headers: { Authorization: `Bearer ${env.tikhubKey}`, "User-Agent": UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`TikHub ${path.split("?")[0]} ${r.status}`);
  return await r.json() as Record<string, unknown>;
}

/**
 * 各平台档案: authorId 优先, 缺省时用 authorName (微博按显示名搜索)
 * - x:         fetch_user_profile?screen_name=   → data.friends(粉丝) / data.desc
 * - weibo:     fetch_user_search?query=<名>      → data.parsed_data.users[] (uid/fans/name 精确匹配)
 * - reddit:    app/fetch_user_profile?username=  → data (多字段兼容)
 * - xiaohongshu: web_v3/fetch_user_info?user_id= → data (多字段兼容)
 */
export async function tikhubProfile(
  platform: string,
  authorId: string,
  authorName?: string | null,
): Promise<AuthorProfile | null> {
  const d = (j: Record<string, unknown> | null) => (j?.data ?? null) as Record<string, unknown> | null;
  if (!authorId && !authorName) return null;

  try {
    if (platform === "x") {
      const j = d(await tget(`/api/v1/twitter/web/fetch_user_profile?screen_name=${encodeURIComponent(authorId)}`));
      if (!j) return null;
      return {
        followers: Number(j.followers_count ?? j.followers ?? j.follower_count ?? j.friends) || null,
        bio: String(j.description ?? j.bio ?? j.desc ?? "") || null,
        resolvedId: authorId,
      };
    }

    if (platform === "weibo") {
      // authorId 可能是显示名/昵称 (存量) — 用名字搜索, 精确匹配 name 后取 uid+fans
      const q = authorName || authorId;
      const j = d(await tget(`/api/v1/weibo/web_v2/fetch_user_search?query=${encodeURIComponent(q)}&page=1`));
      const pd = (j?.parsed_data ?? {}) as Record<string, unknown>;
      const users = Array.isArray(pd.users) ? pd.users as Record<string, unknown>[] : [];
      const hit = users.find((u) => String(u.name ?? "") === q) ?? users[0];
      if (!hit) return null;
      return {
        followers: Number(hit.fans ?? hit.followers_count ?? hit.followers) || null,
        bio: null,
        resolvedId: String(hit.uid ?? authorId),
      };
    }

    if (platform === "reddit") {
      // username 不带 u/ 前缀; 响应为 GraphQL 风格: data.redditorInfoByName (2026-11 实测)
      const uname = authorId.replace(/^\/?u\//, "");
      const j = d(await tget(`/api/v1/reddit/app/fetch_user_profile?username=${encodeURIComponent(uname)}&need_format=false`));
      const info = (j?.redditorInfoByName ?? j) as Record<string, unknown> | null;
      if (!info || !info.name) return null;
      const prof = (info.profile ?? {}) as Record<string, unknown>;
      const karma = ((info.karma ?? {}) as Record<string, unknown>);
      return {
        followers: Number(prof.subscribersCount ?? info.followers ?? info.follower_count ?? info.total_karma) || null,
        bio: String(prof.publicDescriptionText ?? prof.description ?? info.description ?? "") || null,
        resolvedId: uname,
        karma: Number(karma.total) || null,
      };
    }

    if (platform === "xiaohongshu") {
      const j = d(await tget(`/api/v1/xiaohongshu/web_v3/fetch_user_info?user_id=${encodeURIComponent(authorId)}`));
      if (!j) return null;
      const u = (j.user_info ?? j) as Record<string, unknown>;
      return {
        followers: Number(u.fans ?? u.fansCount ?? u.follower_count ?? u.followers) || null,
        bio: String(u.desc ?? u.description ?? u.intro ?? "") || null,
        resolvedId: authorId,
      };
    }
  } catch {
    return null; // 档案失败不阻塞主流程
  }
  return null;
}
