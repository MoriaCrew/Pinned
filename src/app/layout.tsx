import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pinneds — one link, one game, hosted by an AI",
  description:
    "Describe a host in one line, drop the link in your group chat, and play an async photo game. Nothing to install.",
};

// Mobile-first (docs/08): without this, phones lay out at 980px.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
