/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["sql.js"],
    outputFileTracingIncludes: {
      "/api/backups/sprout/**/*": ["./node_modules/sql.js/dist/sql-wasm.wasm"]
    }
  },
  // The family feed is called Moments, since "Feed" means feeding the baby; links saved under its
  // old address still arrive. Temporary, so browsers don't keep it for good. Query strings carry over.
  async redirects() {
    return [
      { source: "/app/feed", destination: "/app/moments", permanent: false },
      { source: "/app/feed/:path*", destination: "/app/moments/:path*", permanent: false }
    ];
  }
};

export default nextConfig;
