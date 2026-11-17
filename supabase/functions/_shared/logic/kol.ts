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
