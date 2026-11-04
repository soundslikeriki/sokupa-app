import { Noto_Sans_JP } from "next/font/google";

import { APP_METADATA } from "@/lib/appMetadata";

import "./globals.css";

const notoSansJp = Noto_Sans_JP({ subsets: ["latin"], display: "swap" });

export function generateMetadata() {
  return process.env.SOKUPA_QA_MODE || process.env.SOKUPA_QA_BINDING
    ? { ...APP_METADATA, title: "ソクパQA | 合成試験", applicationName: "ソクパQA", manifest: "/qa-manifest.webmanifest", appleWebApp: { capable:true, title:"ソクパQA", statusBarStyle:"default" as const } }
    : APP_METADATA;
}

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
