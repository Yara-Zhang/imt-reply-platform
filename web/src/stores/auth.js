// 会话 store — 成员信息 + 登录态
import { defineStore } from "pinia";
import { api, setToken, hasToken, MOCK } from "../lib/api.js";

export const useAuth = defineStore("auth", {
  state: () => ({
    member: JSON.parse(localStorage.getItem("imt_member") ?? "null"),
    mock: MOCK,
  }),
  getters: {
    loggedIn: () => hasToken(),
  },
  actions: {
    async loginPassword(email, password, name) {
      const j = await api("/auth/password", { method: "POST", body: { email, password, name } });
      if (this.mock) {
        // Mock 模式: 本地签发伪 token + 成员
        setToken("mock-token");
        const m = { id: "mock", name: name || email.split("@")[0] || "张三", role: "admin", duties: ["ja_review", "kr_review"] };
        localStorage.setItem("imt_member", JSON.stringify(m));
        this.member = m;
        return m;
      }
      setToken(j.token);
      localStorage.setItem("imt_member", JSON.stringify(j.member));
      this.member = j.member;
      return j.member;
    },
    logout() {
      setToken("");
      localStorage.removeItem("imt_member");
      this.member = null;
    },
  },
});
