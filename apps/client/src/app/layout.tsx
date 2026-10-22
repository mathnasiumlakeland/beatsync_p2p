import TQProvider from "@/components/TQProvider";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import localFont from "next/font/local";
import type { Metadata } from "next";
import "./globals.css";

const inter = localFont({ src: "./fonts/Inter.woff2", variable: "--font-inter", weight: "100 900", display: "swap" });
const geistSans = localFont({
  src: "./fonts/Geist.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});
const geistMono = localFont({
  src: "./fonts/GeistMono.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "vibe",
  description: "Listen together on your local network. One room, synchronized audio, and no accounts.",
  keywords: ["music", "sync", "audio", "collaboration", "real-time"],
  authors: [{ name: "Freeman Jiang" }],
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "vibe",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body
        className={cn(
          inter.variable,
          geistSans.variable,
          geistMono.variable,
          "antialiased font-sans selection:bg-primary-800 selection:text-white"
        )}
      >
        <TQProvider>
          {children}
          <Toaster />
        </TQProvider>
      </body>
    </html>
  );
}
