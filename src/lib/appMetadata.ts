import type { Metadata } from "next";

import { DEFAULT_LOSS_RATE_PERCENT } from "@/lib/calc-logic";

/** プロダクトの短い呼び名（ロゴ横など） */
export const APP_PRODUCT_NAME = "ソクパ";

/** アプリの正式名称 */
export const APP_FORMAL_NAME = "計測メモ解析アプリ";

/** ヘッダー正式名の右に表示するクレジット */
export const APP_HEADER_CREDIT = "";

/** ブラウザタイトル用 */
export const APP_BROWSER_TITLE = `${APP_PRODUCT_NAME} | ${APP_FORMAL_NAME}`;

export const APP_DESCRIPTION = `計測メモ画像から品番・数量・計算式を読み取り、メーカー別に整理します。発注数量は実測に${DEFAULT_LOSS_RATE_PERCENT}%のロスを加えて切り上げます（※ロス率変更可能）。`;

export const APP_METADATA: Metadata = {
  title: APP_BROWSER_TITLE,
  description: APP_DESCRIPTION,
  applicationName: APP_PRODUCT_NAME,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: APP_PRODUCT_NAME,
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/favicon.ico", type: "image/x-icon" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};
