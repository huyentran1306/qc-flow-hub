import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/rbac";
import { roleIn } from "@/lib/services/projects";
import { storyByKey } from "@/lib/services/stories";
import { toTestlinkXml } from "@/lib/testlinkXml";

export async function GET(_req: Request, ctx: RouteContext<"/stories/[key]/testlink.xml">) {
  const { key } = await ctx.params;
  const user = await currentUser();
  if (!user) return new Response("Chưa đăng nhập", { status: 401 });
  const db = await getDb();
  const data = await storyByKey(db, key);
  if (!data) return new Response("Không tìm thấy story", { status: 404 });
  const role = await roleIn(db, user.id, data.project.id);
  if (!can({ isAdmin: user.isAdmin, role }, "story.view")) return new Response("Không có quyền", { status: 403 });
  const approved = data.testCases.filter((t) => t.status === "approved");
  const xml = toTestlinkXml(`${data.story.jiraKey} ${data.story.summary}`, approved);
  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Content-Disposition": `attachment; filename="${data.story.jiraKey}.testlink.xml"`,
    },
  });
}
