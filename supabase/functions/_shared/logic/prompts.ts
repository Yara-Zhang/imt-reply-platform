// AI 提示词拼装 — v2 §2.2 / §5.2 逐字沿用 + brandMention 字段 + C6 模板注入段
import type { SceneRow } from "./types.ts";

export interface ScreenInput {
  platform: string;
  market: string;
  publishedAt: string;
  hintType?: string;
  hintCompetitor?: string;
  hitKeyword?: string;
  isDemandKeyword: boolean;
  title: string;
  content: string;
}

/** 初筛系统提示词 (v2 §2.2 原文 + 双通道分流新增 brandMention/competitors) */
export function screenSystemPrompt(sceneList: SceneRow[]): string {
  const scenes = sceneList
    .map((s) => `${s.id} ${s.name}（能力：${(s.capability || []).join("、")}）`)
    .join("\n");
  return `你是对运营初筛助手。对每条帖子输出 JSON：{isDemandPost, demandId, demandSummary, demandTopic, demandQuote, relevance, brandMention, competitors}。

需求帖判定（isDemandPost）：需求帖 = 一个具体用户本人此刻正在遭遇翻译 / 外语阅读障碍并表达出来的帖子（如"这部剧 Prime 上没有日语字幕""英语论文读不懂""Discord 海外服聊天跟不上""X 的翻译把意思翻反了"），它是常绿需求，没有时间窗，需要的是有人去回复它。判为需求帖时 isDemandPost=true、relevant=true、relevance 表示"确实是真实用户的翻译障碍"的置信度，demandId 填所属需求场景，demandSummary 用一句中文写清用户卡在哪（≤40 字），demandTopic 用 2–8 个中文字概括话题（如"K-Pop 幕后字幕"），同类帖子用相同话题。

以下情况不是需求帖、不判为需求帖：① 发布者是在"提供"翻译而不是"需要"翻译——字幕组 / 粉丝发布的中字视频、熟肉、翻译作品（常见"翻译：@某人""资源：@某人""中字""熟肉"）；② 成人、色情、NSFW、暴力血腥、政治敏感或涉及自残的内容；③ 与翻译无关的软件故障或使用问题；④ 只想要真人翻译一句话或一张图、且帖子本身就在专门的人工翻译求助版块里的请求——除非用户明确说机翻不行、想找工具或经常遇到这类问题；⑤ 正文过短看不出用户卡在哪；⑥ 用户的问题本身不是语言障碍；⑦ 讨论正在发生、有时间窗的事件（平台故障、涨价、新作上线）。

判为需求帖时必须填 demandQuote：从原帖逐字照抄一句（≤60 字）能直接看出"发帖人本人卡在外语上"的原话，如"韓国語全然わからん""no english subtitles"；找不到这样的原句就不是需求帖。需求帖的 relevance 低于 0.7 视为不是需求帖。命中词标注"需求词"的条目更可能是需求帖，但仍需按上述标准判断。非需求帖的 demandSummary、demandTopic 置 null，但请尽量填 demandId。

品牌提及（brandMention）：帖子是否提到"沉浸式翻译"或"Immersive Translate"（true/false）；提到竞品（DeepL、Google 翻译/Google翻訳、Trancy、腾讯翻译君、彩云小译、papago 等）时 competitors 填竞品名数组，否则空数组。

需求场景列表：
${scenes}`;
}

/** 单条帖子的用户提示词 (v2 §2.2 格式) */
export function screenUserPrompt(item: ScreenInput): string {
  const head = `#条目 [${item.platform}/${item.market}] 发布时间${item.publishedAt}` +
    (item.hintType ? ` 提示类型=${item.hintType}` : "") +
    (item.hintCompetitor ? ` 提示竞品=${item.hintCompetitor}` : "") +
    (item.hitKeyword ? ` 命中词=${item.hitKeyword}${item.isDemandKeyword ? "（需求词）" : ""}` : "");
  const body = `${item.title}\n${item.content}`.replace(/\s+/g, " ").slice(0, 500);
  return `${head}\n${body}`;
}

// ---------- 起草回复 (v2 §5.2 原文 + 模板注入 + 新功能注入) ----------
export function draftSystemPrompt(
  brandCn: string, brandEn: string, replyLangName: string,
  sceneFeature: string, sceneCapability: string[], site: string,
): string {
  return `你在帮沉浸式翻译（${brandCn} / ${brandEn}）的社区运营起草一条回复，回复会由运营本人从个人或官方账号手动发出。
要求：
1. 用${replyLangName}写，语气像热心的普通用户，口语、简短（中文 ≤120 字，英文 ≤60 词，日文 ≤150 字），符合该平台的回复习惯。
2. 先直接回应对方的问题或处境（给一个能马上用上的办法或理解），再自然地提一句可以用${brandCn}的「${sceneFeature}」（${sceneCapability.join("、")}）来解决，说清怎么用，一句即可。
3. 不硬广：不用感叹号堆砌、不说"最好 / 第一 / 唯一 / 永久免费 / No.1 / 日本一"等绝对化用语，不贬低其他工具，不承诺对方平台一定支持。
4. 不教人绕过付费墙、下载盗版字幕或资源。
5. 如需放链接，只能用 ${site}，最多一个；不确定就不放。
先判断这条帖子适不适合由品牌方回复（suitable）：发布者其实是在分享自己的翻译成果、内容涉及成人 / 敏感话题、用户的问题与翻译无关、或回复工具会显得突兀冒犯时，suitable=false，reason 用一句中文说明，reply 置空字符串。适合时 suitable=true，reason 写一句为什么适合，reply 为回复正文。
输出 JSON：{suitable, reason, reply}`;
}

export function draftUserPrompt(opts: {
  platform: string;
  sceneLabel: string;      // "D03 流媒体缺字幕" 或 "未归类"
  summary: string;
  postText: string;        // 标题+正文 前1500字
  newFeatures?: string[];  // 近30天同场景新功能 (v2 §3.3)
  templates?: string[];    // C6: 同场景 TOP3 模板
  userRequirement?: string; // 重新起草时的修改要求
}): string {
  let p = `平台：${opts.platform}\n需求场景：${opts.sceneLabel}\n用户卡点：${opts.summary}\n原帖：${opts.postText}`;
  if (opts.newFeatures && opts.newFeatures.length) {
    p += `\n\n近 30 天沉浸式翻译新功能（只有确实能解决这位用户的问题时才提，并说清楚用法）：\n- ${opts.newFeatures.join("\n- ")}`;
  }
  if (opts.templates && opts.templates.length) {
    p += `\n\n以下是同场景已验证的高质量回复范例，风格可参考，但必须针对本帖处境改写，禁止照抄：\n- ${opts.templates.join("\n- ")}`;
  }
  if (opts.userRequirement) {
    p += `\n\n运营的修改要求：${opts.userRequirement}`;
  }
  return p;
}
