import { APP_FORMAL_NAME, APP_PRODUCT_NAME } from "./appMetadata";

export function buildOrderRequestText(items: any[], siteName: string, lossRatePercent: number): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("ja-JP", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });

  let text = `作成型：${APP_FORMAL_NAME}（${APP_PRODUCT_NAME}）\n`;
  text += `現場名：${siteName.trim() || "未入力"}\n`;
  text += `日時：${dateStr}\n\n`;
  text += `【発注リスト】\n`;

  for (const item of items) {
    // 数量の丸め処理などは既存のフォーマット通り
    text += `・品番：${item.product_code} / 数量：${item.order_quantity}m\n`;
  }

  return text.trim();
}
