import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained `.next/standalone` bundle (server.js + only the
  // node_modules actually traced) so the Docker runtime image stays tiny and
  // does not need `npm install`. See node_modules/next/dist/docs/.../output.md.
  output: "standalone",

  // Development-only logging (ignored in production builds).
  // See node_modules/next/dist/docs/.../next-config-js/logging.md.
  logging: {
    // Print the full URL of every server-side fetch — i.e. every gatewayFetch
    // call, so the api-gateway path being hit is visible without adding a log.
    fetches: { fullUrl: true },
    // Forward browser console.warn/error into the `next dev` terminal, which is
    // where the error-boundary records from @/lib/client-logger surface.
    browserToTerminal: "warn",
  },
};

export default nextConfig;
