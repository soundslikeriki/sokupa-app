export function buildOrderRequestText(items: any[], siteName: string | null | undefined): string {
  const now = new Date();
  const dateStr = now.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let text = "";
  text += `現場名：${siteName?.trim() || "未入力"}\n`;
  text += `日時：${dateStr}\n\n`;
  text += `【発注リスト】\n`;

  if (items.length === 0) {
    text += "（品番なし）\n";
  } else {
    for (const item of items) {
      const code = String(item?.product_code ?? "").trim() || "不明";
      const orderQty = Number(item?.order_quantity);
      const totalM = Number(item?.total_m);
      const qtyStr =
        Number.isFinite(orderQty) && orderQty > 0
          ? `${orderQty}m`
          : Number.isFinite(totalM) && totalM > 0
            ? `${totalM}m`
            : "数量不明";
      text += `・品番：${code} / 数量：${qtyStr}\n`;
    }
  }

  return text.trim();
}
