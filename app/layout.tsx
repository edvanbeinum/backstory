import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "differ — review before you push",
  description:
    "Local pre-push review: unpushed commits and their PR review comments, side by side.",
  // Safari takes its icon from apple-touch-icon instead of these. The SVG is
  // listed first for browsers that take it — it stays
  // sharp at any tab size — with the PNGs behind it for those that don't, and
  // app/favicon.ico (16/32/64) as the last resort.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "differ",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
