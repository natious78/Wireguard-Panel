import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRuntime } from "@/components/pwa";

export const metadata: Metadata = {
  title: { default: "WireGuard Control", template: "%s · WireGuard Control" },
  description: "Self-hosted MikroTik WireGuard operations console",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "WG Control", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/icon-192.png" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light dark", themeColor: "#0f766e" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning><body><a href="#main-content" className="skip-link">Skip to content</a>{children}<PwaRuntime /></body></html>;
}
