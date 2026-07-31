import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next blocks cross-origin dev resources by default, which breaks the HMR
  // websocket — and therefore hydration — when the app is opened on
  // 127.0.0.1 rather than localhost. Dev only; has no effect on a build.
  allowedDevOrigins: ["127.0.0.1", "localhost"],

  // Native / heavy Node-only modules must not be bundled into the server chunks.
  // better-sqlite3 is a native addon; @react-pdf/renderer pulls in fontkit and
  // friends that break under the bundler.
  serverExternalPackages: [
    "better-sqlite3",
    "@react-pdf/renderer",
    "@prisma/client",
  ],
};

export default nextConfig;
