<script setup>
import { ref, onMounted } from "vue";
import { api, MOCK } from "../lib/api.js";

const scenes = ref([]);
const editing = ref(null);
const form = ref({ id: "", name: "", definition: "", feature: "" });
const templates = ref([]);
const tplOpen = ref(false);

const CAPS = ["视频双语字幕", "字幕文件翻译", "双语字幕", "网页对照", "PDF 保版式翻译", "对照阅读", "EPUB 翻译", "图片翻译", "PDF 翻译", "漫画翻译", "输入框翻译", "X 定制适配", "原文译文并排核对", "会议翻译", "文档翻译"];

function copied() { toast("已复制"); }

onMounted(async () => {
  if (MOCK) {
    scenes.value = [
      { id: "D01", name: "外语视频追更", definition: "想看的外语视频没有母语字幕", capability: ["视频双语字幕"], feature: "视频双语字幕", status: "active", posts_30d: 42, replied_rate: 0.31 },
      { id: "D03", name: "流媒体平台缺字幕", definition: "Prime / Netflix 等片源缺母语字幕", capability: ["视频双语字幕", "字幕文件翻译"], feature: "流媒体双语字幕", status: "active", posts_30d: 28, replied_rate: 0.25 },
      { id: "D05", name: "论文与学术 PDF 精读", definition: "读英文论文吃力", capability: ["PDF 保版式翻译", "对照阅读"], feature: "PDF 对照翻译", status: "active", posts_30d: 67, replied_rate: 0.18 },
      { id: "D09", name: "漫画与 Webtoon", definition: "条漫、漫画原版阅读排版被破坏", capability: ["漫画翻译"], feature: "漫画翻译", status: "active", posts_30d: 19, replied_rate: 0.42 },
    ];
    templates.value = [
      { id: "t1", demand_id: "D05", market: "cn", platform: "xiaohongshu", content: "同款经历…读文献的时候直接用沉浸式翻译的 PDF 对照翻译，原版式保留公式不乱，比逐段复制省太多事了", usage_count: 3 },
      { id: "t2", demand_id: "D09", market: "jp", platform: "x", content: "webtoon 全ページ翻訳はレイアウト崩れるので、沉浸式翻译の漫画翻訳モード使ってます。コマ割りそのまま出るので地味に救われてる", usage_count: 1 },
    ];
  } else {
    const j = await api("/scenes/list", { method: "GET" });
    scenes.value = j.scenes ?? [];
    const t = await api("/posts/templates", { method: "GET" });
    templates.value = t.templates ?? [];
  }
});

async function save() {
  if (MOCK) { editing.value = null; return; }
  await api(editing.value ? "/scenes/update" : "/scenes/create", { method: "POST", body: { ...form.value } });
  const j = await api("/scenes/list", { method: "GET" });
  scenes.value = j.scenes ?? [];
  editing.value = null;
}

function copyTpl(content) {
  navigator.clipboard?.writeText(content).catch(() => {});
  copied();
}
function toast(msg) { const el = document.querySelector(".toast"); if (el) { el.textContent = msg; el.style.display = "block"; setTimeout(() => (el.style.display = "none"), 1800); } }
const tplCount = (did) => templates.value.filter((t) => t.demand_id === did).length;
</script>

<template>
  <div class="nav">
    <span class="logo">社区回复平台</span>
    <router-link to="/">需求回复</router-link><router-link to="/report">周报</router-link><router-link to="/scenes" class="on">场景地图</router-link><router-link to="/settings">设置</router-link>
  </div>
  <div class="main" style="flex-direction:column">
    <div class="card" v-for="s in scenes" :key="s.id" style="cursor:default">
      <div class="meta">
        <span class="mkt" style="background:var(--brand-light);color:var(--brand)">{{ s.id }}</span>
        <span class="state" :class="s.status === 'active' ? 'st-done' : 'st-review'">{{ s.status === "active" ? "生效中" : "候选" }}</span>
        <span class="eng">近 30 天 {{ s.posts_30d }} 条 · 回复率 {{ Math.round((s.replied_rate ?? 0) * 100) }}%</span>
        <span v-if="tplCount(s.id)" class="chip topic" style="cursor:pointer">模板 {{ tplCount(s.id) }}</span>
      </div>
      <div class="sum">{{ s.name }}</div>
      <div class="prev">{{ s.definition }}</div>
      <div class="chips"><span v-for="c in s.capability" :key="c" class="chip cap">{{ c }}</span><span class="chip">点名功能：{{ s.feature }}</span></div>
      <div v-for="t in templates.filter((x) => x.demand_id === s.id)" :key="t.id" class="tpline" @click="copyTpl(t.content)" title="点击复制">
        <span class="chip">{{ t.market }} · {{ t.platform }}</span>
        <span class="tpcontent">{{ t.content }}</span>
        <span class="tpuse">已用 {{ t.usage_count ?? 0 }} 次</span>
      </div>
    </div>
    <p class="hint" style="text-align:center;color:var(--ink-3);font-size:12px;padding:20px">
      场景是需求骨架（D01-D14），初筛按它归类、起草按它点名功能；候选场景由周任务从"未归类"帖子聚类提议，在此确认后生效。<br />
      话术模板：在需求页把已回复帖「存为模板」后出现在这里，起草同场景新帖时 AI 自动参考最优的 3 条（点击模板行可复制）。
    </p>
  </div>
  <div class="toast" style="display:none;position:fixed;bottom:26px;left:50%;transform:translateX(-50%)"></div>
</template>
