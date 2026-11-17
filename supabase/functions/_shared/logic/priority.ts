// priority_score 计算 (spec C1) + 品牌检查两级 (v2 §5.3) + 冷却判定
import type { BrandIssue } from "./types.ts";

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
