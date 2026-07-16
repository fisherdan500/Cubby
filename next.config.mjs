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
  }
};

export default nextConfig;
