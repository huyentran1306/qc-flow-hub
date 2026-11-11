import { demoHtml } from "@/lib/demoApp";

export const dynamic = "force-dynamic";

/** Sample app for the demo project's automatic runs (see src/lib/demoApp.ts). */
export function GET() {
  return new Response(demoHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
