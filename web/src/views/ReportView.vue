<script setup>
import { ref, onMounted } from "vue";
import { api, MOCK } from "../lib/api.js";

// ---------- 数据 ----------
const WEEKS = [[0, "本周"], [1, "上周"], [2, "前周"]];
const weekOffset = ref(0);
const rep = ref(null);
const loading = ref(false);
const toast = ref("");

const MKT = {
  cn: { label: "中文", fg: "#5B7188", bg: "#E4EAF1" },
  en: { label: "英文", fg: "#7B6E8F", bg: "#EBE8F0" },
  jp: { label: "日本", fg: "#9C6259", bg: "#F3E8E5" },
  kr: { label: "韩国", fg: "#5F7D6C", bg: "#E8EFEA" },
};
const PLAT_LABEL = { weibo: "微博", xiaohongshu: "小红书", douyin: "抖音", zhihu: "知乎", bilibili: "B站", reddit: "Reddit", x: "X", youtube: "YouTube", hatena: "はてな", niconico: "niconico" };
const platName = (p) => PLAT_LABEL[p] ?? p;

async function load() {
  loading.value = true;
  try {
    rep.value = await api(`/posts/report?week_offset=${weekOffset.value}`, { method: "GET" });
  } catch (e) { toast.value = e.message; }
  loading.value = false;
}
function switchWeek(offset) { weekOffset.value = offset; load(); }
onMounted(load);

// ---------- 条形图 ----------
function marketPct(total) {
  const max = Math.max(1, ...(rep.value?.market_rows ?? []).map((r) => r.total));
  return Math.max(3, Math.round((total / max) * 100));
}
function platformPct(total) {
  const max = Math.max(1, ...(rep.value?.platform_rows ?? []).map((r) => r.total));
  return Math.max(3, Math.round((total / max) * 100));
}

// ---------- 下载自包含 HTML 报告 ----------
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function buildHtml(r) {
  const mktRows = r.market_rows.map((m) => {
    const c = MKT[m.market] ?? { label: m.market, fg: "#5A5F6E", bg: "#F0F1F4" };
    const max = Math.max(1, ...r.market_rows.map((x) => x.total));
    const w = Math.max(3, Math.round((m.total / max) * 100));
    return `<tr><td style="padding:5px 0"><span style="background:${c.bg};color:${c.fg};font-size:12px;padding:2px 9px;border-radius:6px;font-weight:500">${c.label}</span></td>
      <td style="padding:5px 8px"><div style="background:${c.bg};height:14px;border-radius:7px;width:${w}%;min-width:4px"></div></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${m.total} 条 · 已回 ${m.replied}</td></tr>`;
  }).join("");
  const platRows = r.platform_rows.map((p) => {
    const max = Math.max(1, ...r.platform_rows.map((x) => x.total));
    const w = Math.max(3, Math.round((p.total / max) * 100));
    return `<tr><td style="padding:4px 0;color:#5A5F6E">${platName(p.platform)}</td>
      <td style="padding:4px 8px"><div style="background:#E4EAF1;height:12px;border-radius:6px;width:${w}%;min-width:4px"></div></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums">${p.total}</td></tr>`;
  }).join("");
  const tops = r.top_posts.map((p, i) => {
    const c = MKT[p.market] ?? { label: p.market, fg: "#5A5F6E", bg: "#F0F1F4" };
    return `<div style="border:1px solid #E5E7EC;border-radius:10px;padding:11px 14px;margin-bottom:9px">
      <div style="font-size:12px;color:#9BA0AD;margin-bottom:5px">
        <span style="background:${c.bg};color:${c.fg};padding:1px 7px;border-radius:5px;font-weight:500">${c.label}</span>
        · ${platName(p.platform)} · 赞 ${p.metrics_json?.likes ?? 0} · 评 ${p.metrics_json?.comments ?? 0} · ${p.state === "replied" ? "已回复" : p.state === "skipped" ? "已跳过" : "未回复"}</div>
      <div style="font-weight:600;font-size:14px;margin-bottom:5px">${i + 1}. ${esc(p.summary)}</div>
      ${p.quote ? `<div style="border-left:3px solid #4D6BFE;background:#EEF1FE;padding:6px 10px;border-radius:0 8px 8px 0;font-size:13px;color:#5A5F6E">“${esc(p.quote)}”${p.quote_verified ? "" : "（引句未核验）"}</div>` : ""}</div>`;
  }).join("");
  const lb = r.leaderboard.map((m, i) =>
    `<tr><td style="padding:4px 0;color:#5A5F6E">${["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`} ${esc(m.name)}</td><td style="text-align:right;font-weight:600">${m.replied} 条</td></tr>`).join("");
  const kols = r.kol_authors.map((k) =>
    `<tr><td style="padding:4px 0"><b>KOL</b> · ${esc(k.name)}</td><td style="color:#5A5F6E">${MKT[k.market]?.label ?? k.market} · ${platName(k.platform)}</td><td style="color:#5A5F6E;font-size:12px">${esc(k.summary)}</td></tr>`).join("");
  const kpi = (v, label) => `<div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:14px 18px;text-align:center"><div style="font-size:26px;font-weight:700;color:#1A1D26">${v}</div><div style="font-size:12px;color:#9BA0AD">${label}</div></div>`;
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>社区回复周报 ${r.week_start} ~ ${r.week_end}</title></head>
<body style="margin:0;font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;background:#F6F7F9;color:#1A1D26;line-height:1.65">
<div style="max-width:860px;margin:0 auto;padding:30px 24px">
  <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:20px">
    <div><div style="font-size:22px;font-weight:700">沉浸式翻译 · 社区回复周报</div>
      <div style="color:#9BA0AD;font-size:13px;margin-top:4px">${r.week_start} ~ ${r.week_end}${MOCK ? "（演示数据）" : ""}</div></div>
    <div style="font-size:12px;color:#9BA0AD">由社区回复平台自动生成</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:22px">
    ${kpi(r.new_posts, "本周新需求")}${kpi(r.replied, "已回复")}${kpi(r.reply_rate + "%", "回复率")}
    ${kpi(r.avg_reply_hours != null ? r.avg_reply_hours + "h" : "—", "平均响应")}${kpi(r.kol_hits + r.koc_hits, "KOL/KOC 命中")}${kpi(r.brand_neg, "品牌负面")}
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
    <div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:16px 18px">
      <div style="font-size:13px;font-weight:600;color:#5A5F6E;margin-bottom:10px">市场分布</div><table style="width:100%;border-collapse:collapse;font-size:13px">${mktRows}</table></div>
    <div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:16px 18px">
      <div style="font-size:13px;font-weight:600;color:#5A5F6E;margin-bottom:10px">平台分布</div><table style="width:100%;border-collapse:collapse;font-size:13px">${platRows}</table></div>
  </div>
  <div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:16px 18px;margin-top:20px">
    <div style="font-size:13px;font-weight:600;color:#5A5F6E;margin-bottom:10px">本周互动最高的需求帖 Top ${r.top_posts.length}</div>${tops || '<div style="color:#9BA0AD;font-size:13px">本周暂无帖子</div>'}</div>
  <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:20px;margin-top:20px">
    <div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:16px 18px">
      <div style="font-size:13px;font-weight:600;color:#5A5F6E;margin-bottom:10px">同事回复排行</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${lb || '<tr><td style="color:#9BA0AD">本周暂无回复记录</td></tr>'}</table></div>
    <div style="background:#fff;border:1px solid #E5E7EC;border-radius:12px;padding:16px 18px">
      <div style="font-size:13px;font-weight:600;color:#5A5F6E;margin-bottom:10px">KOL 命中（建联机会）</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px">${kols || '<tr><td style="color:#9BA0AD">本周暂无 KOL 命中</td></tr>'}</table>
      ${r.koc_hits ? `<div style="font-size:12px;color:#9BA0AD;margin-top:8px">另有 KOC 命中 ${r.koc_hits} 条，在需求列表点 KOC 徽章查看</div>` : ""}</div>
  </div>
  <div style="text-align:center;color:#9BA0AD;font-size:11px;margin-top:26px">— 沉浸式翻译 社区回复平台 —</div>
</div></body></html>`;
}
function downloadReport() {
  if (!rep.value) return;
  const blob = new Blob([buildHtml(rep.value)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `社区回复周报-${rep.value.week_start}.html`;
  a.click();
  URL.revokeObjectURL(url);
  toast.value = "报告已下载——发群里、存档、或浏览器打开后打印成 PDF 都行";
  setTimeout(() => (toast.value = ""), 3000);
}
function printReport() { window.print(); }
</script>

<template>
  <div class="nav">
    <span class="logo">社区回复平台</span>
    <router-link to="/">需求回复</router-link>
    <router-link to="/report" class="on">周报</router-link>
    <router-link to="/scenes">场景地图</router-link>
    <router-link to="/settings">设置</router-link>
    <span class="me"><template v-if="MOCK">演示模式</template></span>
  </div>

  <div class="rep-page">
    <div class="rep-head">
      <div>
        <h2>社区回复周报</h2>
        <div class="rep-sub" v-if="rep">{{ rep.week_start }} ~ {{ rep.week_end }}<template v-if="MOCK">（演示数据）</template></div>
      </div>
      <div class="rep-actions">
        <button v-for="[o, label] in WEEKS" :key="o" class="btn" :class="{ pri: o === weekOffset }" @click="switchWeek(o)">{{ label }}</button>
        <span class="fsep"></span>
        <button class="btn" @click="downloadReport" :disabled="!rep">下载报告</button>
        <button class="btn" @click="printReport" :disabled="!rep">打印 / 存 PDF</button>
      </div>
    </div>

    <div v-if="loading" style="color:var(--ink-3);padding:40px;text-align:center">生成中…</div>
    <div v-else-if="!rep && toast" style="color:var(--bad);padding:40px;text-align:center">{{ toast }}</div>

    <template v-else-if="rep">
      <!-- KPI -->
      <div class="kpis">
        <div class="kpi"><b>{{ rep.new_posts }}</b><span>本周新需求</span></div>
        <div class="kpi"><b>{{ rep.replied }}</b><span>已回复</span></div>
        <div class="kpi"><b>{{ rep.reply_rate }}%</b><span>回复率</span></div>
        <div class="kpi"><b>{{ rep.avg_reply_hours != null ? rep.avg_reply_hours + "h" : "—" }}</b><span>平均响应</span></div>
        <div class="kpi"><b>{{ rep.kol_hits + rep.koc_hits }}</b><span>KOL/KOC 命中</span></div>
        <div class="kpi" :class="{ bad: rep.brand_neg }"><b>{{ rep.brand_neg }}</b><span>品牌负面</span></div>
      </div>

      <!-- 市场分布 / 平台分布 -->
      <div class="rep-grid2">
        <div class="rep-card">
          <h3>市场分布</h3>
          <table class="rep-table">
            <tr v-for="m in rep.market_rows" :key="m.market">
              <td><span class="mkt" :style="{ background: (MKT[m.market] ?? {}).bg, color: (MKT[m.market] ?? {}).fg }">{{ (MKT[m.market] ?? {}).label ?? m.market }}</span></td>
              <td><div class="bar" :style="{ background: (MKT[m.market] ?? {}).bg, width: marketPct(m.total) + '%' }"></div></td>
              <td class="num">{{ m.total }} 条 · 已回 {{ m.replied }}</td>
            </tr>
          </table>
        </div>
        <div class="rep-card">
          <h3>平台分布</h3>
          <table class="rep-table">
            <tr v-for="p in rep.platform_rows" :key="p.platform">
              <td class="plat-name">{{ platName(p.platform) }}</td>
              <td><div class="bar" style="background:#E4EAF1" :style="{ width: platformPct(p.total) + '%' }"></div></td>
              <td class="num">{{ p.total }}</td>
            </tr>
            <tr v-if="!rep.platform_rows.length"><td colspan="3" style="color:var(--ink-3)">本周暂无数据</td></tr>
          </table>
        </div>
      </div>

      <!-- Top 互动帖 -->
      <div class="rep-card">
        <h3>本周互动最高的需求帖 Top {{ rep.top_posts.length }}</h3>
        <div v-for="(p, i) in rep.top_posts" :key="p.id" class="rep-post">
          <div class="meta">
            <span class="mkt" :style="{ background: (MKT[p.market] ?? {}).bg, color: (MKT[p.market] ?? {}).fg }">{{ (MKT[p.market] ?? {}).label ?? p.market }}</span>
            <span>{{ platName(p.platform) }}</span>
            <span>赞 {{ p.metrics_json?.likes ?? 0 }} · 评 {{ p.metrics_json?.comments ?? 0 }}</span>
            <span class="state" :class="p.state === 'replied' ? 'st-done' : p.state === 'skipped' ? 'st-skip' : 'st-open'">
              {{ p.state === "replied" ? "已回复" : p.state === "skipped" ? "已跳过" : "未回复" }}</span>
          </div>
          <div class="rp-sum">{{ i + 1 }}. {{ p.summary }}</div>
          <div v-if="p.quote" class="quote" :class="{ unv: !p.quote_verified }">“{{ p.quote }}”<span class="vq">{{ p.quote_verified ? "✓ 已核验" : "引句未核验" }}</span></div>
        </div>
        <div v-if="!rep.top_posts.length" style="color:var(--ink-3);font-size:13px">本周暂无帖子</div>
      </div>

      <!-- 排行 + KOL -->
      <div class="rep-grid2">
        <div class="rep-card">
          <h3>同事回复排行</h3>
          <table class="rep-table">
            <tr v-for="(m, i) in rep.leaderboard" :key="m.name">
              <td class="plat-name">{{ ["🥇", "🥈", "🥉"][i] ?? (i + 1 + ".") }} {{ m.name }}</td>
              <td class="num" style="font-weight:600">{{ m.replied }} 条</td>
            </tr>
            <tr v-if="!rep.leaderboard.length"><td colspan="2" style="color:var(--ink-3)">本周暂无回复记录</td></tr>
          </table>
        </div>
        <div class="rep-card">
          <h3>KOL 命中（建联机会）</h3>
          <table class="rep-table">
            <tr v-for="k in rep.kol_authors" :key="k.name">
              <td><span class="kol">KOL</span> {{ k.name }}</td>
              <td class="plat-name">{{ (MKT[k.market] ?? {}).label ?? k.market }} · {{ platName(k.platform) }}</td>
              <td class="num" style="font-size:12px">{{ k.summary }}</td>
            </tr>
            <tr v-if="!rep.kol_authors.length"><td colspan="3" style="color:var(--ink-3)">本周暂无 KOL 命中</td></tr>
          </table>
          <div v-if="rep.koc_hits" style="font-size:12px;color:var(--ink-3);margin-top:8px">另有 KOC 命中 {{ rep.koc_hits }} 条，在需求列表点 KOC 徽章查看</div>
        </div>
      </div>
    </template>
  </div>

  <div v-if="toast" class="toast">{{ toast }}</div>
</template>
