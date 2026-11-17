<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../stores/auth.js";
import { api, MOCK } from "../lib/api.js";

const router = useRouter();
const auth = useAuth();

const posts = ref([]);
const stats = reactive({ open: 0, today_new: 0, mine: 0, review: 0, today_replied: 0, week_replied: 0 });
const health = ref(null);
const F = reactive({ mkt: "all", tab: "open", plat: "全部", scene: "全部", q: "", sort: "score", days: 3 });
const selId = ref(null);
const draft = ref("");
const toast = reactive({ show: false, msg: "", err: false });
const skipModal = ref(false);
const kbdModal = ref(false);
const showGuide = ref(!localStorage.getItem("imt_guide_done"));
const guideStep = ref(0);
const staleOpen = ref(false);

// 建联卡片状态 (spec C2: 点徽章 → 右侧栏切换)
const outreach = ref(null); // 建联卡数据; null = 显示帖子详情
const outreachLoading = ref(false);

async function openOutreach(p) {
  if (!p.kol_tier || p.kol_tier === "none" || !p.author_id) return;
  outreachLoading.value = true; outreach.value = null;
  try {
    const j = await api(`/posts/outreach?author=${encodeURIComponent(p.platform + ":" + p.author_id)}`, { method: "GET" });
    outreach.value = j;
  } catch (e) { t(e.message, true); }
  finally { outreachLoading.value = false; }
}
function closeOutreach() { outreach.value = null; }
function copyEmail() {
  if (outreach.value?.author?.email) {
    navigator.clipboard?.writeText(outreach.value.author.email).catch(() => {});
    t("邮箱已复制");
  }
}
const platNameOf = (p) => ({ weibo: "微博", xiaohongshu: "小红书", douyin: "抖音", zhihu: "知乎", bilibili: "B站", reddit: "Reddit", x: "X", youtube: "YouTube", hatena: "はてな", niconico: "niconico" }[p] ?? p);

const MKT_STYLE = {
  cn: ["var(--cn-bg)", "var(--cn)"], en: ["var(--en-bg)", "var(--en)"],
  jp: ["var(--jp-bg)", "var(--jp)"], kr: ["var(--kr-bg)", "var(--kr)"],
};
const MKT_LABEL = { cn: "CN", en: "EN", jp: "JP", kr: "KR" };

function t(msg, err = false) {
  toast.msg = msg; toast.err = err; toast.show = true;
  clearTimeout(toast._tm); toast._tm = setTimeout(() => (toast.show = false), 2600);
}

async function load() {
  try {
    const [list, st, h] = await Promise.all([
      api(`/posts/list`, { method: "GET" }),
      api(`/stats`, { method: "GET" }),
      api(`/health`, { method: "GET" }),
    ]);
    posts.value = list.posts ?? [];
    Object.assign(stats, st);
    health.value = h;
    if (list.posts?.length && !selId.value) selId.value = list.posts[0].id;
    const sel = posts.value.find((p) => p.id === selId.value);
    if (sel) draft.value = sel.reply_draft ?? "";
  } catch (e) { t(e.message, true); }
}

// ---------- 筛选引擎 (原型已验证逻辑) ----------
const HRS = (p) => (Date.now() - new Date(p.published_at).getTime()) / 3600000;
function scoreOf(p) {
  const e = p.metrics_json?.likes ?? 0, c = p.metrics_json?.comments ?? 0;
  const eng = Math.min(40, Math.round(Math.log10(e + c + 1) * 20));
  const h = HRS(p);
  const t2 = h < 12 ? 30 : h < 24 ? 25 : h < 48 ? 15 : h < 72 ? 8 : 0;
  return (p.priority_score ?? eng + t2);
}
const filtered = computed(() => {
  let arr = posts.value.filter((p) => {
    if (F.mkt !== "all" && p.market !== F.mkt) return false;
    if (F.plat !== "全部" && p.platform !== F.plat) return false;
    if (F.scene !== "全部" && (p.demand_id ?? "none") !== F.scene) return false;
    if (F.q && !`${p.summary}${p.content}${p.quote}`.toLowerCase().includes(F.q.toLowerCase())) return false;
    if (F.tab === "open") return p.state === "open";
    if (F.tab === "claimed") return p.state === "claimed";
    if (F.tab === "review") return p.state === "claimed" && p.reply_draft && !p.ja_reviewed_at && ["jp", "kr"].includes(p.market);
    if (F.tab === "replied") return p.state === "replied";
    if (F.tab === "skipped") return p.state === "skipped";
    return true;
  });
  if (F.sort === "time") arr = [...arr].sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  else if (F.sort === "eng") arr = [...arr].sort((a, b) => ((b.metrics_json?.likes ?? 0) + (b.metrics_json?.comments ?? 0)) - ((a.metrics_json?.likes ?? 0) + (a.metrics_json?.comments ?? 0)));
  else arr = [...arr].sort((a, b) => scoreOf(b) - scoreOf(a));
  return arr;
});
const live = computed(() => filtered.value.filter((p) => !p.stale));
const staled = computed(() => filtered.value.filter((p) => p.stale));
const visible = computed(() => (staleOpen.value ? [...live.value, ...staled.value] : live.value));
const sel = computed(() => posts.value.find((p) => p.id === selId.value));

function stateBadge(p) {
  if (p.state === "replied") return { cls: "st-done", txt: "已回复" };
  if (p.state === "skipped") return { cls: "st-skip", txt: "已跳过" };
  if (p.state === "claimed") {
    const review = p.reply_draft && !p.ja_reviewed_at && ["jp", "kr"].includes(p.market);
    return review
      ? { cls: "st-review", txt: "待母语审核" }
      : { cls: "st-claimed", txt: "处理中" + (p.claimed_by_name ? ` · ${p.claimed_by_name}` : "") };
  }
  return { cls: "st-open", txt: "待处理" };
}
function fdot(p) {
  const h = HRS(p);
  return p.stale ? "#888" : h < 12 ? "#3B6D11" : h < 48 ? "#BA7517" : h < 72 ? "#D85A30" : "#888";
}
function ageTxt(p) {
  const h = HRS(p);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 24) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function mustIssues(p) { return (p.brand_issues ?? []).filter((i) => i.level === "must"); }

// ---------- 动作 ----------
function select(p) { selId.value = p.id; draft.value = p.reply_draft ?? ""; outreach.value = null; }

async function act(path, body, okMsg) {
  try {
    const j = await api(`/posts/${path}`, { method: "POST", body: { id: selId.value, ...body } });
    const i = posts.value.findIndex((p) => p.id === selId.value);
    if (i >= 0) posts.value[i] = { ...posts.value[i], ...j.post };
    if (okMsg) t(okMsg);
    return true;
  } catch (e) { t(e.message, true); return false; }
}

async function claimDraft() {
  try {
    const j = await api("/reply", { method: "POST", body: { id: selId.value } });
    const i = posts.value.findIndex((p) => p.id === selId.value);
    if (i >= 0) posts.value[i] = { ...posts.value[i], ...j.post };
    draft.value = j.post.reply_draft ?? "";
    t("已认领并生成 AI 草稿——直接在右侧改稿去掉 AI 腔");
    nextTickFocus();
  } catch (e) { t(e.message, true); }
}
async function saveDraft() {
  const p = sel.value;
  await act("draft", { draft: draft.value }, "草稿已保存，品牌检查已更新");
}
async function markReplied() {
  const p = sel.value;
  const must = mustIssues(p);
  if (must.length) return t(`草稿有必须修改的问题：${must.map((m) => m.label || m.rule).join("、")}。改完才能标记已回复。`, true);
  const ok = await act("replied", {}, "");
  if (ok) t("已标记回复。系统将在 +24h/72h/7d 三轮追踪回复效果");
}
async function doReview(approve) {
  const ok = await act("review", { approve }, approve ? "母语审核通过" : "已驳回");
  if (approve && ok) t("审核通过。现在可以标记已回复了");
}
async function skipConfirm() {
  const reason = document.querySelector("input[name=skr]:checked")?.value ?? "其他";
  skipModal.value = false;
  await act("skip", { reason }, `已跳过（${reason}）`);
}
async function release() {
  await act("release", {}, "已释放回待处理池");
}
function copyDraft() {
  navigator.clipboard?.writeText(draft.value).catch(() => {});
  window.open(sel.value?.url, "_blank");
  t("草稿已复制，原帖已在新标签打开——粘贴发布后回来按 R 标记已回复");
}
function nextTickFocus() { setTimeout(() => document.querySelector("textarea.draft")?.focus(), 50); }

// 模板表达式中不可直接用 localStorage/window (Vue 全局白名单限制), 经此中转
function gdDone() { localStorage.setItem("imt_guide_done", "1"); showGuide.value = false; }
function gdNext() { if (guideStep.value < 2) guideStep.value++; else gdDone(); }
function openOriginal() { window.open(sel.value?.url, "_blank"); }

// ---------- 键盘流 ----------
function onKey(e) {
  if (e.metaKey && e.key === "c") { copyDraft(); return; }
  const tag = document.activeElement?.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return;
  const idx = visible.value.findIndex((p) => p.id === selId.value);
  const k = e.key.toLowerCase();
  if (k === "j") { e.preventDefault(); const n = visible.value[Math.min(idx + 1, visible.value.length - 1)]; if (n) select(n); }
  else if (k === "k") { e.preventDefault(); const n = visible.value[Math.max(idx - 1, 0)]; if (n) select(n); }
  else if (e.key === "Enter" || k === "c") { e.preventDefault(); claimDraft(); }
  else if (k === "r") { e.preventDefault(); markReplied(); }
  else if (k === "s") { e.preventDefault(); skipModal.value = true; }
  else if (k === "a") { e.preventDefault(); doReview(true); }
  else if (k === "x") { e.preventDefault(); doReview(false); }
  else if (k === "o") { window.open(sel.value?.url, "_blank"); }
  else if (e.key === "?") kbdModal.value = true;
  else if (e.key === "Escape") { kbdModal.value = false; skipModal.value = false; }
}

// ---------- 统计带点击即筛选 ----------
const TABS = [["open", "待处理"], ["mine", "我认领的"], ["claimed", "处理中"], ["review", "待我审核"], ["replied", "已回复"], ["skipped", "已跳过"], ["all", "全部"]];
const statTab = { open: "open", new: "all", mine: "mine", review: "review", replied: "replied", week: "replied" };
function statClick(f) { F.tab = statTab[f] ?? "all"; }
const SCENES = ["全部", "D01", "D02", "D03", "D05", "D07", "D09", "D12", "none"];
const PLATS = ["全部", "weibo", "xiaohongshu", "douyin", "zhihu", "bilibili", "reddit", "x", "youtube", "hatena", "niconico"];
const PLAT_LABEL = { 全部: "平台：全部", weibo: "微博", xiaohongshu: "小红书", douyin: "抖音", zhihu: "知乎", bilibili: "B站", reddit: "Reddit", x: "X", youtube: "YouTube", hatena: "はてな", niconico: "niconico" };

onMounted(() => { load(); document.addEventListener("keydown", onKey); });
onBeforeUnmount(() => document.removeEventListener("keydown", onKey));
</script>

<template>
  <!-- 首次引导 (3 步) -->
  <div v-if="showGuide" class="guide" @click.self="showGuide = false">
    <div class="gd-mask"></div>
    <div class="gd-card" :style="[{ top: '120px', left: '50%', transform: 'translateX(-50%)' }, { top: '340px', left: '24px', transform: 'none' }, { top: '560px', right: '24px', left: 'auto', transform: 'none' }][guideStep]">
      <h5>{{ ["① 扫一眼待处理队列", "② 认领并起草", "③ 复制 → 原帖回复 → 标记已回复"][guideStep] }}</h5>
      <p>{{
        [
          "每张卡片标题是 AI 写的中文摘要，引用块是用户卡点原话——扫一眼判断值不值得回。点顶部数字可直接筛选。",
          "点卡片或按 Enter：自动认领（别人不能抢）、生成回复草稿、跑品牌检查——你只需在右侧改稿去掉 AI 腔。",
          "点「复制并去原帖」，到原帖手动粘贴发布（平台永不自动发帖），回来按 R 标记已回复。日韩帖多一步母语审核。新手全程鼠标就够用。",
        ][guideStep]
      }}</p>
      <div class="gd-step">
        <span class="n">{{ guideStep + 1 }} / 3</span>
        <button class="gn" @click="gdNext">
          {{ guideStep < 2 ? "下一步" : "开始使用" }}
        </button>
        <button class="gs" @click="gdDone">跳过引导</button>
      </div>
    </div>
  </div>

  <div class="nav">
    <span class="logo">社区回复平台</span>
    <router-link to="/" class="on">需求回复</router-link>
    <router-link to="/report">周报</router-link>
    <router-link to="/scenes">场景地图</router-link>
    <router-link to="/settings">设置</router-link>
    <a href="#" @click.prevent="t('品牌口碑 / 洞察分析等页面按路线图在后续版本上线')">品牌口碑</a>
    <a href="#" @click.prevent="t('品牌口碑 / 洞察分析等页面按路线图在后续版本上线')">洞察分析</a>
    <span class="me">{{ auth.member?.name }} · {{ auth.member?.role }}<template v-if="MOCK">（演示模式）</template>
      <a href="#" style="margin-left:10px" @click.prevent="auth.logout(); router.push('/login')">退出</a>
    </span>
  </div>

  <div class="stats">
    <button class="stat hot" :class="{ active: F.tab === 'open' }" @click="statClick('open')"><b>{{ stats.open }}</b>待处理</button>
    <button class="stat" @click="statClick('new')"><b>{{ stats.today_new }}</b>今日新增</button>
    <button class="stat" :class="{ active: F.tab === 'mine' }" @click="statClick('mine')"><b>{{ stats.mine }}</b>我在手中</button>
    <button class="stat" :class="{ active: F.tab === 'review' }" @click="statClick('review')"><b>{{ stats.review }}</b>待我审核</button>
    <button class="stat" :class="{ active: F.tab === 'replied' }" @click="statClick('replied')"><b>{{ stats.today_replied }}</b>今日已回复</button>
    <button class="stat" @click="statClick('week')"><b>{{ stats.week_replied }}</b>本周我回复</button>
    <span class="health" v-if="health">
      <span>最近一轮 <b>{{ health.last_round_at ? new Date(health.last_round_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—" }}</b></span>
      <span>今日抓 <b>{{ health.today_fetched }}</b> / 入库 <b>{{ health.today_demand }}</b></span>
      <span :class="{ err: health.today_failed }">失败 <b>{{ health.today_failed }}</b></span>
      <span>TikHub <b>${{ (health.spend?.[0]?.cost ?? 0).toFixed?.(2) ?? health.spend?.[0]?.cost ?? 0 }}</b></span>
    </span>
  </div>

  <div class="filters">
    <div class="tabs">
      <button v-for="[v, label] in TABS" :key="v" class="tab" :class="{ on: F.tab === v }" @click="F.tab = v">{{ label }}</button>
    </div>
    <div class="fsep"></div>
    <button class="pill" :class="{ on: F.mkt === 'all' }" @click="F.mkt = 'all'">全部</button>
    <button v-for="m in ['cn', 'en', 'jp', 'kr']" :key="m" class="pill" :class="{ on: F.mkt === m }" @click="F.mkt = m">
      <span :style="{ color: MKT_STYLE[m][1] }">{{ { cn: "中文", en: "英文", jp: "日本", kr: "韩国" }[m] }}</span>
    </button>
    <div class="fsep"></div>
    <select v-model="F.scene"><option v-for="s in SCENES" :key="s" :value="s">{{ s === "全部" ? "场景：全部" : s === "none" ? "未归类" : s }}</option></select>
    <select v-model="F.plat"><option v-for="p in PLATS" :key="p" :value="p">{{ PLAT_LABEL[p] }}</option></select>
    <select v-model="F.days"><option :value="3">近 72 小时</option><option :value="1">近 24 小时</option><option :value="7">近 7 天</option><option :value="14">近 14 天</option><option :value="90">近 90 天</option></select>
    <input v-model="F.q" class="search" placeholder="搜索…" />
    <div class="sort">排序：
      <button :class="{ on: F.sort === 'score' }" @click="F.sort = 'score'">优先级</button>
      <button :class="{ on: F.sort === 'time' }" @click="F.sort = 'time'">发布时间</button>
      <button :class="{ on: F.sort === 'eng' }" @click="F.sort = 'eng'">互动数</button>
    </div>
  </div>

  <div class="main">
    <div class="left">
      <div v-if="!live.length && !staled.length" style="background: var(--panel); border: 1px dashed var(--line-2); border-radius: 12px; padding: 28px; text-align: center; color: var(--ink-3); font-size: 13px">
        当前筛选无帖子。管道扫描中：最近一轮 {{ health?.last_round_at ? new Date(health.last_round_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "—" }}，今日已抓 {{ health?.today_fetched ?? 0 }} 条。<br />试试切换市场或场景，或点「全部」重置。
      </div>

      <div v-for="p in live" :key="p.id" class="card" :class="{ sel: p.id === selId }" @click="select(p)">
        <div class="meta">
          <span class="mkt" :style="{ background: MKT_STYLE[p.market][0], color: MKT_STYLE[p.market][1] }">{{ MKT_LABEL[p.market] }}</span>
          <span class="plat">{{ { weibo: "微博", xiaohongshu: "小红书", douyin: "抖音", zhihu: "知乎", bilibili: "B站", reddit: "Reddit", x: "X", youtube: "YouTube", hatena: "はてな", niconico: "niconico" }[p.platform] ?? p.platform }}</span>
          <span class="fdot" :style="{ background: fdot(p) }"></span><span class="age">{{ ageTxt(p) }}</span>
          <span class="eng">赞 {{ p.metrics_json?.likes ?? 0 }} · 评 {{ p.metrics_json?.comments ?? 0 }}</span>
          <span v-if="p.kol_tier === 'kol'" class="kol" style="cursor:pointer" title="点击查看建联卡片" @click.stop="select(p); openOutreach(p)">KOL</span>
          <span v-else-if="p.kol_tier === 'koc'" class="kol koc" style="cursor:pointer" title="点击查看建联卡片" @click.stop="select(p); openOutreach(p)">KOC</span>
          <span class="state" :class="stateBadge(p).cls">{{ stateBadge(p).txt }}</span>
        </div>
        <div class="sum">{{ p.summary || p.title }}</div>
        <div class="quote" :class="{ unv: !p.quote_verified }">"{{ p.quote }}"<span class="vq">{{ p.quote_verified ? "✓ 已核验" : "引句未核验" }}</span></div>
        <div class="prev">{{ p.content }}</div>
        <div class="chips">
          <span v-if="p.demand_id" class="chip">{{ p.demand_id }}</span>
          <span class="chip topic" v-if="p.topic">{{ p.topic }}</span>
          <span class="chip rel" v-if="p.state === 'replied'">已回复</span>
        </div>
      </div>

      <div v-if="staled.length" class="stalehead" @click="staleOpen = !staleOpen">
        {{ staleOpen ? "▾" : "▸" }} 已冷却 {{ staled.length }} 条（发布超过 72h，回复价值低）
      </div>
      <div class="stalebox" :class="{ open: staleOpen }">
        <div v-for="p in staled" :key="p.id" class="card staled" :class="{ sel: p.id === selId }" @click="select(p)">
          <div class="meta"><span class="mkt" :style="{ background: MKT_STYLE[p.market][0], color: MKT_STYLE[p.market][1] }">{{ MKT_LABEL[p.market] }}</span><span class="plat">{{ p.platform }}</span><span class="age">{{ ageTxt(p) }}</span><span class="state" :class="stateBadge(p).cls">{{ stateBadge(p).txt }}</span></div>
          <div class="sum">{{ p.summary || p.title }}</div>
        </div>
      </div>
    </div>

    <div class="right" v-if="sel && outreach">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h4 style="margin:0">建联卡片 · {{ outreach.author.tier === "kol" ? "KOL" : "KOC" }}</h4>
        <button class="btn" style="padding:4px 10px" @click="closeOutreach">← 返回帖子</button>
      </div>
      <h4>建联依据</h4>
      <div class="verdict">
        <b>{{ outreach.author.name || "（未留名）" }}</b> · {{ platNameOf(outreach.author.platform) }}<br />
        粉丝 <b>{{ outreach.author.followers?.toLocaleString?.() ?? "未知" }}</b> ·
        真实度 <b :style="{ color: (outreach.author.auth_score ?? 0) >= 60 ? 'var(--ok)' : 'var(--bad)' }">{{ outreach.author.auth_score ?? "—" }}/100</b>
        <template v-if="outreach.author.auth_signals">
          · 互动率 {{ (outreach.author.auth_signals.er * 100).toFixed(1) }}% ·
          评论/赞比 {{ (outreach.author.auth_signals.comment_ratio * 100).toFixed(1) }}%
        </template><br />
        被我们抓到 <b>{{ outreach.author.total_hits ?? 1 }}</b> 次 · 场均互动 <b>{{ Math.round(outreach.author.avg_engagement ?? 0) }}</b>
      </div>
      <div class="bcheck bad" v-if="outreach.author.auth_signals?.suspect_boosted" style="margin-top:8px">
        <span class="bk">⚠ 疑似投流/单帖爆款</span>（本帖互动约为其历史均值的 {{ outreach.author.auth_signals.vs_avg }} 倍）——报价谈判时注意辨别自然互动量
      </div>
      <div class="bcheck bad" v-if="outreach.author.auth_signals?.bought_followers || outreach.author.auth_signals?.bought_likes" style="margin-top:8px">
        <span class="bk">⚠ 互动真实性存疑</span>（{{ outreach.author.auth_signals?.bought_followers ? "疑似买粉" : "疑似刷赞" }}信号）——已降级处理, 谨慎建联
      </div>
      <h4>近期主题</h4>
      <div class="chips" style="margin:0 0 4px">
        <span v-if="!outreach.topics.length" class="chip">（该作者帖子尚少, 暂无话题聚合）</span>
        <span v-for="tp in outreach.topics" :key="tp" class="chip topic">{{ tp }}</span>
      </div>
      <h4>联系方向建议</h4>
      <div class="orig">{{ outreach.direction || "—" }}</div>
      <h4>联系方式</h4>
      <div v-if="outreach.author.email" class="bcheck ok" style="display:flex;align-items:center;gap:10px;justify-content:space-between">
        <div><span class="bk">{{ outreach.author.email }}</span><br /><span style="font-size:11px">来自其 {{ platNameOf(outreach.author.platform) }} 公开简介</span></div>
        <button class="btn" @click="copyEmail">复制</button>
      </div>
      <div v-else class="bcheck warn">
        <span class="bk">公开简介中未抓到邮箱</span>，建议同事按三步找：<br />
        ① 看其 {{ platNameOf(outreach.author.platform) }} / Instagram 简介与 Linktree，找"商务/合作/business"字样<br />
        ② 没有就走平台私信，说明来意（比冷邮件回复率更高）<br />
        ③ 建联前登记到飞书达人表，避免同事重复联系
      </div>
    </div>

    <div class="right" v-else-if="sel">
      <h4>原帖全文</h4>
      <div class="orig">{{ sel.content }} <span class="openlink" @click="openOriginal">打开原帖 ↗</span></div>
      <h4>AI 判定</h4>
      <div class="verdict">置信度 {{ sel.confidence ?? "—" }} · 场景 <b>{{ sel.demand_id ?? "未归类" }}</b> · 引句<b>{{ sel.quote_verified ? "已核验" : "未核验" }}</b></div>
      <h4>回复草稿（可改写）</h4>
      <div class="draftwrap">
        <textarea v-model="draft" class="draft" rows="5" :placeholder="sel.suitable_note ? 'AI 判断不适合回复：' + sel.suitable_note + '。如确认要回复请手动撰写。' : '按 Enter 认领并起草，或直接点击左侧卡片上的操作'"></textarea>
        <div class="draftbar"><span>运营 {{ auth.member?.name }} · 保存后自动品牌检查</span><span class="regen" @click="claimDraft()">重新起草</span></div>
      </div>
      <h4>品牌检查</h4>
      <div class="bcheck" :class="mustIssues(sel).length ? 'bad' : (sel.brand_issues?.length ? 'warn' : 'ok')">
        <span class="bk">{{ mustIssues(sel).length ? "必须修改" : (sel.brand_issues?.length ? "通过，有提醒" : "通过") }}：</span>
        <template v-if="sel.brand_issues?.length">
          {{ sel.brand_issues.map((i) => i.label || i.rule + (i.hit_text ? `(${i.hit_text})` : "")).join("；") }}
        </template>
        <template v-else>草稿无品牌风险问题</template>
      </div>
      <div class="acts">
        <button class="btn pri" @click="copyDraft()">复制并去原帖</button>
        <button class="btn" @click="saveDraft()">保存草稿</button>
        <button class="btn" @click="markReplied()">标记已回复</button>
        <button class="btn" v-if="['jp','kr'].includes(sel.market) && sel.state === 'claimed' && sel.reply_draft && !sel.ja_reviewed_at" @click="doReview(true)">审核通过 A</button>
        <button class="btn" @click="skipModal = true">跳过 S</button>
        <button class="btn" v-if="sel.state === 'claimed'" @click="release()">释放</button>
      </div>
      <div class="kbdhint">认领后别人就不能抢这条了 · 发完贴回来按 <b>R</b> 标记已回复 · <b>?</b> 看全部快捷键</div>
    </div>
  </div>

  <div class="kbar">
    <span><b>J / K</b>上下移动</span><span><b>Enter</b>认领并起草</span><span><b>O</b>打开原帖</span>
    <span><b>⌘C</b>复制草稿</span><span><b>R</b>标记已回复</span><span><b>S</b>跳过</span><span><b>?</b>全部快捷键</span>
  </div>

  <div v-if="skipModal" class="overlay"></div>
  <div v-if="skipModal" class="modal">
    <h3>跳过这条帖子（原因必填）</h3>
    <label><input type="radio" name="skr" value="已冷却" checked />已冷却（发布超 72h）</label>
    <label><input type="radio" name="skr" value="重复帖" />重复帖（同话题已回复）</label>
    <label><input type="radio" name="skr" value="不适合回复" />不适合由品牌方回复</label>
    <label><input type="radio" name="skr" value="其他" />其他</label>
    <div style="margin-top:12px;text-align:right">
      <button class="btn pri" @click="skipConfirm">确认跳过</button>
      <button class="btn" @click="skipModal = false">取消</button>
    </div>
  </div>

  <div v-if="kbdModal" class="overlay"></div>
  <div v-if="kbdModal" class="modal">
    <h3>键盘快捷键</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px 26px;font-size:13px">
      <span>J / K — 上下移动</span><span>Enter — 认领并起草</span><span>O — 打开原帖</span>
      <span>⌘C — 复制草稿</span><span>R — 标记已回复</span><span>S — 跳过</span>
      <span>A — 审核通过</span><span>X — 审核驳回</span><span>Esc — 关闭浮层</span>
    </div>
    <div style="margin-top:12px;text-align:right"><button class="btn" @click="kbdModal = false">关闭</button></div>
  </div>

  <div v-if="toast.show" class="toast" :class="{ err: toast.err }">{{ toast.msg }}</div>
</template>
