import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "differ — review before you push",
  description:
    "Local pre-push review: unpushed commits and their PR review comments, side by side.",
  // Safari's "Add to Dock" takes its icon from apple-touch-icon, not the
  // manifest; the OS rounds the corners itself, so that file ships square.
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
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
