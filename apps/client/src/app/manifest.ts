import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
const iconPath = basePath ? `${basePath}/icon.svg` : "/icon.svg";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "vibe",
    short_name: "vibe",
    description: "Synchronized listening on your local network.",
    start_url: basePath ? `${basePath}/` : "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [
      {
        src: iconPath,
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
