import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dude-E — Tariff Classification",
  description:
    "HTSUS classification workbench: GRI analysis, candidate review, and exportable determinations.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#131311" },
  ],
};

/**
 * Applied before first paint so a stored theme choice does not flash the
 * wrong palette. Kept deliberately tiny and failure-tolerant — if
 * localStorage is unavailable we simply fall through to the OS preference.
 */
const THEME_BOOTSTRAP = `
try {
  var stored = localStorage.getItem('dude-e-theme');
  if (stored === 'light' || stored === 'dark') {
    document.documentElement.setAttribute('data-theme', stored);
  }
} catch (e) {}
`.trim();

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
