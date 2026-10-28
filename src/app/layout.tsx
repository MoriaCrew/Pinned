import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pinneds — one link, one game, hosted by an AI",
  description:
    "Describe a host in one line, drop the link in your group chat, and play an async photo game. Nothing to install.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
