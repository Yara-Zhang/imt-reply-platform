// health-digest: 每日 10:00 品牌告警清旗 + Supabase 保活
// 周报/日报改为平台内「周报」页实时生成 (想看的人点进去看和下载), 飞书推送已按用户决定移除
// 冷却扫描已移除 (v4: 所有帖子全量展示, 不再自动标冷却/归零优先级); stale 字段仅作数据标记
// 触发: pg_cron 每日 10:00 (DEPLOY.md 配置); 也可手动调用
import { json, sb } from "../_shared/glue.ts";

Deno.serve(async (_req) => {
  const client = sb();

  // ---------- 1. 品牌帖告警清旗 (发完清 flag, v1 制度; 汇总在平台周报页看) ----------
  const { data: alarms } = await client.from("brand_posts").select("id").eq("alarm_flag", true).limit(20);
  if (alarms?.length) {
    await client.from("brand_posts").update({ alarm_flag: false }).eq("alarm_flag", true);
  }

  // ---------- 2. 保活 (Supabase 免费版防暂停, v1 经验) ----------
  await client.from("app_config").update({ updated_at: new Date().toISOString() }).eq("key", "budget");

  return json({ ok: true, alarm_count: alarms?.length ?? 0 });
});
