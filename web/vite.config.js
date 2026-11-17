import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "./", // GitHub Pages 子路径部署: 资源用相对路径, 避免 /assets 404 白屏
  server: { port: 5175 },
});
