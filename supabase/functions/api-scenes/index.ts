// api-scenes: 场景地图 CRUD + 每场景统计
import { cors, json, requireMember, sb } from "../_shared/glue.ts";

Deno.serve(async (req) => {
  const pre = cors(req);
  if (pre) return pre;
  const member = await requireMember(req);
  if (!member) return json({ error: "未登录" }, 401);
  const client = sb();
  const url = new URL(req.url);
  const path = url.pathname.split("/").pop() ?? "";

  if (req.method === "GET") {
    const { data, error } = await client.from("demand_scenes").select("*").order("id");
    if (error) return json({ error: error.message }, 500);
    // 每场景 30 天量 / 回复率
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: counts } = await client.from("demand_posts")
      .select("demand_id, state").gte("published_at", since).not("demand_id", "is", null);
    const stat = new Map<string, { posts: number; replied: number }>();
    for (const row of counts ?? []) {
      const s = stat.get(row.demand_id) ?? { posts: 0, replied: 0 };
      s.posts++; if (row.state === "replied") s.replied++;
      stat.set(row.demand_id, s);
    }
    return json({
      scenes: (data ?? []).map((s) => ({
        ...s,
        posts_30d: stat.get(s.id)?.posts ?? 0,
        replied_rate: stat.get(s.id) ? +(stat.get(s.id)!.replied / stat.get(s.id)!.posts).toFixed(2) : 0,
      })),
    });
  }

  if (req.method === "POST" && member.role !== "admin" && member.role !== "member") {
    return json({ error: "无权限" }, 403);
  }
  const body = await req.json().catch(() => ({}));

  if (req.method === "POST" && path === "create") {
    if (!/^D\d{2}$/.test(body.id ?? "")) return json({ error: "编号须为 D## 格式" }, 400);
    const { data, error } = await client.from("demand_scenes").insert({
      id: body.id, name: body.name, definition: body.definition,
      capability: body.capability ?? [], feature: body.feature ?? body.name,
      status: body.status ?? "active", confirmed_by: member.name, updated_by: member.name,
    }).select("*").single();
    if (error) return json({ error: error.message }, 400);
    return json({ scene: data });
  }

  if (req.method === "POST" && path === "update") {
    const { data, error } = await client.from("demand_scenes").update({
      name: body.name, definition: body.definition, capability: body.capability,
      feature: body.feature, status: body.status, updated_by: member.name, updated_at: new Date().toISOString(),
    }).eq("id", body.id).select("*").single();
    if (error) return json({ error: error.message }, 400);
    return json({ scene: data });
  }

  if (req.method === "POST" && path === "confirm") {
    // 候选场景转正 (v2 候选场景提议的人工确认入口)
    const { data, error } = await client.from("demand_scenes")
      .update({ status: "active", confirmed_by: member.name, updated_by: member.name })
      .eq("id", body.id).select("*").single();
    if (error) return json({ error: error.message }, 400);
    return json({ scene: data });
  }

  return json({ error: "not found" }, 404);
});
