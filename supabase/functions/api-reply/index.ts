// api-reply: 认领并起草 / 重新起草 — v2 §5.2 提示词 + 母语审核拦截 + 品牌检查两级 + C6 模板注入
import { cors, deepSeekJson, json, requireMember, sb } from "../_shared/glue.ts";
import { checkDraftAllowed } from "../_shared/logic/state-machine.ts";
import { draftSystemPrompt, draftUserPrompt } from "../_shared/logic/prompts.ts";
import { brandCheck } from "../_shared/logic/priority.ts";
import { replyLang } from "../_shared/logic/state-machine.ts";

const LANG_NAME: Record<string, string> = { ja: "日本語", ko: "한국어", en: "English", zh: "简体中文" };

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const member = await requireMember(req);
  if (!member) return json({ error: "未登录" }, 401);
  if (req.method !== "POST") return json({ error: "not found" }, 404);

  const body = await req.json().catch(() => ({}));
  const { id, requirement } = body as { id?: string; requirement?: string };
  if (!id) return json({ error: "缺少帖子 id" }, 400);
  const client = sb();
  const { data: post } = await client.from("demand_posts").select("*").eq("id", id).single();
  if (!post) return json({ error: "帖子不存在" }, 404);

  // 并发: 他人已认领则拦截
  if (post.claimed_by && post.claimed_by !== member.id) {
    const { data: other } = await client.from("members").select("name").eq("id", post.claimed_by).single();
    return json({ error: `已被 ${other?.name ?? "其他同事"} 认领, 不能代为起草` }, 409);
  }

  // 阶段拦截: 日/韩阶段 0
  const { data: stageCfg } = await client.from("app_config").select("value").eq("key", "market_stage").single();
  const stage = ((stageCfg?.value ?? {}) as Record<string, number>)[post.market] ?? 2;
  const block = checkDraftAllowed(post.market, stage);
  if (block.blocked) return json({ error: block.message }, 400);

  // 若是 open → 条件更新认领 (一键合并, v2)
  if (post.state === "open") {
    const { count } = await client.from("demand_posts")
      .update({ state: "claimed", claimed_by: member.id, claimed_at: new Date().toISOString() })
      .eq("id", id).eq("state", "open").select("id", { count: "exact", head: true });
    if (!count) {
      // 二次确认: 被谁抢先? 是本人并发请求 (双击 Enter) 则继续起草; 真是他人则 409
      const { data: fresh } = await client.from("demand_posts").select("claimed_by, state").eq("id", id).single();
      if (fresh?.claimed_by !== member.id) {
        return json({ error: "认领冲突: 已被他人抢先" }, 409);
      }
      // 自己先前请求已认领 → 落到下方正常起草
    }
  }

  // 场景与品牌信息
  const [{ data: scene }, { data: brandCfg }, { data: rulesCfg }] = await Promise.all([
    post.demand_id
      ? client.from("demand_scenes").select("*").eq("id", post.demand_id).single()
      : Promise.resolve({ data: null }),
    client.from("app_config").select("value").eq("key", "brand").single(),
    client.from("app_config").select("value").eq("key", "brand_rules").single(),
  ]);
  const brand = (brandCfg?.value ?? {}) as { name_cn: string; name_en: string; site: string };
  const rules = (rulesCfg?.value ?? { must: [], warn: [] }) as { must: never[]; warn: never[] };

  // C6: 同场景 TOP3 模板注入 (P0: 有表就用, 无则跳过)
  const { data: templates } = await client.from("reply_templates")
    .select("content").eq("demand_id", post.demand_id).eq("market", post.market)
    .eq("status", "active").order("avg_outcome", { ascending: false }).limit(3);
  const tpl = (templates ?? []).map((t) => t.content);

  const lang = replyLang(post.market, post.lang);
  const system = draftSystemPrompt(
    brand.name_cn ?? "沉浸式翻译", brand.name_en ?? "Immersive Translate", LANG_NAME[lang],
    scene?.feature ?? "双语对照翻译", scene?.capability ?? ["双语对照翻译"], brand.site ?? "https://immersivetranslate.com/",
    post.platform,
  );
  const user = draftUserPrompt({
    platform: post.platform,
    sceneLabel: scene ? `${scene.id} ${scene.name}` : "未归类",
    summary: post.summary ?? "",
    postText: `${post.title ?? ""}\n${post.content ?? ""}`.slice(0, 1500),
    templates: tpl.length ? tpl : undefined,
    userRequirement: requirement?.slice(0, 300),
  });

  // 起草 (高质量模型)
  let draft = "", draftCn = "", suitableNote = "";
  try {
    const result = await deepSeekJson<{ suitable: boolean; reason: string; reply: string; translation_cn?: string }>(system, user, false);
    if (!result.suitable) {
      suitableNote = result.reason ?? "AI 判断不适合回复";
    } else {
      draft = (result.reply ?? "").slice(0, 4000);
      draftCn = (result.translation_cn ?? "").slice(0, 4000);
    }
  } catch (e) {
    return json({ error: `AI 起草失败: ${(e as Error).message}` }, 502);
  }

  const issues = draft ? brandCheck(draft, rules, brand.site ?? "https://immersivetranslate.com/")
    : ([{ level: "must", rule: "ai_unsuitable", label: `AI 判断不适合回复——${suitableNote}。如确认要回复，请手动撰写，或直接跳过这条。` }] as never[]);

  const { data: updated } = await client.from("demand_posts").update({
    reply_draft: draft, reply_draft_cn: draftCn || null, draft_at: new Date().toISOString(),
    brand_issues: issues, suitable_note: suitableNote || null,
    // 重新起草清空母语审核 (v2 规则)
    ja_reviewed_by: null, ja_reviewed_at: null,
  }).eq("id", id).select("*").single();

  return json({ post: updated });
});
