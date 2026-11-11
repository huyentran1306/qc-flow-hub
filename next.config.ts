import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Internal tool: every page reads the session and the database, so we use
  // the request-time rendering model instead of Cache Components.
  cacheComponents: false,
  serverExternalPackages: ["@electric-sql/pglite", "playwright-core"],
  // Evidence (screenshots, short videos) is uploaded through server actions; storage allows 25 MB per file.
  experimental: { serverActions: { bodySizeLimit: "60mb" } },
  // Self-contained server for the double-click package (scripts/package.mjs).
  output: "standalone",
  // The packaging script builds into its own folder so it never disturbs a running `next dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The tracer misses the route-handler runtime (app-route-turbo); ship all production runtimes.
  outputFileTracingIncludes: { "/**/*": ["./node_modules/next/dist/compiled/next-server/*.prod.js"] },
  outputFileTracingExcludes: { "/**/*": ["./.data/**/*", "./dist/**/*", "./.env*"] },
};

export default nextConfig;
