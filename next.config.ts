import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
