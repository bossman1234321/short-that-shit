import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Short That Shit — D/E + Revenue Decline Screener",
  description:
    "Screens the S&P 500 for companies with above-average debt-to-equity AND two consecutive years of declining revenue.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preconnect"
          href="https://fonts.googleapis.com"
          crossOrigin=""
        />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-terminal-bg text-terminal-fg antialiased">
        {children}
      </body>
    </html>
  );
}
