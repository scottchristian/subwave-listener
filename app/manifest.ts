import type { MetadataRoute } from "next";
import { STATION } from "@/lib/station";

// Served by Next at /manifest.webmanifest. Icons live in public/icons,
// generated from the logo (see README: rebrand by replacing public assets).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: STATION.name,
    short_name: STATION.name,
    description: STATION.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#06101e",
    theme_color: "#06101e",
    categories: ["music", "entertainment"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-192-maskable.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
