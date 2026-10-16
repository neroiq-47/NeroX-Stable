import type { Metadata, Viewport } from "next";
import { Space_Grotesk, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { BetaBanner, ComplianceGate, Footer, Header, TxTray } from "@/components/shell";

const display = Space_Grotesk({ subsets: ["latin"], weight: ["600"], variable: "--font-space-grotesk" });
const text = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
  title: "NeroX",
  description: "Stable money for the machine economy. Mint NRX, earn with sNRX, borrow, bridge, and pay agents over x402.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

const themeScript = `try{var t=localStorage.getItem("nerox.theme");if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>
          <div className="shell">
            <BetaBanner />
            <Header />
            <main className="container">{children}</main>
            <Footer />
          </div>
          <ComplianceGate />
          <TxTray />
        </Providers>
      </body>
    </html>
  );
}
