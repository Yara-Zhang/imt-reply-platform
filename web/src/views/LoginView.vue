<script setup>
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../stores/auth.js";
import { MOCK } from "../lib/api.js";

const router = useRouter();
const auth = useAuth();
const email = ref(""), password = ref(""), name = ref("");
const err = ref(""), loading = ref(false);

async function login() {
  err.value = ""; loading.value = true;
  try {
    await auth.loginPassword(email.value, password.value, name.value);
    router.push("/");
  } catch (e) {
    err.value = e.message;
  } finally { loading.value = false; }
}
</script>

<template>
  <div class="form">
    <h2>社区回复平台{{ MOCK ? "（演示模式）" : "" }}</h2>
    <p v-if="MOCK" class="hint" style="margin-bottom:12px">演示模式无需真实后端，任意邮箱密码即可进入。</p>
    <input v-model="email" type="email" placeholder="邮箱" @keyup.enter="login" />
    <input v-model="password" type="password" placeholder="密码" @keyup.enter="login" />
    <input v-model="name" placeholder="昵称（注册时填）" />
    <button class="btn pri" style="width:100%" :disabled="loading" @click="login">{{ loading ? "登录中…" : "登录 / 注册" }}</button>
    <p v-if="err" class="hint" style="color:var(--bad)">{{ err }}</p>
    <p class="hint">飞书扫码登录配置后自动启用；输入未注册的邮箱即自动注册，第一个注册的账号自动成为管理员。</p>
  </div>
</template>
