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
