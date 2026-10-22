import type { NextConfig } from "next";
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
const nextConfig: NextConfig = {
  reactCompiler: true,
  output: "export",
  trailingSlash: true,
  ...(basePath ? { basePath, assetPrefix: `${basePath}/` } : {}),
  images: { unoptimized: true },
  allowedDevOrigins: ["localhost", "127.0.0.1", "*.mathnasium.pro"],
};
export default nextConfig;
