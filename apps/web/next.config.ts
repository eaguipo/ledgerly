import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit a self-contained `.next/standalone` bundle (server.js + only the
  // node_modules actually traced) so the Docker runtime image stays tiny and
  // does not need `npm install`. See node_modules/next/dist/docs/.../output.md.
  output: "standalone",
};

export default nextConfig;
