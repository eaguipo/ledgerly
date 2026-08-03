import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Ledgerly — personal finance, clearly",
    template: "%s · Ledgerly",
  },
  description:
    "Track accounts, expenses, transfers, debts, goals and investments across every currency you hold, with what you can actually spend on one screen.",
  applicationName: "Ledgerly",
  openGraph: {
    title: "Ledgerly — personal finance, clearly",
    description:
      "Track accounts, expenses, transfers and goals across every currency you hold.",
    siteName: "Ledgerly",
    type: "website",
  },
};

export const viewport: Viewport = {
  // A single colour, NOT one per prefers-color-scheme: the theme here is
  // class-driven and user-overridable, so media-keyed values would leave the
  // mobile browser chrome inverted whenever the toggle disagrees with the OS.
  // The inline script below rewrites this tag to match the theme it applies.
  themeColor: "#0e1311",
};

/*
 * Runs synchronously while the browser parses <head>, so the correct theme is
 * on <html> before first paint — no flash of the wrong theme on reload. React
 * would otherwise only learn the stored preference after hydration.
 * See: node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md
 */
const themeScript = `(function(){try{var t=localStorage.getItem("ledgerly-theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}document.documentElement.classList.toggle("dark",t==="dark");var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute("content",t==="dark"?"#0e1311":"#f6f4ef")}}catch(e){document.documentElement.classList.add("dark")}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The theme script mutates this element's class list before hydration.
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="flex min-h-full flex-col bg-canvas text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-accent-ink"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
