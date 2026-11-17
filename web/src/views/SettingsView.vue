<script setup>
import { ref } from "vue";
import { MOCK } from "../lib/api.js";

const stage = ref({ jp: 0, kr: 0 });
const budget = ref(3);
const saved = ref(false);

function save() {
  // P0: 设置写回由真实后端提供; Mock 模式仅本地演示
  saved.value = true;
  setTimeout(() => (saved.value = false), 2000);
}
</script>

<template>
  <div class="nav">
    <span class="logo">社区回复平台</span>
    <router-link to="/">需求回复</router-link><router-link to="/report">周报</router-link><router-link to="/scenes">场景地图</router-link><router-link to="/settings" class="on">设置</router-link>
  </div>
  <div class="form" style="margin-top:20px">
    <h2>设置</h2>
    <label style="display:block;font-size:13px;color:var(--ink-2);margin-bottom:6px">日本市场运营阶段</label>
    <select v-model.number="stage.jp" style="width:100%;margin-bottom:12px">
      <option :value="0">阶段 0 · 只监测（不生成回复草稿）</option>
      <option :value="1">阶段 1 · 出卡与出稿</option>
      <option :value="2">阶段 2 · 完整运营</option>
    </select>
    <label style="display:block;font-size:13px;color:var(--ink-2);margin-bottom:6px">韩国市场运营阶段</label>
    <select v-model.number="stage.kr" style="width:100%;margin-bottom:12px">
      <option :value="0">阶段 0 · 只监测（不生成回复草稿）</option>
      <option :value="1">阶段 1 · 出卡与出稿</option>
      <option :value="2">阶段 2 · 完整运营</option>
    </select>
    <label style="display:block;font-size:13px;color:var(--ink-2);margin-bottom:6px">TikHub 每日预算（美元）</label>
    <input v-model.number="budget" type="number" min="1" max="10" />
    <p class="hint">
      品牌检查规则（禁用词/产品名/日韩绝对化用语）在数据库 app_config.brand_rules 中维护；
      市场阶段控制日韩帖的 AI 起草开关——阶段 0 时点「认领并起草」会被拦截并提示。
      <template v-if="MOCK"><br />当前为演示模式，设置仅作界面演示，不写回后端。</template>
    </p>
    <button class="btn pri" @click="save">保存设置</button>
    <span v-if="saved" style="margin-left:10px;color:var(--ok);font-size:13px">已保存</span>
  </div>
</template>
