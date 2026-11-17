// 状态机拦截规则 — 教学式文案 (spec §9)
import type { BrandIssue, DemandPost, Member } from "./types.ts";

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
