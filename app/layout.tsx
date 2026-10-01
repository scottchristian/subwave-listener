import type { Metadata, Viewport } from "next";
import "./globals.css";
import { STATION } from "@/lib/station";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: STATION.name,
  description: STATION.description,
  applicationName: STATION.name,
  icons: {
      // Stable brand URLs, not paths into public/. Each resolves to the
      // station's own icon if it uploaded one and to the shipped placeholder
      // if not, so rebranding needs no rebuild and no edit here.
      // See lib/brandpaths.ts.
    icon: [
      { url: "/brand/icons/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/brand/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/brand/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  appleWebApp: {
    capable: true,
    title: STATION.name,
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#06101e",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
