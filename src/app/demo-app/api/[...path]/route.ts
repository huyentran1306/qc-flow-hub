import { handleDemoApi } from "@/lib/demoApp";

export const dynamic = "force-dynamic";

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const r = handleDemoApi(req.method, path, new URL(req.url).searchParams);
  return r.status === 204 ? new Response(null, { status: 204 }) : Response.json(r.body, { status: r.status });
}

export { handle as GET, handle as POST, handle as DELETE };
