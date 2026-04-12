import { Noto_Sans_JP } from "next/font/google";

import { APP_METADATA } from "@/lib/appMetadata";

import "./globals.css";

const notoSansJp = Noto_Sans_JP({ subsets: ["latin"], display: "swap" });

export const metadata = APP_METADATA;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body className={`${notoSansJp.className} min-h-screen bg-background antialiased`}>{children}</body>
    </html>
  );
}
