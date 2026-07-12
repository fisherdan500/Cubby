import type { Metadata, Viewport } from "next";
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@/styles/globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { ThemeProvider } from "@/components/theme-provider";

export const metadata: Metadata = {
  title: "Cubby",
  description: "Track the little things.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { url: "/icons/favicon-32.png", type: "image/png", sizes: "32x32" }
    ],
    shortcut: "/icons/favicon-32.png",
    apple: [{ url: "/icons/apple-touch-icon.png", type: "image/png", sizes: "180x180" }]
  },
  appleWebApp: {
    capable: true,
    title: "Cubby",
    statusBarStyle: "default"
  }
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f6f0" },
    { media: "(prefers-color-scheme: dark)", color: "#201c1a" }
  ],
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <PwaRegister />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
