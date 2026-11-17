import { createRouter, createWebHashHistory } from "vue-router";
import { hasToken } from "./lib/api.js";
import DemandView from "./views/DemandView.vue";
import LoginView from "./views/LoginView.vue";
import ScenesView from "./views/ScenesView.vue";
import SettingsView from "./views/SettingsView.vue";
import ReportView from "./views/ReportView.vue";

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/login", component: LoginView },
    { path: "/", component: DemandView },
    { path: "/report", component: ReportView },
    { path: "/scenes", component: ScenesView },
    { path: "/settings", component: SettingsView },
    { path: "/:x(.*)", redirect: "/" },
  ],
});

// 登录守卫
router.beforeEach((to) => {
  if (to.path !== "/login" && !hasToken()) return "/login";
  return true;
});

export default router;
